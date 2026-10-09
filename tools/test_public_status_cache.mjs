import assert from 'node:assert/strict';
import test from 'node:test';
import { createStatusHandler, createStatusPublisher } from '../web/lib/server-status.mjs';

const INTERVAL = 300_000;
const BASE = Date.parse('2026-10-06T04:00:00Z');
const ENV = { RCON_HOST: 'private-rcon-host.example.test', RCON_PASSWORD: 'private-rcon-password-private-rcon-password' };
const clone = (value) => structuredClone(value);
const iso = (value) => new Date(value).toISOString();
const tick = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function sample(time = BASE, name = 'Alex') {
  return { players: [{ name }], onlinePlayers: 1, maxPlayers: 20, updatedAt: iso(time) };
}

function history(time = BASE, name = 'Alex') {
  return { players: [{ name }], updatedAt: iso(time) };
}

function zero(time = BASE) {
  return { players: [], onlinePlayers: 0, maxPlayers: 20, updatedAt: iso(time) };
}

function saved(time = BASE, name = 'Alex') {
  return { status: 'online', ...sample(time, name), checkedAt: iso(time) };
}

// The probe returns the public sample; a failed probe throws. A non-200 status
// models any probe failure (RCON down, bad reply) without naming its cause.
function response(body = sample(), status = 200) {
  return status === 200 ? body : Object.assign(new Error('probe failed'), { status });
}

function memory() {
  const stores = new Map();
  const calls = [];
  const faults = {};
  const getStore = (options) => {
    calls.push({ operation: 'getStore', ...options });
    assert.equal(options.consistency, 'strong');
    if (faults.getStore) throw faults.getStore instanceof Error ? faults.getStore : new Error('secret storage configuration');
    if (!stores.has(options.name)) stores.set(options.name, new Map());
    const values = stores.get(options.name);
    return {
      async list({ prefix }) {
        calls.push({ operation: 'list', prefix });
        if (faults.historyList && prefix === 'last-online/') throw new Error('private history origin');
        if (faults.list) throw faults.list instanceof Error ? faults.list : new Error('private storage origin');
        return { blobs: [...values.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })) };
      },
      async get(key) {
        if (faults.historyGet && key.startsWith('last-online/')) throw new Error('private history credentials');
        if (faults.get) throw new Error('private blob credentials');
        return clone(values.get(key) ?? null);
      },
      async setJSON(key, value, options) {
        calls.push({ operation: 'setJSON', key, options });
        if ((faults.historyWrite && key.startsWith('last-online/')) || faults.setJSON || (faults.claim && key.startsWith('claims/')) ||
            (faults.snapshot && key.startsWith('snapshots/'))) throw new Error('storage is down');
        if (options?.onlyIfNew && values.has(key)) {
          const error = new Error('exists');
          error.name = 'PagesBlobError';
          error.code = 'PRECONDITION_FAILED';
          throw error;
        }
        values.set(key, clone(value));
      },
      async delete(key) {
        calls.push({ operation: 'delete', key });
        if (faults.delete) throw new Error('private delete error');
        values.delete(key);
      },
    };
  };
  return { getStore, stores, calls, faults, values: () => stores.values().next().value };
}

function setup({ clock = BASE, storage = memory(), probe, sleep = tick, env = ENV, log, trace } = {}) {
  const state = { time: clock, probes: [], responses: [], logs: [], traces: [] };
  const deps = {
    getStore: storage.getStore, now: () => state.time, sleep,
    log: log ?? ((entry) => state.logs.push(entry)),
    trace: trace ?? ((entry) => state.traces.push(entry)),
    probe: probe ?? (async (probeEnv) => {
      state.probes.push({ env: probeEnv });
      const next = state.responses.shift();
      if (next instanceof Error) throw next;
      return next ?? sample(state.time);
    }),
  };
  const handler = createStatusHandler(deps);
  const request = (options = {}) => handler({
    env, request: new Request('https://untrusted.example.test/api/server-status?host=evil.test', options),
  });
  const cached = () => handler({ env,
    request: new Request('https://minecraft.example.test/api/server-status?cached=1') });
  const publisher = createStatusPublisher(deps);
  // Mirrors the old HTTP result shape so assertions read the same.
  const publish = async (body = sample(state.time)) => {
    try { await publisher(body); return Response.json({ ok: true }); }
    catch (error) {
      return Response.json({ ok: false, error: { code: error.code, message: error.message } },
        { status: error.code === 'STATUS_PUBLISH_INVALID' ? 400 : 503 });
    }
  };
  return { state, storage, deps, handler, request, cached, publisher, publish };
}

