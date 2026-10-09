import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../web/admin/app.js', import.meta.url), 'utf8');

// Exercise the shipped locator and its request lifecycle without introducing a
// browser dependency. Other administration sections remain outside this fixture.
function locator(responses = []) {
  const elements = {};
  const names = [...source.matchAll(/elements\.(locate[A-Za-z]+)/g)].map((match) => match[1]);
  for (const name of names) elements[name] = {
    textContent: '', value: '', hidden: true, disabled: false, dataset: {},
    setCustomValidity(value) { this.validationMessage = value; },
    reportValidity() { return !elements.locateX.validationMessage && !elements.locateZ.validationMessage; },
  };
  elements.locateStructure.value = 'mansion';
  elements.locateOriginDimension.value = 'minecraft:overworld';
  elements.locateX.valueAsNumber = 0;
  elements.locateZ.valueAsNumber = 0;
  const state = {
    user: { name: 'admin' }, csrfToken: 'test-token', locateVersion: 0,
    locateBusy: false, locateResult: null, locatePending: null,
  };
  const requests = [];
  const context = {
    state, elements,
    APIError: class extends Error { constructor(message, status = 0) { super(message); this.status = status; } },
    syncControls() {},
    formatUpdatedAt: (value) => value || null,
    request(path, options) {
      requests.push({ path, options });
      const response = responses.shift();
      if (response instanceof Error) return Promise.reject(response);
      return Promise.resolve(response);
    },
    handleError(error) {
      assert.equal(error.status, 401);
      resetSession();
    },
  };
  function resetSession() {
    state.user = null;
    state.csrfToken = '';
    state.locateBusy = false;
    state.locatePending = null;
    context.clearLocateResult();
  }
  const sections = [
    ['  const structureDefinitions', '  const tabNames'],
    ['  function message(', '  function snapshotTime('],
    ['  function clearLocateResult(', '  function selectTab('],
    ['  function writeOptions(', '  async function removePlayer('],
  ].map(([start, end]) => {
    const from = source.indexOf(start);
    const until = source.indexOf(end, from);
    assert.ok(from >= 0 && until > from);
    return source.slice(from, until);
  }).join('\n');
  vm.runInNewContext(sections, context);
  return { ...context, responses, requests, resetSession };
}

function result(overrides = {}) {
  return { result: {
    structure: 'mansion', dimension: 'minecraft:overworld', x: 300, z: -400,
    origin: { dimension: 'minecraft:overworld', x: 0, z: 0 },
    searchOrigin: { dimension: 'minecraft:overworld', x: 0, z: 0 },
    ...overrides,
  }, updatedAt: '2026-10-07T04:00:00Z' };
}

function deferred() {
  let resolve;
  const promise = new Promise((callback) => { resolve = callback; });
  return { promise, resolve };
}

test('an explicit lookup sends its origin and CSRF token, then renders distance and unknown height', async () => {
  const page = locator([result()]);
  assert.equal(page.requests.length, 0);
  await page.locateStructure();
  const { path, options } = page.requests[0];
  assert.equal(path, '/api/locate');
  assert.equal(options.method, 'POST');
  assert.equal(options.headers['X-CSRF-Token'], 'test-token');
  assert.deepEqual(JSON.parse(options.body), { structure: 'mansion', originDimension: 'minecraft:overworld', x: 0, z: 0 });
  assert.equal(page.elements.locateResultDistance.textContent, '约 500 格');
  assert.equal(page.elements.locateResultBearing.textContent, '东北');
  assert.equal(page.elements.locateResultYRow.hidden, true);
  assert.equal(page.elements.locateHeightNote.hidden, false);
  assert.equal(page.elements.locateResult.hidden, false);
  assert.equal(page.state.locateBusy, false);
});

test('all eight bearings follow Minecraft axes, including a target at the origin', () => {
  const page = locator();
  for (const [x, z, direction] of [[0, -1, '北'], [1, -1, '东北'], [1, 0, '东'], [1, 1, '东南'],
    [0, 1, '南'], [-1, 1, '西南'], [-1, 0, '西'], [-1, -1, '西北'], [0, 0, '就在起点']]) {
    assert.equal(page.horizontalBearing(x, z), direction);
  }
});

