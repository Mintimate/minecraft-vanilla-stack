import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const adminSource = await readFile(new URL('../web/admin/app.js', import.meta.url), 'utf8');

// Run the shipped script against a minimal DOM and clock so real polling and
// visibility handlers are exercised without adding browser dependencies.
function browser({ hidden = false, enabled = true, responses = [] } = {}) {
  let now = Date.parse('2026-10-06T04:00:00Z');
  let timerID = 0;
  const timers = new Map();
  const nodes = new Map();
  const listeners = new Map();
  const requests = [];
  class Element {
    constructor(tag = 'div') {
      this.tag = tag;
      this.textContent = '';
      this.children = [];
      this.dataset = {};
      this.hidden = false;
      this.classList = { add() {}, remove() {}, toggle() {} };
    }
    set innerHTML(_) { throw new Error('Player names must not be HTML'); }
    appendChild(node) {
      this.children.push(...(node.tag === 'fragment' ? node.children : [node]));
    }
    replaceChildren() { this.children = []; }
    setAttribute() {}
    addEventListener() {}
  }
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, new Element());
    return nodes.get(id);
  };
  const document = {
    hidden,
    body: new Element(),
    querySelector: node,
    querySelectorAll: () => [],
    createDocumentFragment: () => new Element('fragment'),
    createElement: (tag) => new Element(tag),
    addEventListener(event, callback) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(callback);
    },
  };
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const window = {
    MVS_SITE: { publicStatusEnabled: enabled, links: {} },
    matchMedia: () => ({ matches: true, addEventListener() {} }),
    setTimeout(callback, delay) {
      timers.set(++timerID, { callback, time: now + delay });
      return timerID;
    },
    clearTimeout: (id) => timers.delete(id),
    clearInterval() {},
  };
  const fetch = async (url, options) => {
    requests.push({ url, options });
    const result = responses.shift();
    if (typeof result === 'function') return result(options);
    if (result instanceof Error) throw result;
    return { ok: result?.ok ?? true, json: async () => result?.body ?? result };
  };
  const flush = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };
  vm.runInNewContext(source, { document, window, fetch, Date: FakeDate, Intl, AbortController });
  return {
    node, requests, responses, flush,
    async advance(milliseconds) {
      const until = now + milliseconds;
      while (true) {
        const next = [...timers.entries()].filter(([, timer]) => timer.time <= until)
          .sort((a, b) => a[1].time - b[1].time)[0];
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].time;
        next[1].callback();
        await flush();
      }
      now = until;
      await flush();
    },
    async setHidden(value) {
      document.hidden = value;
      for (const callback of listeners.get('visibilitychange') ?? []) callback();
      await flush();
    },
  };
}

function status(overrides = {}) {
  return {
    status: 'online', players: [{ name: 'Alex' }], onlinePlayers: 1,
    maxPlayers: 20, updatedAt: '2026-10-06T04:00:00Z',
    checkedAt: '2026-10-06T04:00:00Z', stale: false,
    refreshIntervalSeconds: 300, ...overrides,
  };
}

test('anonymous first request renders names as text and includes the update date', async () => {
  const name = '<img src=x onerror=alert(1)>';
  const page = browser({ responses: [status({ players: [{ name }] })] });
  await page.flush();
  assert.equal(page.requests[0].url, '/api/server-status');
  assert.equal(page.requests[0].options.credentials, 'omit');
  assert.equal(page.requests[0].options.cache, 'no-store');
  assert.equal(page.node('#public-status').dataset.state, 'online');
  assert.equal(page.node('#public-status-count').textContent, '1');
  assert.equal(page.node('#public-status-players').children[0].textContent, name);
  assert.match(page.node('#public-status-updated').textContent, /2026/);
  assert.equal(page.node('#public-status-updated').dateTime, '2026-10-06T04:00:00Z');
});