test('the anonymous endpoint emits only whitelisted fields and probes without visitor-controlled input', async () => {
  const app = setup();
  app.state.responses.push(response({ ...sample(), address: '192.0.2.12', raw: 'secret response',
    players: [{ name: 'Alex', uuid: 'private-id', address: '192.0.2.13' }] }));
  const result = await app.request({ headers: { Host: 'evil.test', Origin: 'https://evil.test', Authorization: 'visitor-token' } });
  const body = await result.json();
  assert.equal(result.status, 200);
  assert.deepEqual(body, { ...saved(), stale: false, refreshIntervalSeconds: 300, lastOnline: history() });
  assert.equal(result.headers.get('Cache-Control'), 'no-store');
  assert.equal(result.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal(app.state.probes.length, 1);
  // The probe sees only the server-side environment, never the visitor's request.
  assert.deepEqual(Object.keys(app.state.probes[0]), ['env']);
  assert.equal(app.state.probes[0].env, ENV);
  assert.equal(JSON.stringify(body).includes('secret'), false);
});
test('HEAD, POST and OPTIONS cannot create a cache claim or run a probe', async () => {
  const app = setup();
  for (const method of ['HEAD', 'POST', 'OPTIONS']) {
    const result = await app.request({ method });
    assert.equal(result.status, 405);
    assert.equal(result.headers.get('Allow'), 'GET');
  }
  assert.equal(app.storage.calls.length, 0);
  assert.equal(app.state.probes.length, 0);
});

test('two independent handlers share a Blob claim and wait for the one probe', async () => {
  const started = deferred();
  const pending = deferred();
  let probes = 0;
  const app = setup({ probe: async () => { probes += 1; started.resolve(); return pending.promise; },
    sleep: async () => { pending.resolve(response()); await tick(); } });
  const first = app.request();
  await started.promise;
  const independent = createStatusHandler({ ...app.deps });
  const second = independent({ env: ENV, request: new Request('https://attacker.test/api/server-status') });
  const results = await Promise.all([first, second]);
  assert.equal(probes, 1);
  assert.deepEqual(await results[0].json(), await results[1].json());
  assert.equal(app.storage.calls.filter((call) => call.key?.startsWith('snapshots/')).length, 1);
});

test('both successful and failed checks have a five-minute TTL; failure keeps the last success and recovery replaces it', async () => {
  const app = setup();
  await app.request();
  app.state.time += INTERVAL - 1;
  assert.equal((await (await app.request()).json()).stale, false);
  assert.equal(app.state.probes.length, 1);
  app.state.time += 1;
  app.state.responses.push(response({ error: '192.0.2.12 private error' }, 502));
  const failed = await (await app.request()).json();
  assert.deepEqual(failed, { ...saved(), status: 'unavailable', checkedAt: iso(BASE + INTERVAL),
    stale: true, refreshIntervalSeconds: 300, lastOnline: history() });
  app.state.time += INTERVAL - 1;
  assert.deepEqual(await (await app.request()).json(), failed);
  assert.equal(app.state.probes.length, 2);
  app.state.time += 1;
  app.state.responses.push(response(sample(app.state.time, 'Steve')));
  const recovered = await (await app.request()).json();
  assert.equal(recovered.status, 'online');
  assert.equal(recovered.stale, false);
  assert.deepEqual(recovered.players, [{ name: 'Steve' }]);
  assert.equal(recovered.checkedAt, iso(app.state.time));
  assert.equal(app.state.probes.length, 3);
});

test('an initial failed or malformed probe returns unknown counts with HTTP 200 and caches that failure', async () => {
  for (const reply of [response({ message: 'private address' }, 502), response({ ...sample(), players: 'invalid' }),
    response({ ...sample(), updatedAt: 'invalid' }), response({ ...sample(), onlinePlayers: -1 })]) {
    const app = setup();
    app.state.responses.push(reply);
    const result = await app.request();
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { status: 'unavailable', players: [], onlinePlayers: null,
      maxPlayers: null, updatedAt: null, checkedAt: iso(BASE), stale: true, refreshIntervalSeconds: 300, lastOnline: null });
    await app.request();
    assert.equal(app.state.probes.length, 1);
  }
});

test('a late old bucket cannot replace the snapshot returned from the newer bucket', async () => {
  const started = deferred();
  const pending = deferred();
  let probes = 0;
  const app = setup({ clock: BASE + INTERVAL - 1, probe: async () => {
    probes += 1;
    if (probes === 1) { started.resolve(); return pending.promise; }
    return response(sample(BASE + INTERVAL, 'NewPlayer'));
  } });
  const old = app.request();
  await started.promise;
  app.state.time = BASE + INTERVAL;
  const newer = await (await app.request()).json();
  pending.resolve(response(sample(BASE, 'OldPlayer')));
  const completedOld = await (await old).json();
  assert.deepEqual(completedOld, newer);
  assert.deepEqual(completedOld.lastOnline, history(BASE + INTERVAL, 'NewPlayer'));
  assert.deepEqual((await (await app.request()).json()).players, [{ name: 'NewPlayer' }]);
  assert.equal(app.storage.values().size, 5);
});