test('lookup refuses invalid origin coordinates and unauthenticated requests', async () => {
  const page = locator();
  for (const field of ['locateX', 'locateZ']) {
    for (const value of [NaN, 1.5, 29999985, -29999985]) {
      page.elements[field].valueAsNumber = value;
      await page.locateStructure();
      assert.equal(page.requests.length, 0);
    }
    page.elements[field].valueAsNumber = 0;
  }
  page.state.user = null;
  await page.locateStructure();
  assert.equal(page.requests.length, 0);
});

test('input allows the search-origin boundary and result accepts the server world boundary', async () => {
  const origin = { dimension: 'minecraft:overworld', x: 29999984, z: -29999984 };
  const page = locator([result({ x: 30000000, z: -30000000, origin, searchOrigin: origin })]);
  page.elements.locateX.valueAsNumber = 29999984;
  page.elements.locateZ.valueAsNumber = -29999984;
  await page.locateStructure();
  assert.equal(page.requests.length, 1);
  assert.equal(page.elements.locateResult.hidden, false);
  assert.equal(page.elements.locateResultX.textContent, '30000000');
  assert.match(page.elements.locateResultOrigin.textContent, /29999984/);
});

test('changing input invalidates pending coordinates and does not start another lookup', async () => {
  const pending = deferred();
  const page = locator([pending.promise]);
  const lookup = page.locateStructure();
  assert.equal(page.state.locateBusy, true);
  await page.locateStructure();
  assert.equal(page.requests.length, 1);
  page.elements.locateX.valueAsNumber = 100;
  page.clearLocateResult();
  pending.resolve(result());
  await lookup;
  assert.equal(page.requests.length, 1);
  assert.equal(page.state.locateBusy, false);
  assert.equal(page.state.locateResult, null);
  assert.equal(page.elements.locateResult.hidden, true);
});

test('a response from a prior session cannot replace results or unlock a new request', async () => {
  const oldResponse = deferred();
  const newResponse = deferred();
  const page = locator([oldResponse.promise, newResponse.promise]);
  const oldLookup = page.locateStructure();
  page.resetSession();
  page.state.user = { name: 'new-admin' };
  page.state.csrfToken = 'new-token';
  const newLookup = page.locateStructure();
  oldResponse.resolve(result());
  await oldLookup;
  assert.equal(page.state.locateBusy, true);
  assert.equal(page.state.locateResult, null);
  newResponse.resolve(result({ x: 600 }));
  await newLookup;
  assert.equal(page.state.locateBusy, false);
  assert.equal(page.elements.locateResultX.textContent, '600');
});

test('server errors are shown without retrying, and expired authentication clears the result', async () => {
  const page = locator();
  for (const status of [404, 429, 502]) {
    const error = new page.APIError(`查询错误 ${status}`, status);
    page.responses.push(error);
    const before = page.requests.length;
    await page.locateStructure();
    assert.equal(page.requests.length, before + 1);
    assert.equal(page.elements.locateMessage.textContent, error.message);
    assert.equal(page.state.locateBusy, false);
    assert.equal(page.state.locateResult, null);
  }
  page.responses.push(new page.APIError('network failed'));
  await page.locateStructure();
  assert.match(page.elements.locateMessage.textContent, /服务器可能仍在搜索/);
  page.responses.push(new page.APIError('登录已失效', 401));
  await page.locateStructure();
  assert.equal(page.state.user, null);
  assert.equal(page.state.locateBusy, false);
  assert.equal(page.elements.locateResult.hidden, true);
});

test('unexpected structures, dimensions and malformed coordinates do not become results', async () => {
  const page = locator();
  for (const invalid of [{ structure: 'village' }, { dimension: 'minecraft:the_end' }, { x: 1.5 }, { z: 30000001 }, { y: '64' }]) {
    page.responses.push(result(invalid));
    await page.locateStructure();
    assert.equal(page.state.locateResult, null);
    assert.match(page.elements.locateMessage.textContent, /不完整/);
  }
});