test('a new visitor and a reloaded page show recent players separately from a current zero count', async () => {
  const name = '<img src=x onerror=alert(1)>';
  const lastOnline = { players: [{ name }], updatedAt: '2026-10-05T22:10:20Z' };
  for (let visit = 0; visit < 2; visit += 1) {
    const page = browser({ responses: [status({ players: [], onlinePlayers: 0, lastOnline })] });
    await page.flush();
    assert.equal(page.node('#public-status-count').textContent, '0');
    assert.equal(page.node('#public-status-players').hidden, true);
    assert.equal(page.node('#public-status-history-players').hidden, false);
    assert.deepEqual(page.node('#public-status-history-players').children.map((node) => node.textContent), [name]);
    assert.equal(page.node('#public-status-history-empty').hidden, true);
    assert.equal(page.node('#public-status-history-time').hidden, false);
    assert.equal(page.node('#public-status-history-updated').dateTime, lastOnline.updatedAt);
    assert.match(page.node('#public-status-history-updated').textContent, /2026/);
    assert.notEqual(page.node('#public-status-history-updated').textContent, page.node('#public-status-updated').textContent);
  }
});

test('null or omitted recent history is compatible and leaves an explicit empty state', async () => {
  for (const history of [{ lastOnline: null }, {}]) {
    const page = browser({ responses: [status({ players: [], onlinePlayers: 0, ...history })] });
    await page.flush();
    assert.equal(page.node('#public-status-count').textContent, '0');
    assert.equal(page.node('#public-status').dataset.state, 'online');
    assert.equal(page.node('#public-status-history-players').hidden, true);
    assert.equal(page.node('#public-status-history-empty').hidden, false);
    assert.equal(page.node('#public-status-history-empty').textContent, '暂无最近在线记录');
    assert.equal(page.node('#public-status-history-time').hidden, true);
  }
});

test('empty, failed and older responses preserve recent players and their original observation time', async () => {
  const lastOnline = { players: [{ name: 'Alex' }], updatedAt: '2026-10-06T04:00:00Z' };
  const page = browser({ responses: [status({ lastOnline })] });
  await page.flush();
  page.responses.push(status({ players: [], onlinePlayers: 0, updatedAt: '2026-10-06T04:00:20Z', lastOnline }));
  await page.advance(30000);
  assert.equal(page.node('#public-status-count').textContent, '0');
  for (const response of [
    { ok: false }, new Error('Offline'),
    status({ lastOnline: { players: [], updatedAt: 'not a date' } }),
    status({ status: 'unavailable', stale: true, updatedAt: null, onlinePlayers: null, maxPlayers: null, players: [], lastOnline: null }),
    status({ players: [{ name: 'OlderPlayer' }], updatedAt: '2026-10-06T03:00:00Z',
      lastOnline: { players: [{ name: 'OlderPlayer' }], updatedAt: '2026-10-06T03:00:00Z' } }),
    status({ players: [], onlinePlayers: 0, updatedAt: '2026-10-06T04:03:00Z' }),
  ]) {
    page.responses.push(response);
    await page.advance(30000);
    assert.equal(page.node('#public-status-count').textContent, '0');
    assert.deepEqual(page.node('#public-status-history-players').children.map((node) => node.textContent), ['Alex']);
    assert.equal(page.node('#public-status-history-updated').dateTime, lastOnline.updatedAt);
    assert.equal(page.node('#public-status-history-empty').hidden, true);
  }
});

test('cache updates advance recent history when player names change at the same count', async () => {
  const initialTime = '2026-10-06T04:00:00Z';
  const nextTime = '2026-10-06T04:00:20Z';
  const page = browser({ responses: [
    status({ lastOnline: { players: [{ name: 'Alex' }], updatedAt: initialTime } }),
    status({ players: [{ name: 'Steve' }], updatedAt: nextTime,
      lastOnline: { players: [{ name: 'Steve' }], updatedAt: nextTime } }),
  ] });
  await page.flush();
  await page.advance(30000);
  assert.equal(page.node('#public-status-count').textContent, '1');
  assert.deepEqual(page.node('#public-status-players').children.map((node) => node.textContent), ['Steve']);
  assert.deepEqual(page.node('#public-status-history-players').children.map((node) => node.textContent), ['Steve']);
  assert.equal(page.node('#public-status-history-updated').dateTime, nextTime);
  assert.equal(page.requests.at(-1).url, '/api/server-status?cached=1');
});