test('storage construction, listing, read and claim errors never bypass the cache to probe', async () => {
  const stages = { getStore: 'blob-init', list: 'blob-read', claim: 'blob-claim' };
  for (const fault of ['getStore', 'list', 'claim']) {
    const app = setup();
    app.storage.faults[fault] = true;
    const result = await app.request();
    assert.equal(result.status, 503);
    const body = await result.json();
    assert.equal(body.checkedAt, null);
    assert.equal(body.stale, true);
    assert.equal(app.state.probes.length, 0);
    assert.equal(JSON.stringify(body).includes('private'), false);
    assert.equal(body.error.code, 'UNKNOWN_ERROR');
    assert.deepEqual(app.state.logs, [{ event: 'server_status_failure', stage: stages[fault], code: 'UNKNOWN_ERROR' }]);
  }
  const app = setup();
  await app.request();
  app.state.time += INTERVAL;
  app.storage.faults.get = true;
  assert.equal((await app.request()).status, 503);
  assert.equal(app.state.probes.length, 1);
  app.storage.faults.get = false;
  app.storage.faults.claim = true;
  const stale = await app.request();
  assert.equal(stale.status, 200);
  const staleBody = await stale.json();
  assert.equal(staleBody.stale, true);
  assert.equal('error' in staleBody, false);
  assert.equal(app.state.probes.length, 1);
});

test('snapshot write failures return the old sample as stale without exposing unstored data', async () => {
  const app = setup();
  await app.request();
  app.state.time += INTERVAL;
  app.state.responses.push(response(sample(app.state.time, 'UnstoredPlayer')));
  app.storage.faults.snapshot = true;
  const result = await app.request();
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.deepEqual(body.players, [{ name: 'Alex' }]);
  assert.equal(body.stale, true);
  assert.equal('error' in body, false);
  assert.deepEqual(app.state.logs, [{ event: 'server_status_failure', stage: 'blob-write', code: 'UNKNOWN_ERROR' }]);
});

test('claim conflicts are bounded to eight seconds and return stale or unavailable cache results', async () => {
  let slept = 0;
  const app = setup({ sleep: async (duration) => { slept += duration; } });
  await app.request();
  const values = app.storage.values();
  values.delete(`snapshots/${Math.floor(BASE / INTERVAL)}.json`);
  const result = await app.request();
  assert.equal(result.status, 503);
  assert.equal((await result.json()).error.code, 'STATUS_REFRESH_PENDING');
  assert.equal(slept, 8_000);
  assert.equal(app.state.probes.length, 1);
});

test('an unconfigured probe is diagnosed with a safe code and cached as unavailable', async () => {
  const app = setup({ probe: async () => { throw Object.assign(new Error('RCON_HOST private-host'), { code: 'STATUS_PROBE_NOT_CONFIGURED' }); } });
  const result = await app.request();
  const body = await result.json();
  assert.equal(result.status, 200);
  assert.equal(body.status, 'unavailable');
  assert.deepEqual(app.state.logs, [{ event: 'server_status_failure', stage: 'probe', code: 'STATUS_PROBE_NOT_CONFIGURED' }]);
  assert.equal(JSON.stringify({ body, logs: app.state.logs }).includes('private-host'), false);
});

test('Blob errors expose only allowlisted codes and fixed messages through diagnostics', async () => {
  const secret = 'private-token@192.0.2.11:25575/secret';
  for (const code of ['MISSING_ENVIRONMENT', 'MISSING_PROJECT_ID', 'CREDENTIAL_ERROR', secret, '__proto__']) {
    const app = setup();
    app.storage.faults.getStore = Object.assign(new Error(secret), { code });
    const result = await app.request();
    const body = await result.json();
    const expected = ['MISSING_ENVIRONMENT', 'MISSING_PROJECT_ID', 'CREDENTIAL_ERROR'].includes(code)
      ? code : 'UNKNOWN_ERROR';
    assert.equal(result.status, 503);
    assert.equal(body.error.code, expected);
    assert.deepEqual(app.state.logs, [{ event: 'server_status_failure', stage: 'blob-init', code: expected }]);
    assert.equal(JSON.stringify({ body, logs: app.state.logs }).includes(secret), false);
    assert.equal(app.state.probes.length, 0);
  }
  const app = setup();
  app.storage.faults.list = Object.assign(new Error(secret), { code: 'COS_ERROR' });
  assert.equal((await (await app.request()).json()).error.code, 'COS_ERROR');
  assert.deepEqual(app.state.logs, [{ event: 'server_status_failure', stage: 'blob-read', code: 'COS_ERROR' }]);
});

test('probe failures have safe diagnostic logs while HTTP 200 response fields remain unchanged', async () => {
  const secret = 'private-probe-credentials@192.0.2.90';
  const app = setup();
  app.state.responses.push(Object.assign(new Error(secret), { code: secret }));
  const result = await app.request();
  const body = await result.json();
  assert.equal(result.status, 200);
  assert.deepEqual(body, { status: 'unavailable', players: [], onlinePlayers: null,
    maxPlayers: null, updatedAt: null, checkedAt: iso(BASE), stale: true, refreshIntervalSeconds: 300, lastOnline: null });
  assert.deepEqual(app.state.logs, [{ event: 'server_status_failure', stage: 'probe', code: 'STATUS_PROBE_FAILED' }]);
  assert.equal(JSON.stringify({ body, logs: app.state.logs }).includes(secret), false);
});