test('a selected dimension uses its own coordinates and optional height is rendered only when supplied', async () => {
  const origin = { dimension: 'minecraft:the_nether', x: 10, z: 20 };
  const page = locator([result({ structure: 'fortress', dimension: 'minecraft:the_nether', x: 10, z: 20, y: 64, origin, searchOrigin: origin })]);
  page.elements.locateStructure.value = 'fortress';
  page.elements.locateOriginDimension.value = 'minecraft:the_nether';
  page.elements.locateX.valueAsNumber = 10;
  page.elements.locateZ.valueAsNumber = 20;
  page.clearLocateResult();
  assert.match(page.elements.locateDimensionNote.textContent, /下界/);
  await page.locateStructure();
  assert.deepEqual(JSON.parse(page.requests[0].options.body), { structure: 'fortress', originDimension: 'minecraft:the_nether', x: 10, z: 20 });
  assert.equal(page.elements.locateResultDimension.textContent, '下界');
  assert.equal(page.elements.locateResultBearing.textContent, '就在起点');
  assert.equal(page.elements.locateResultYRow.hidden, false);
  assert.equal(page.elements.locateResultY.textContent, '64');
  assert.equal(page.elements.locateHeightNote.hidden, true);
  assert.equal(page.elements.locateResultSearchOrigin.hidden, true);
});

test('overworld to nether conversion floors negative coordinates and measures in the target dimension', async () => {
  const origin = { dimension: 'minecraft:overworld', x: -1, z: -9 };
  const searchOrigin = { dimension: 'minecraft:the_nether', x: -1, z: -2 };
  const page = locator([result({ structure: 'fortress', dimension: 'minecraft:the_nether', x: 2, z: -6, origin, searchOrigin })]);
  page.elements.locateStructure.value = 'fortress';
  page.elements.locateX.valueAsNumber = origin.x;
  page.elements.locateZ.valueAsNumber = origin.z;
  page.clearLocateResult();
  assert.equal(page.requests.length, 0);
  assert.match(page.elements.locateConversionNote.textContent, /下界 · X -1 \/ Z -2/);
  assert.match(page.elements.locateConversionNote.textContent, /向下取整/);
  await page.locateStructure();
  assert.deepEqual(JSON.parse(page.requests[0].options.body), { structure: 'fortress', originDimension: origin.dimension, x: -1, z: -9 });
  assert.match(page.elements.locateResultOrigin.textContent, /主世界 · X -1 \/ Z -9/);
  assert.match(page.elements.locateResultSearchOrigin.textContent, /下界 · X -1 \/ Z -2/);
  assert.equal(page.elements.locateResultSearchOrigin.hidden, false);
  assert.equal(page.elements.locateResultDistance.textContent, '约 5 格');
  assert.equal(page.elements.locateResultBearing.textContent, '东北');
  assert.equal(page.elements.locateResultDistanceLabel.textContent, '下界水平距离');
  assert.equal(page.elements.locateResultBearingLabel.textContent, '下界方向');
  assert.equal(page.formatLocateCoordinates(page.state.locateResult), '下界 · X: 2, Z: -6');
});

test('nether to overworld scales the search origin by eight without rewriting entered coordinates', async () => {
  const origin = { dimension: 'minecraft:the_nether', x: -10, z: 20 };
  const searchOrigin = { dimension: 'minecraft:overworld', x: -80, z: 160 };
  const page = locator([result({ x: -80, z: 150, origin, searchOrigin })]);
  page.elements.locateOriginDimension.value = origin.dimension;
  page.elements.locateX.valueAsNumber = origin.x;
  page.elements.locateZ.valueAsNumber = origin.z;
  page.clearLocateResult();
  assert.match(page.elements.locateConversionNote.textContent, /主世界 · X -80 \/ Z 160/);
  assert.match(page.elements.locateConversionNote.textContent, /× 8/);
  assert.equal(page.elements.locateX.valueAsNumber, -10);
  await page.locateStructure();
  assert.equal(page.elements.locateResultDistance.textContent, '约 10 格');
  assert.equal(page.elements.locateResultBearing.textContent, '北');
  assert.equal(page.elements.locateResultDistanceLabel.textContent, '主世界水平距离');
  assert.equal(page.formatLocateCoordinates(page.state.locateResult), '主世界 · X: -80, Z: 150');
});