test('recent history accepts the server-selected names when timestamps share the same millisecond', async () => {
  const updatedAt = '2026-10-06T04:00:00.123Z';
  const page = browser({ responses: [
    status({ updatedAt, lastOnline: { players: [{ name: 'Alex' }], updatedAt } }),
    status({ players: [{ name: 'Steve' }], updatedAt,
      lastOnline: { players: [{ name: 'Steve' }], updatedAt } }),
  ] });
  await page.flush();
  await page.advance(30000);
  assert.deepEqual(page.node('#public-status-history-players').children.map((node) => node.textContent), ['Steve']);
  assert.equal(page.node('#public-status-history-updated').dateTime, updatedAt);
});

test('visible pages read the cache every 30 seconds and retain the five-minute full refresh', async () => {
  const page = browser({ responses: Array.from({ length: 11 }, () => status()) });
  await page.flush();
  await page.advance(29999);
  assert.equal(page.requests.length, 1);
  await page.advance(1);
  assert.equal(page.requests.length, 2);
  assert.equal(page.requests[1].url, '/api/server-status?cached=1');
  await page.advance(269999);
  assert.equal(page.requests.length, 10);
  assert.ok(page.requests.slice(1).every(({ url }) => url === '/api/server-status?cached=1'));
  await page.advance(1);
  assert.equal(page.requests.length, 11);
  assert.equal(page.requests[10].url, '/api/server-status');
  assert.ok(page.requests.every(({ url, options }) => /^\/api\/server-status(?:\?cached=1)?$/.test(url)
    && options.credentials === 'omit' && (!options.method || options.method === 'GET')));
});

test('hidden pages pause; visibility uses independent cache and full-refresh deadlines', async () => {
  const page = browser({ responses: Array.from({ length: 12 }, () => status()) });
  await page.flush();
  await page.advance(10000);
  await page.setHidden(true);
  await page.advance(40000);
  assert.equal(page.requests.length, 1);
  await page.setHidden(false);
  assert.equal(page.requests.length, 2);
  assert.equal(page.requests[1].url, '/api/server-status?cached=1');
  await page.setHidden(true);
  await page.advance(1000);
  await page.setHidden(false);
  assert.equal(page.requests.length, 2);
  await page.advance(239000);
  assert.equal(page.requests.at(-1).url, '/api/server-status?cached=1');
  const beforeDeadline = page.requests.length;
  await page.advance(10000);
  assert.equal(page.requests.length, beforeDeadline + 1);
  assert.equal(page.requests.at(-1).url, '/api/server-status');
  await page.setHidden(true);
  await page.advance(600000);
  assert.equal(page.requests.length, beforeDeadline + 1);
  await page.setHidden(false);
  assert.equal(page.requests.at(-1).url, '/api/server-status');
  assert.equal(page.requests.length, beforeDeadline + 2);
});

test('an aging cached sample becomes stale at five minutes without an extra request', async () => {
  const page = browser({ responses: Array.from({ length: 3 }, () => status({ updatedAt: '2026-10-06T03:56:15Z' })) });
  await page.flush();
  assert.equal(page.node('#public-status').dataset.state, 'online');
  await page.advance(74999);
  assert.equal(page.node('#public-status').dataset.state, 'online');
  assert.equal(page.requests.length, 3);
  await page.advance(1);
  assert.equal(page.node('#public-status').dataset.state, 'pending');
  assert.equal(page.node('#public-status-badge').textContent, '待刷新');
  assert.equal(page.node('#public-status-count').textContent, '1');
  assert.equal(page.requests.length, 3);
  page.responses.push(status({ updatedAt: '2026-10-06T04:01:20Z' }));
  await page.advance(15000);
  assert.equal(page.requests.length, 4);
  assert.equal(page.requests.at(-1).url, '/api/server-status?cached=1');
  assert.equal(page.node('#public-status').dataset.state, 'online');
});