test('a failing logger cannot break the safe HTTP fallback', async () => {
  const boom = () => { throw new Error('private logger failure'); };
  const app = setup({ log: boom, trace: boom });
  app.state.responses.push(response({}, 502));
  const result = await app.request();
  assert.equal(result.status, 200);
  assert.equal((await result.json()).status, 'unavailable');
  const stored = setup({ log: boom, trace: boom });
  assert.equal((await stored.request()).status, 200);
});
test('each request writes one summary trace saying how it was served', async () => {
  const app = setup();
  assert.equal((await app.request()).status, 200);
  assert.equal((await app.request()).status, 200);
  await app.cached();
  const outcomes = app.state.traces.map((entry) => entry.outcome);
  assert.deepEqual(outcomes, ['probe_ok', 'refreshed', 'cache_hit', 'cache_only']);
  assert.ok(app.state.traces.every((entry) => entry.event === 'server_status' && typeof entry.elapsedMs === 'number' || entry.outcome === 'probe_ok'));
  assert.equal(app.state.traces[0].onlinePlayers, 1);
  assert.equal(JSON.stringify(app.state.traces).includes('Alex'), false);
});
test('a failed probe is traced as an error summary and keeps the safe diagnostic', async () => {
  const app = setup();
  app.state.responses.push(response({}, 502));
  await app.request();
  assert.deepEqual(app.state.logs.map((entry) => entry.code), ['STATUS_PROBE_FAILED']);
  assert.equal(app.state.traces.at(-1).outcome, 'refreshed');
  assert.equal(app.state.traces.at(-1).sampleStatus, 'unavailable');
});
test('stored extra fields are stripped, malformed snapshots are skipped, and cleanup retains the latest three', async () => {
  const app = setup();
  await app.request();
  const values = app.storage.values();
  const slot = Math.floor(BASE / INTERVAL);
  values.set(`snapshots/${slot}.json`, { ...saved(), host: '192.0.2.55', players: [{ name: 'Alex', secret: 'hidden' }] });
  values.set(`snapshots/${slot + 1}.json`, { ...saved(), players: 'malformed' });
  values.set('snapshots/not-a-slot.json', { private: 'ignored' });
  assert.deepEqual(await (await app.request()).json(), { ...saved(), stale: false, refreshIntervalSeconds: 300, lastOnline: history() });
  values.delete(`snapshots/${slot + 1}.json`);
  for (let round = 1; round <= 5; round += 1) {
    app.state.time += INTERVAL;
    assert.equal((await app.request()).status, 200);
  }
  assert.equal([...values.keys()].filter((key) => /^snapshots\/\d+\.json$/.test(key)).length, 3);
  assert.equal([...values.keys()].filter((key) => /^claims\/\d+\.json$/.test(key)).length, 3);
  app.storage.faults.delete = true;
  app.state.time += INTERVAL;
  assert.equal((await (await app.request()).json()).status, 'online');
});

test('administrator snapshots immediately update cached and new visitor views, including a changed player with the same count', async () => {
  const app = setup();
  await app.request();
  app.state.time += 1_000;
  assert.deepEqual(await (await app.publish(sample(app.state.time, 'Steve'))).json(), { ok: true });
  const cached = await (await app.cached()).json();
  assert.deepEqual(cached, { ...saved(app.state.time, 'Steve'), stale: false, refreshIntervalSeconds: 300,
    lastOnline: history(app.state.time, 'Steve') });
  const independent = createStatusHandler(app.deps);
  const newcomer = await independent({ env: ENV,
    request: new Request('https://minecraft.example.test/api/server-status') });
  assert.deepEqual(await newcomer.json(), cached);
  assert.equal(app.state.probes.length, 1);
  assert.equal(app.storage.calls.filter((call) => call.key?.startsWith('claims/')).length, 1);
  assert.equal(JSON.stringify(cached).includes('observedAt'), false);
  assert.equal(JSON.stringify(cached).includes('source'), false);
});