test('conversion overflow is rejected on edit and submit, including both negative axes', async () => {
  const page = locator();
  page.elements.locateOriginDimension.value = 'minecraft:the_nether';
  for (const field of ['locateX', 'locateZ']) {
    for (const value of [3749999, -3749999]) {
      page.elements[field].valueAsNumber = value;
      page.clearLocateResult();
      assert.equal(page.elements.locateConversionNote.dataset.type, 'error');
      assert.match(page.elements.locateConversionNote.textContent, /超出世界范围/);
      await page.locateStructure();
      assert.equal(page.requests.length, 0);
    }
    page.elements[field].valueAsNumber = 0;
  }
  page.elements.locateX.valueAsNumber = -3749998;
  page.elements.locateZ.valueAsNumber = 3749998;
  page.clearLocateResult();
  assert.equal(page.elements.locateConversionNote.dataset.type, 'info');
  assert.match(page.elements.locateConversionNote.textContent, /X -29999984 \/ Z 29999984/);
});

test('end cross-dimension queries are blocked with a prompt and never reinterpret input coordinates', async () => {
  const page = locator();
  page.elements.locateX.valueAsNumber = 123;
  page.elements.locateZ.valueAsNumber = -456;
  for (const [dimension, structure] of [
    ['minecraft:the_end', 'mansion'], ['minecraft:the_end', 'fortress'],
    ['minecraft:overworld', 'end_city'], ['minecraft:the_nether', 'end_city'],
  ]) {
    page.elements.locateOriginDimension.value = dimension;
    page.elements.locateStructure.value = structure;
    page.clearLocateResult();
    assert.match(page.elements.locateConversionNote.textContent, /末地与其他维度无法换算/);
    assert.equal(page.elements.locateConversionNote.dataset.type, 'error');
    await page.locateStructure();
    assert.equal(page.requests.length, 0);
    assert.equal(page.elements.locateOriginDimension.value, dimension);
    assert.equal(page.elements.locateX.valueAsNumber, 123);
    assert.equal(page.elements.locateZ.valueAsNumber, -456);
  }
  page.elements.locateOriginDimension.value = 'minecraft:the_end';
  const origin = { dimension: 'minecraft:the_end', x: 123, z: -456 };
  page.responses.push(result({ structure: 'end_city', dimension: 'minecraft:the_end', origin, searchOrigin: origin }));
  await page.locateStructure();
  assert.equal(page.requests.length, 1);
  assert.equal(page.elements.locateResultDimension.textContent, '末地');
});

test('responses must match the submitted origin and the locally converted search origin', async () => {
  const page = locator();
  page.elements.locateStructure.value = 'fortress';
  page.elements.locateX.valueAsNumber = -1;
  page.elements.locateZ.valueAsNumber = -9;
  const valid = {
    structure: 'fortress', dimension: 'minecraft:the_nether',
    origin: { dimension: 'minecraft:overworld', x: -1, z: -9 },
    searchOrigin: { dimension: 'minecraft:the_nether', x: -1, z: -2 },
  };
  for (const invalid of [
    { origin: null }, { searchOrigin: undefined },
    { origin: { dimension: 'minecraft:the_nether', x: -1, z: -9 } },
    { origin: { dimension: 'minecraft:overworld', x: -1, z: -8 } },
    { searchOrigin: { dimension: 'minecraft:the_nether', x: 0, z: -1 } },
    { searchOrigin: { dimension: 'minecraft:overworld', x: -1, z: -2 } },
    { searchOrigin: { dimension: 'minecraft:the_nether', x: '-1', z: -2 } },
  ]) {
    page.responses.push(result({ ...valid, ...invalid }));
    await page.locateStructure();
    assert.equal(page.state.locateResult, null);
    assert.match(page.elements.locateMessage.textContent, /不完整/);
  }
});

test('changing the current dimension invalidates a pending response and does not issue another query', async () => {
  const pending = deferred();
  const page = locator([pending.promise]);
  const lookup = page.locateStructure();
  page.elements.locateOriginDimension.value = 'minecraft:the_nether';
  page.clearLocateResult();
  pending.resolve(result());
  await lookup;
  assert.equal(page.requests.length, 1);
  assert.equal(page.state.locateResult, null);
  assert.equal(page.elements.locateResult.hidden, true);
  assert.equal(page.state.locateBusy, false);
  assert.match(page.elements.locateConversionNote.textContent, /下界 → 主世界/);
});