test('an initially hidden page waits for visibility; requests never overlap and time out', async () => {
  const page = browser({ hidden: true, responses: [(options) => new Promise((_, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('Request timed out')));
  })] });
  assert.equal(page.requests.length, 0);
  await page.setHidden(false);
  await page.setHidden(true);
  await page.setHidden(false);
  assert.equal(page.requests.length, 1);
  await page.advance(15000);
  assert.equal(page.requests[0].options.signal.aborted, true);
  assert.equal(page.node('#public-status-count').textContent, '—');
  assert.equal(page.node('#public-status-badge').textContent, '待刷新');
  page.responses.push(status({ players: [], onlinePlayers: 0, updatedAt: '2026-10-06T04:00:30Z' }));
  await page.advance(15000);
  assert.equal(page.requests.length, 2);
  assert.equal(page.requests[1].url, '/api/server-status?cached=1');
  assert.equal(page.node('#public-status-count').textContent, '0');
  assert.equal(page.node('#public-status').dataset.state, 'online');
});

test('failed, malformed and older samples preserve the latest successful record as stale', async () => {
  const page = browser({ responses: [status()] });
  await page.flush();
  for (const response of [
    { ok: false }, new Error('Offline'),
    status({ players: 'not an array' }),
    status({ updatedAt: 'not a date' }),
    status({ status: 'unavailable', stale: true, updatedAt: null, onlinePlayers: null, maxPlayers: null, players: [] }),
    status({ status: 'unavailable', stale: true, updatedAt: '2026-10-06T03:00:00Z', onlinePlayers: 0, players: [] }),
  ]) {
    page.responses.push(response);
    await page.advance(30000);
    assert.equal(page.node('#public-status').dataset.state, 'pending');
    assert.equal(page.node('#public-status-count').textContent, '1');
    assert.equal(page.node('#public-status-players').children[0].textContent, 'Alex');
    assert.equal(page.node('#public-status-updated').dateTime, '2026-10-06T04:00:00Z');
    assert.match(page.node('#public-status-message').textContent, /上次成功/);
  }
});

test('administrator cache updates replace counts and names, including same-count player changes', async () => {
  const page = browser({ responses: [
    status(),
    status({ players: [{ name: 'Alex' }, { name: 'Steve' }], onlinePlayers: 2, updatedAt: '2026-10-06T04:00:20Z' }),
    status({ players: [{ name: 'Alex' }, { name: 'Mint' }], onlinePlayers: 2, updatedAt: '2026-10-06T04:00:45Z' }),
  ] });
  await page.flush();
  await page.advance(30000);
  assert.equal(page.node('#public-status-count').textContent, '2');
  assert.deepEqual(page.node('#public-status-players').children.map((node) => node.textContent), ['Alex', 'Steve']);
  await page.advance(30000);
  assert.equal(page.node('#public-status-count').textContent, '2');
  assert.deepEqual(page.node('#public-status-players').children.map((node) => node.textContent), ['Alex', 'Mint']);
  assert.equal(page.node('#public-status-updated').dateTime, '2026-10-06T04:00:45Z');
  assert.equal(page.node('#public-status').dataset.state, 'online');
  assert.deepEqual(page.requests.map(({ url }) => url), ['/api/server-status', '/api/server-status?cached=1', '/api/server-status?cached=1']);
});

test('a stale cached record is shown without claiming the server is currently online', async () => {
  const page = browser({ responses: [status({ status: 'unavailable', stale: true })] });
  await page.flush();
  assert.equal(page.node('#public-status-count').textContent, '1');
  assert.equal(page.node('#public-status-badge').textContent, '待刷新');
  assert.equal(page.node('#public-status-players-label').textContent, '上次记录的冒险家');
});