test('publishing validates timestamps, counts, and the complete public field allowlist before Blob access', async () => {
  const app = setup();
  const invalid = [
    null, { ...sample(), updatedAt: 'invalid' }, sample(BASE - INTERVAL - 1), sample(BASE + 5_001),
    { ...sample(), onlinePlayers: 2 }, { ...sample(), onlinePlayers: -1 },
    { ...sample(), maxPlayers: -1 }, { ...sample(), host: '192.0.2.42' },
    { ...sample(), players: [{ name: 'Alex', raw: 'private-token' }] },
    { ...sample(), players: [{ name: 'line\nbreak' }] },
  ];
  for (const body of invalid) {
    const result = await app.publish(body);
    assert.equal(result.status, 400);
    assert.equal((await result.json()).error.code, 'STATUS_PUBLISH_INVALID');
  }
  for (const body of ['{', undefined, 'string', [], 42]) {
    assert.equal((await app.publish(body === undefined ? null : body)).status, 400);
  }
  assert.equal(app.storage.calls.length, 0);
  assert.equal(app.state.probes.length, 0);
  const zero = { players: [], onlinePlayers: 0, maxPlayers: 20, updatedAt: iso(BASE) };
  assert.equal((await app.publish(zero)).status, 200);
  assert.equal((await (await app.cached()).json()).onlinePlayers, 0);
});

test('cache-only requests never claim or probe, whether storage is empty, fresh, or expired', async () => {
  const app = setup();
  const missing = await app.cached();
  assert.equal(missing.status, 503);
  assert.equal((await missing.json()).error.code, 'STATUS_CACHE_EMPTY');
  assert.equal(app.state.probes.length, 0);
  await app.publish();
  assert.equal((await (await app.cached()).json()).stale, false);
  app.state.time += INTERVAL + 1;
  const expired = await app.cached();
  assert.equal(expired.status, 200);
  assert.deepEqual(await expired.json(), { ...saved(), stale: true, refreshIntervalSeconds: 300, lastOnline: history() });
  assert.equal(app.state.probes.length, 0);
  assert.equal(app.storage.calls.filter((call) => call.key?.startsWith('claims/')).length, 0);
});

test('a late older administrator sample cannot replace a newer one, including within the same millisecond', async () => {
  const app = setup();
  app.state.time += 2_000;
  const newer = { ...sample(BASE + 1_000, 'NewPlayer'), updatedAt: '2026-10-06T04:00:01.000900001Z' };
  assert.equal((await app.publish(newer)).status, 200);
  const older = { ...sample(BASE + 1_000, 'OldPlayer'), updatedAt: '2026-10-06T04:00:01.000100002Z' };
  assert.equal((await app.publish(older)).status, 200);
  assert.deepEqual((await (await app.cached()).json()).players, [{ name: 'NewPlayer' }]);
  assert.equal(app.storage.calls.filter((call) => call.operation === 'setJSON').length, 2);
  assert.deepEqual((await (await app.cached()).json()).lastOnline, history(BASE + 1_000, 'NewPlayer'));
});

test('a slow automatic success or failure cannot overwrite administrator data published during the probe', async () => {
  for (const success of [true, false]) {
    const started = deferred();
    const pending = deferred();
    const app = setup({ probe: async () => { started.resolve(); return pending.promise; } });
    const automatic = app.request();
    await started.promise;
    app.state.time += 1_000;
    await app.publish(sample(app.state.time, 'AdminPlayer'));
    const expected = await (await app.cached()).json();
    app.state.time += 1_000;
    pending.resolve(success ? response(sample(BASE, 'OldPlayer')) : response({ error: 'private-error' }, 502));
    assert.deepEqual(await (await automatic).json(), expected);
    assert.deepEqual(await (await app.cached()).json(), expected);
    assert.equal(app.storage.calls.filter((call) => call.key?.startsWith('snapshots/')).length, 0);
  }
});

test('a new administrator observation wins over a previous automatic failure in the same bucket', async () => {
  const app = setup();
  app.state.responses.push(response({}, 502));
  assert.equal((await (await app.request()).json()).status, 'unavailable');
  app.state.time += 1_000;
  await app.publish(sample(app.state.time, 'RecoveredPlayer'));
  const result = await (await app.request()).json();
  assert.equal(result.status, 'online');
  assert.equal(result.stale, false);
  assert.deepEqual(result.players, [{ name: 'RecoveredPlayer' }]);
  assert.equal(app.state.probes.length, 1);
});

test('administrator storage failures return only safe diagnostics and preserve the previous visitor data', async () => {
  const app = setup();
  await app.publish();
  app.state.time += 1_000;
  app.storage.faults.setJSON = true;
  const result = await app.publish(sample(app.state.time, 'UnstoredPlayer'));
  assert.equal(result.status, 503);
  const body = await result.json();
  assert.equal(body.error.code, 'UNKNOWN_ERROR');
  assert.equal(JSON.stringify({ body, logs: app.state.logs }).includes('storage is down'), false);
  assert.deepEqual((await (await app.cached()).json()).players, [{ name: 'Alex' }]);
  app.storage.faults.setJSON = false;
  app.storage.faults.delete = true;
  assert.equal((await app.publish(sample(app.state.time, 'SavedPlayer'))).status, 200);
});

test('administrator snapshot cleanup keeps the latest three without deleting current claims or automatic samples', async () => {
  const app = setup();
  await app.request();
  for (let round = 1; round <= 6; round += 1) {
    app.state.time += 1_000;
    assert.equal((await app.publish(sample(app.state.time, `Player${round}`))).status, 200);
  }
  const keys = [...app.storage.values().keys()];
  assert.equal(keys.filter((key) => key.startsWith('admin-snapshots/')).length, 3);
  assert.equal(keys.filter((key) => key.startsWith('snapshots/')).length, 1);
  assert.equal(keys.filter((key) => key.startsWith('claims/')).length, 1);
  assert.deepEqual((await (await app.cached()).json()).players, [{ name: 'Player6' }]);
});

test('cleanup retains the newest nanosecond observations even when several administrators publish in one millisecond', async () => {
  const app = setup();
  for (let round = 1; round <= 7; round += 1) {
    const data = { ...sample(BASE, `Player${round}`), updatedAt: `2026-10-06T04:00:00.00000000${round}Z` };
    assert.equal((await app.publish(data)).status, 200);
  }
  const admin = [...app.storage.values()].filter(([key]) => key.startsWith('admin-snapshots/'));
  assert.equal(admin.length, 3);
  assert.deepEqual(admin.map(([, value]) => value.players[0].name).sort(), ['Player5', 'Player6', 'Player7']);
  assert.deepEqual((await (await app.cached()).json()).players, [{ name: 'Player7' }]);
  const historyRecords = [...app.storage.values()].filter(([key]) => key.startsWith('last-online/'));
  assert.equal(historyRecords.length, 3);
  assert.deepEqual(historyRecords.map(([, value]) => value.players[0].name).sort(), ['Player5', 'Player6', 'Player7']);
});

test('bounded cache reads retain nanosecond ordering when cleanup failed and more than six same-millisecond records remain', async () => {
  const app = setup();
  app.storage.faults.delete = true;
  for (const round of [1, 3, 4, 5, 7, 9, 10, 11, 12]) {
    const data = { ...sample(BASE, `Player${round}`),
      updatedAt: `2026-10-06T04:00:00.${String(round).padStart(9, '0')}Z` };
    assert.equal((await app.publish(data)).status, 200);
  }
  assert.equal([...app.storage.values().keys()].filter((key) => key.startsWith('admin-snapshots/')).length, 9);
  assert.deepEqual((await (await app.cached()).json()).players, [{ name: 'Player12' }]);
  assert.deepEqual((await (await app.cached()).json()).lastOnline, history(BASE, 'Player12'));
  app.storage.faults.delete = false;
  await app.publish({ ...sample(BASE, 'Player13'), updatedAt: '2026-10-06T04:00:00.000000013Z' });
  assert.deepEqual((await (await app.cached()).json()).players, [{ name: 'Player13' }]);
});

test('concurrent administrator publishes stay ordered when the older Blob write completes last', async () => {
  const app = setup();
  const started = deferred();
  const pending = deferred();
  const publisher = createStatusPublisher({ ...app.deps, getStore(options) {
    const store = app.storage.getStore(options);
    return { ...store, async setJSON(key, value, options) {
      if (key.startsWith('admin-snapshots/') && value.players[0]?.name === 'OldPlayer') {
        started.resolve();
        await pending.promise;
      }
      return store.setJSON(key, value, options);
    } };
  } });
  const publish = async (body) => { await publisher(body); return { status: 200 }; };
  const old = publish({ ...sample(BASE, 'OldPlayer'), updatedAt: '2026-10-06T04:00:00.000000001Z' });
  await started.promise;
  assert.equal((await publish({ ...sample(BASE, 'NewPlayer'), updatedAt: '2026-10-06T04:00:00.000000002Z' })).status, 200);
  pending.resolve();
  assert.equal((await old).status, 200);
  assert.deepEqual((await (await app.cached()).json()).players, [{ name: 'NewPlayer' }]);
  assert.deepEqual((await (await app.cached()).json()).lastOnline, history(BASE, 'NewPlayer'));
});