test('the first failure shows unknown player counts, not zero or offline', async () => {
  const page = browser({ responses: [status({
    status: 'unavailable', stale: true, players: [],
    onlinePlayers: null, maxPlayers: null, updatedAt: null,
  })] });
  await page.flush();
  assert.equal(page.node('#public-status-count').textContent, '—');
  assert.equal(page.node('#public-status-capacity').textContent, '—');
  assert.equal(page.node('#public-status-badge').textContent, '待刷新');
  assert.equal(page.node('#public-status-players').hidden, true);
});

// Exercise the shipped overview loader and sync renderer with only their direct
// collaborators. The unrelated administration forms do not need a fake DOM.
function adminOverview(responses = []) {
  const context = {
    state: { overviewReady: false, overview: null },
    elements: Object.fromEntries(['publicStatusSync', 'dailyStatus', 'dailyMessage'].map((name) =>
      [name, { textContent: '', hidden: true, dataset: {} }])),
    APIError: class extends Error { constructor(message, status) { super(message); this.status = status; } },
    request: async (path) => {
      assert.equal(path, '/api/overview');
      const result = responses.shift();
      if (result instanceof Error) throw result;
      return result;
    },
    syncControls() {},
    renderFreshness() { context.renderPublicStatusSync(); },
    renderOverview() { context.renderPublicStatusSync(); },
    handleError() { context.state.overviewReady = false; context.renderPublicStatusSync(); },
  };
  const functions = [
    ['  function message(', '  function snapshotTime('],
    ['  function renderPublicStatusSync(', '  function renderFreshness('],
    ['  async function loadOverview(', '  function handleDailyError('],
    ['  function handleDailyError(', '  async function runAction('],
  ].map(([start, end]) => {
    const from = adminSource.indexOf(start);
    const until = adminSource.indexOf(end, from);
    assert.ok(from >= 0 && until > from);
    return adminSource.slice(from, until);
  }).join('\n');
  vm.runInNewContext(functions, context);
  return { ...context, responses };
}

test('administrator overview reports visitor-sync success or failure without rejecting fresh data', async () => {
  const overview = (synced) => ({ server: { players: [{ name: 'Alex' }], maxPlayers: 10, dayTime: 6000 },
    updatedAt: '2026-10-06T04:00:00Z', ...(synced === undefined ? {} : { publicStatusSynced: synced }) });
  const admin = adminOverview([overview(true)]);
  await admin.loadOverview();
  const prompt = admin.elements.publicStatusSync;
  assert.equal(admin.state.overviewReady, true);
  assert.equal(prompt.hidden, false);
  assert.equal(prompt.dataset.type, 'success');
  assert.match(prompt.textContent, /已同步游客状态/);

  let resolveRefresh;
  admin.responses.push(new Promise((resolve) => { resolveRefresh = resolve; }));
  const refreshing = admin.loadOverview();
  assert.equal(prompt.hidden, true, 'hide previous success while a new refresh is pending');
  resolveRefresh(overview(false));
  await refreshing;
  assert.equal(admin.state.overviewReady, true);
  assert.equal(admin.state.overview.server.players[0].name, 'Alex');
  assert.match(prompt.textContent, /后台数据已更新，游客状态暂未同步/);
  assert.equal(admin.elements.dailyMessage.hidden, true);

  admin.responses.push(overview());
  await admin.loadOverview();
  assert.equal(admin.state.overviewReady, true);
  assert.equal(prompt.hidden, true, 'older APIs without the boolean must not claim successful publication');

  admin.responses.push(overview(true), new Error('overview failed'));
  await admin.loadOverview();
  assert.equal(prompt.hidden, false);
  await admin.loadOverview();
  assert.equal(admin.state.overviewReady, false);
  assert.equal(prompt.hidden, true, 'failed queries must not retain the previous sync-success prompt');
  assert.match(admin.elements.dailyMessage.textContent, /overview failed/);
});


test('a site without public status opt-in makes no status requests', async () => {
  const page = browser({ enabled: false });
  await page.flush();
  await page.advance(600000);
  await page.setHidden(true);
  await page.setHidden(false);
  assert.equal(page.requests.length, 0);
  assert.equal(page.node('#public-status').hidden, true);
});