test('last online players survive empty samples, ordinary cache cleanup and a new serverless instance', async () => {
  for (const source of ['automatic', 'admin']) {
    const app = setup();
    const save = async (body) => {
      if (source === 'admin') return app.publish(body);
      app.state.responses.push(response(body));
      return app.request();
    };
    await save(sample());
    for (let round = 1; round <= 7; round += 1) {
      app.state.time += INTERVAL;
      assert.equal((await save(zero(app.state.time))).status, 200);
    }
    const ordinary = [...app.storage.values()].filter(([key]) => /^(?:admin-)?snapshots\//.test(key));
    assert.equal(ordinary.length, 3);
    assert.equal(ordinary.every(([, value]) => value.players.length === 0), true);
    const independent = createStatusHandler(app.deps);
    const result = await independent({ env: ENV,
      request: new Request('https://minecraft.example.test/api/server-status?cached=1') });
    const body = await result.json();
    assert.equal(result.status, 200);
    assert.equal(body.onlinePlayers, 0);
    assert.deepEqual(body.players, []);
    assert.deepEqual(body.lastOnline, history());
    assert.equal(app.state.probes.length, source === 'automatic' ? 8 : 0);
    assert.equal([...app.storage.values().keys()].filter((key) => key.startsWith('last-online/')).length, 1);
  }
});

test('a successful observation updates historical names even when the player count does not change', async () => {
  const app = setup();
  await app.request();
  app.state.time += INTERVAL;
  app.state.responses.push(response(sample(app.state.time, 'Steve')));
  assert.deepEqual((await (await app.request()).json()).lastOnline, history(app.state.time, 'Steve'));
  app.state.time += 1_000;
  await app.publish(sample(app.state.time, 'Builder'));
  assert.deepEqual((await (await app.cached()).json()).lastOnline, history(app.state.time, 'Builder'));
});

test('failed probes never advance the last-online timestamp, including after successful snapshots are cleaned', async () => {
  const app = setup();
  await app.request();
  for (let round = 1; round <= 5; round += 1) {
    app.state.time += INTERVAL;
    app.state.responses.push(response({}, 502));
    const body = await (await app.request()).json();
    assert.equal(body.status, 'unavailable');
    assert.equal(body.checkedAt, iso(app.state.time));
    assert.deepEqual(body.lastOnline, history());
  }
  const records = [...app.storage.values()].filter(([key]) => key.startsWith('last-online/'));
  assert.equal(records.length, 1);
  assert.equal(records[0][1].updatedAt, iso(BASE));
  assert.equal([...app.storage.values()].filter(([key]) => key.startsWith('snapshots/'))
    .every(([, value]) => value.status === 'unavailable'), true);
});

test('empty or unavailable legacy caches do not invent historical players', async () => {
  const app = setup();
  assert.equal((await (await app.cached()).json()).lastOnline, null);
  const slot = Math.floor(BASE / INTERVAL);
  const values = app.storage.values();
  values.set(`snapshots/${slot}.json`, { ...saved(), status: 'unavailable' });
  assert.equal((await (await app.cached()).json()).lastOnline, null);
  values.set(`snapshots/${slot}.json`, { status: 'online', ...zero(), checkedAt: iso(BASE) });
  assert.equal((await (await app.cached()).json()).lastOnline, null);
  assert.equal(app.state.probes.length, 0);
  assert.equal(app.storage.calls.some((call) => ['setJSON', 'delete'].includes(call.operation)), false);
});

test('existing nonempty snapshots are readable without writes and archived before a later empty publish can clean them', async () => {
  const app = setup();
  await app.cached();
  const slot = Math.floor(BASE / INTERVAL);
  const values = app.storage.values();
  values.set(`snapshots/${slot}.json`, saved(BASE - 1_000, 'LegacyPlayer'));
  values.set(`admin-snapshots/${BASE}-000000-abcdef.json`, { status: 'online', ...zero(), checkedAt: iso(BASE) });
  const before = app.storage.calls.length;
  const cached = await (await app.cached()).json();
  assert.equal(cached.onlinePlayers, 0);
  assert.deepEqual(cached.lastOnline, history(BASE - 1_000, 'LegacyPlayer'));
  assert.equal(app.storage.calls.slice(before).some((call) => ['setJSON', 'delete'].includes(call.operation)), false);
  for (let round = 1; round <= 4; round += 1) {
    app.state.time += INTERVAL;
    app.state.responses.push(response(zero(app.state.time)));
    await app.request();
  }
  assert.equal(values.has(`snapshots/${slot}.json`), false);
  assert.deepEqual((await (await app.cached()).json()).lastOnline, history(BASE - 1_000, 'LegacyPlayer'));
});

test('last-online responses strip internal and unexpected fields and reject malformed stored history', async () => {
  const app = setup();
  await app.publish(zero());
  const values = app.storage.values();
  const key = `last-online/${BASE}-000000-abcdef.json`;
  values.set(key, { players: [{ name: 'Alex', address: 'private-host', token: 'private-key' }],
    updatedAt: iso(BASE), observedAt: '2026-10-06T04:00:00.000000001Z', source: 'private-source', address: 'private-host' });
  const result = await (await app.cached()).json();
  assert.deepEqual(result.lastOnline, history());
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal(JSON.stringify(result).includes('observedAt'), false);
  for (const malformed of [
    { players: 'invalid', updatedAt: iso(BASE) },
    { players: [{ name: '\nsecret' }], updatedAt: iso(BASE) },
    { ...history(), updatedAt: 'not-a-date' },
    { ...history(), updatedAt: iso(BASE + 5_001) },
    { players: [], updatedAt: iso(BASE) },
  ]) {
    values.set(key, malformed);
    assert.equal((await (await app.cached()).json()).lastOnline, null);
  }
});

test('cache-only history reads remain pure reads for both fresh and stale data', async () => {
  const app = setup();
  await app.publish();
  for (const elapsed of [0, INTERVAL + 1]) {
    app.state.time += elapsed;
    const before = app.storage.calls.length;
    assert.deepEqual((await (await app.cached()).json()).lastOnline, history());
    assert.equal(app.storage.calls.slice(before).some((call) => ['setJSON', 'delete'].includes(call.operation)), false);
  }
  assert.equal(app.state.probes.length, 0);
});

test('history read errors preserve the main status and expose only safe diagnostics', async () => {
  for (const fault of ['historyList', 'historyGet']) {
    const app = setup();
    await app.request();
    app.state.time += 1_000;
    await app.publish(zero(app.state.time));
    app.storage.faults[fault] = true;
    const result = await app.cached();
    const body = await result.json();
    assert.equal(result.status, 200);
    assert.equal(body.onlinePlayers, 0);
    assert.deepEqual(body.lastOnline, history());
    assert.equal(JSON.stringify({ body, logs: app.state.logs }).includes('private'), false);
    assert.deepEqual(app.state.logs, [{ event: 'server_status_failure', stage: 'last-online-read', code: 'UNKNOWN_ERROR' }]);
  }
});

test('archive write failures keep current data available and defer GC until historical players are safely stored', async () => {
  for (const source of ['automatic', 'admin']) {
    const app = setup();
    app.storage.faults.historyWrite = true;
    const save = async (body) => {
      if (source === 'admin') return app.publish(body);
      app.state.responses.push(response(body));
      return app.request();
    };
    assert.equal((await save(sample())).status, 200);
    for (let round = 1; round <= 8; round += 1) {
      app.state.time += INTERVAL;
      assert.equal((await save(zero(app.state.time))).status, 200);
      assert.equal((await (await app.cached()).json()).onlinePlayers, 0);
    }
    assert.equal(app.storage.calls.some((call) => call.operation === 'delete'), false);
    assert.equal([...app.storage.values()].some(([, value]) => value.players?.[0]?.name === 'Alex'), true);
    app.storage.faults.historyWrite = false;
    app.state.time += INTERVAL;
    assert.equal((await save(zero(app.state.time))).status, 200);
    assert.deepEqual((await (await app.cached()).json()).lastOnline, history());
    assert.equal([...app.storage.values()].filter(([key]) => key.startsWith('last-online/')).length, 1);
    assert.equal(app.storage.calls.some((call) => call.operation === 'delete'), true);
    assert.equal(JSON.stringify(app.state.logs).includes('storage is down'), false);
  }
});

test('late nonempty samples can fill history without replacing a newer empty administrator sample', async () => {
  const app = setup({ clock: BASE + 1_000 });
  await app.publish(zero(app.state.time));
  await app.publish(sample(BASE, 'LatePlayer'));
  const body = await (await app.cached()).json();
  assert.equal(body.onlinePlayers, 0);
  assert.deepEqual(body.lastOnline, history(BASE, 'LatePlayer'));
});

test('automatic history uses the probe observation time with nanosecond precision, not completion time', async () => {
  const started = deferred();
  const pending = deferred();
  const app = setup({ probe: async () => { started.resolve(); return pending.promise; } });
  const automatic = app.request();
  await started.promise;
  app.state.time += 1_000;
  await app.publish({ ...sample(BASE, 'NewPlayer'), updatedAt: '2026-10-06T04:00:00.000000002Z' });
  pending.resolve(response({ ...sample(BASE, 'OldPlayer'), updatedAt: '2026-10-06T04:00:00.000000001Z' }));
  const body = await (await automatic).json();
  assert.deepEqual(body.lastOnline, history(BASE, 'NewPlayer'));
  assert.deepEqual((await (await app.cached()).json()).lastOnline, history(BASE, 'NewPlayer'));
});

test('concurrent cleanup archives a nonempty sample written after its initial read before deleting it', async () => {
  const storage = memory();
  const started = deferred();
  const pending = deferred();
  let waiting = 0;
  const controlled = { ...storage, getStore(options) {
    const store = storage.getStore(options);
    return { ...store, async setJSON(key, value, options) {
      if (key.startsWith('admin-snapshots/') && value.onlinePlayers === 0) {
        waiting += 1;
        if (waiting === 4) started.resolve();
        await pending.promise;
      }
      return store.setJSON(key, value, options);
    } };
  } };
  const app = setup({ clock: BASE + 5_000, storage: controlled });
  const emptyPublishes = [1, 2, 3, 4].map((round) => app.publish(zero(BASE + round * 1_000)));
  await started.promise;
  storage.faults.historyWrite = true;
  assert.equal((await app.publish(sample())).status, 200);
  storage.faults.historyWrite = false;
  pending.resolve();
  assert.equal((await Promise.all(emptyPublishes)).every((result) => result.status === 200), true);
  const body = await (await app.cached()).json();
  assert.equal(body.onlinePlayers, 0);
  assert.deepEqual(body.lastOnline, history());
  const ordinary = [...storage.values()].filter(([key]) => key.startsWith('admin-snapshots/'));
  assert.equal(ordinary.every(([, value]) => value.onlinePlayers === 0), true);
});
