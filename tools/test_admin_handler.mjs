// Run: node --test tools/test_admin_handler.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac } from 'node:crypto';
import { createAdminHandler } from '../web/lib/admin/handler.mjs';
import { AuthManager } from '../web/lib/admin/auth.mjs';
import { loadAdminConfig } from '../web/lib/admin/config.mjs';
import { PASSWORD, startFakeRcon } from './fake_rcon.mjs';

const ADMIN_KEY = 'admin-key-for-tests-0123456789-abcdefghij';
const ORIGIN = 'https://minecraft.example.test';
const ONLINE = 'There are 2 of a max of 20 players online: steve, Alex';

// A tiny stateful game server behind the real RCON wire protocol.
function game() {
  const state = { whitelist: ['Alex'], difficulty: 'Normal', slow: null, fail: new Set() };
  const respond = async (command) => {
    if (state.slow && command.startsWith(state.slow.prefix)) await state.slow.gate;
    for (const prefix of state.fail) if (command.startsWith(prefix)) return 'Unexpected localized output';
    const list = () => (state.whitelist.length
      ? `There are ${state.whitelist.length} whitelisted player(s): ${state.whitelist.join(', ')}`
      : 'There are no whitelisted players');
    if (command === 'list') return ONLINE;
    if (command === 'whitelist list') return list();
    const add = /^whitelist add (\w+)$/.exec(command);
    if (add) { state.whitelist.push(add[1]); return `Added ${add[1]} to the whitelist`; }
    const remove = /^whitelist remove (\w+)$/.exec(command);
    if (remove) { state.whitelist = state.whitelist.filter((n) => n !== remove[1]); return 'Removed'; }
    if (command === 'time query minecraft:day') return 'Timeline minecraft:day is at 1234 tick(s)';
    if (command === 'difficulty') return `The difficulty is ${state.difficulty}`;
    if (command.startsWith('execute in')) return 'The nearest minecraft:mansion is at [900, ~, -400] (100 blocks away)';
    if (command === 'banlist players') return 'There are no bans';
    if (command === 'save-all flush') return 'Saving the game (this may take a moment!)Saved the game';
    return '';
  };
  return { state, respond };
}

// Structured log lines go to the console; capture them per test (and keep the
// test output quiet). Calling it twice in one test returns the same buffer.
const captures = new WeakMap();
function captureConsole(t) {
  if (captures.has(t)) return captures.get(t);
  const lines = [];
  const originals = {};
  for (const name of ['log', 'warn', 'error']) {
    originals[name] = console[name];
    console[name] = (line) => { try { lines.push(JSON.parse(line)); } catch { /* not ours */ } };
  }
  t.after(() => Object.assign(console, originals));
  captures.set(t, lines);
  return lines;
}

async function setup(t, { env = {}, publish, now = Date.now, gameOptions } = {}) {
  captureConsole(t);
  const sim = game();
  const rcon = await startFakeRcon({ respond: sim.respond, ...gameOptions });
  t.after(() => rcon.close());
  const fullEnv = { ADMIN_KEY, RCON_HOST: '127.0.0.1', RCON_PORT: String(rcon.port), RCON_PASSWORD: PASSWORD, ...env };
  const handler = createAdminHandler({ publish, now });
  const context = { env: fullEnv, server: { requestId: 'req-1', region: 'ap-test' }, clientIp: '203.0.113.9' };
  const send = async (path, { method = 'GET', body, cookie, csrf, headers = {}, origin = ORIGIN, raw } = {}) => {
    const init = { method, headers: { Origin: origin, 'Sec-Fetch-Site': 'same-origin', ...headers } };
    if (cookie) init.headers.Cookie = cookie;
    if (csrf) init.headers['X-CSRF-Token'] = csrf;
    if (body !== undefined || raw !== undefined) {
      init.body = raw ?? JSON.stringify(body);
      init.headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
    }
    return handler({ ...context, request: new Request(`${ORIGIN}${path}`, init) });
  };
  const login = async (key = ADMIN_KEY) => {
    const response = await send('/admin/auth/login', { method: 'POST', body: { key } });
    const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
    const data = await response.clone().json();
    return { response, cookie, csrf: data.csrfToken };
  };
  return { sim: sim.state, rcon, send, login, handler, fullEnv, context };
}

test('missing or invalid configuration returns 503 naming variables but never values', async (t) => {
  const lines = captureConsole(t);
  const secret = 'short-secret-value';
  for (const [env, pattern] of [
    [{ ADMIN_KEY: '' }, /ADMIN_KEY/],
    [{ RCON_HOST: '' }, /RCON_HOST/],
    [{ ADMIN_KEY: PASSWORD }, /不同的密钥/],
    [{ RCON_PORT: '70000' }, /RCON_PORT/],
    [{ RCON_PASSWORD: secret }, /RCON 配置格式错误/],
    [{ ADMIN_KEY: secret }, /至少需要 32 字节/],
  ]) {
    const app = await setup(t, { env });
    const response = await app.send('/admin/api/session');
    const text = await response.text();
    assert.equal(response.status, 503);
    assert.equal(JSON.parse(text).error.code, 'admin_not_configured');
    assert.match(JSON.parse(text).error.message, pattern);
    assert.equal(text.includes(secret) || text.includes(PASSWORD) || text.includes(ADMIN_KEY), false);
  }
  const text = JSON.stringify(lines);
  assert.equal(text.includes(secret) || text.includes(PASSWORD) || text.includes(ADMIN_KEY), false);
  assert.ok(lines.some((line) => line.event === 'admin_not_configured'));
});

test('browser workflow: login, session, whitelist change, logout, with security headers', async (t) => {
  const app = await setup(t);
  let response = await app.send('/admin/api/session');
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);

  const session = await app.login();
  assert.equal(session.response.status, 200);
  const cookie = session.response.headers.get('set-cookie');
  assert.match(cookie, /^mvs_makers_admin=/);
  for (const attribute of ['Path=/admin', 'HttpOnly', 'Secure', 'SameSite=Strict', 'Max-Age=86400']) {
    assert.ok(cookie.includes(attribute), attribute);
  }
  response = await app.send('/admin/api/session', { cookie: session.cookie });
  assert.deepEqual((await response.json()).user, { subject: 'admin', name: '管理员' });

  response = await app.send('/admin/api/whitelist', { cookie: session.cookie });
  assert.deepEqual((await response.json()).players, [{ name: 'Alex' }]);
  response = await app.send('/admin/api/whitelist', { method: 'POST', cookie: session.cookie, csrf: session.csrf, body: { name: 'Zed' } });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).players, [{ name: 'Alex' }, { name: 'Zed' }]);
  response = await app.send('/admin/api/whitelist/Zed', { method: 'DELETE', cookie: session.cookie, csrf: session.csrf });
  assert.deepEqual((await response.json()).players, [{ name: 'Alex' }]);

  response = await app.send('/admin/auth/logout', { method: 'POST', cookie: session.cookie, csrf: session.csrf });
  assert.equal(response.status, 204);
  assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
});

test('the platform may or may not strip the /admin prefix', async (t) => {
  const app = await setup(t);
  const { cookie } = await app.login();
  for (const path of ['/admin/api/session', '/api/session']) {
    assert.equal((await app.send(path, { cookie })).status, 200, path);
  }
  const redirect = await app.send('/admin');
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get('location'), '/admin/');
});

test('writes reject forged origins, missing CSRF, bad content and injection attempts', async (t) => {
  const app = await setup(t);
  const { cookie, csrf } = await app.login();
  const post = (body, options = {}) => app.send('/admin/api/whitelist', { method: 'POST', cookie, csrf, body, ...options });
  assert.equal((await post({ name: 'Zed' }, { csrf: undefined })).status, 403);
  assert.equal((await post({ name: 'Zed' }, { csrf: 'x'.repeat(43) })).status, 403);
  assert.equal((await post({ name: 'Zed' }, { origin: 'https://evil.example.test' })).status, 403);
  assert.equal((await post({ name: 'Zed' }, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await post({ name: 'Zed' }, { headers: { 'Content-Type': 'text/plain' } })).status, 400);
  assert.equal((await post({ name: 'Zed', extra: 1 })).status, 400);
  assert.equal((await post({ name: 5 })).status, 400);
  assert.equal((await post({ name: 'Zed\nop Zed' })).status, 400);
  assert.equal((await post({ name: '@a' })).status, 400);
  assert.equal((await post(undefined, { raw: '{"name":"Zed"} {"name":"Y"}' })).status, 400);
  assert.equal((await post(undefined, { raw: JSON.stringify({ name: 'x'.repeat(3000) }) })).status, 400);
  assert.equal(app.rcon.commands.some((command) => command.startsWith('whitelist add')), false);
});

test('upstream failures never leak secrets or claim success', async (t) => {
  const lines = captureConsole(t);
  const app = await setup(t);
  const { cookie, csrf } = await app.login();
  app.sim.fail.add('whitelist');
  let response = await app.send('/admin/api/whitelist', { cookie });
  let text = await response.text();
  assert.equal(response.status, 502);
  assert.equal(JSON.parse(text).error.code, 'server_unavailable');
  response = await app.send('/admin/api/whitelist', { method: 'POST', cookie, csrf, body: { name: 'Zed' } });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, 'mutation_unconfirmed');
  const joined = JSON.stringify(lines);
  assert.equal(joined.includes(PASSWORD) || joined.includes(ADMIN_KEY) || joined.includes('localized'), false);
  assert.ok(lines.some((line) => line.event === 'admin_audit' && line.phase === 'unconfirmed' && line.code));
  assert.equal(text.includes('Unexpected'), false);
});

test('overview publishes the public subset and reports synchronization honestly', async (t) => {
  const published = [];
  const app = await setup(t, { publish: async (snapshot) => { published.push(snapshot); } });
  const { cookie } = await app.login();
  let response = await app.send('/admin/api/overview', { cookie });
  let body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.server, { players: [{ name: 'Alex' }, { name: 'steve' }], maxPlayers: 20, dayTime: 1234 });
  assert.equal(body.publicStatusSynced, true);
  assert.match(body.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{9}Z$/);
  assert.deepEqual(published[0], {
    players: [{ name: 'Alex' }, { name: 'steve' }], onlinePlayers: 2, maxPlayers: 20, updatedAt: body.updatedAt,
  });

  const failing = await setup(t, { publish: async () => { throw Object.assign(new Error('storage'), { code: 'COS_ERROR' }); } });
  const second = await failing.login();
  body = await (await failing.send('/admin/api/overview', { cookie: second.cookie })).json();
  assert.equal(body.publicStatusSynced, false);
  assert.equal(body.server.players.length, 2);

  const noStore = await setup(t);
  const third = await noStore.login();
  assert.equal((await (await noStore.send('/admin/api/overview', { cookie: third.cookie })).json()).publicStatusSynced, false);
});

test('daily actions need exact acknowledgements and fixed parameters', async (t) => {
  const app = await setup(t);
  const { cookie, csrf } = await app.login();
  const act = (kind, body) => app.send(`/admin/api/actions/${kind}`, { method: 'POST', cookie, csrf, body });
  let response = await act('save', {});
  assert.equal(response.status, 200);
  assert.match((await response.json()).message, /存档保存完成/);
  assert.equal((await act('stop', {})).status, 400);
  assert.equal((await act('kick', { player: 'Alex', message: 'x' })).status, 400);
  assert.equal((await act('announce', { message: 'a\nb' })).status, 400);
  assert.equal((await act('weather', { value: 'rain', seconds: '60' })).status, 400);
  app.sim.fail.add('save-all');
  response = await act('save', {});
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, 'mutation_unconfirmed');
  assert.equal((await app.send('/admin/api/actions/save', { method: 'POST', cookie, body: {} })).status, 403);
});

test('writes share one lock and a second concurrent write is rejected, not queued', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const app = await setup(t);
  app.sim.slow = { prefix: 'whitelist add', gate };
  const { cookie, csrf } = await app.login();
  const first = app.send('/admin/api/whitelist', { method: 'POST', cookie, csrf, body: { name: 'Zed' } });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const second = await app.send('/admin/api/actions/save', { method: 'POST', cookie, csrf, body: {} });
  assert.equal(second.status, 409);
  assert.equal((await second.json()).error.code, 'operation_in_progress');
  release();
  assert.equal((await first).status, 200);
  assert.equal((await app.send('/admin/api/actions/save', { method: 'POST', cookie, csrf, body: {} })).status, 200);
});

test('settings, game rules, players and bans enforce session, validation and fixed shapes', async (t) => {
  const app = await setup(t);
  assert.equal((await app.send('/admin/api/settings')).status, 401);
  assert.equal((await app.send('/admin/api/gamerules')).status, 401);
  assert.equal((await app.send('/admin/api/bans')).status, 401);
  const { cookie, csrf } = await app.login();
  assert.deepEqual((await (await app.send('/admin/api/settings', { cookie })).json()).settings, { difficulty: 'normal' });
  const patch = (path, body) => app.send(path, { method: 'PATCH', cookie, csrf, body });
  assert.equal((await patch('/admin/api/settings/pvp', { value: 'x' })).status, 400);
  assert.equal((await patch('/admin/api/settings/difficulty', { value: 'cruel' })).status, 400);
  assert.equal((await patch('/admin/api/settings/difficulty', {})).status, 400);
  assert.equal((await patch('/admin/api/gamerules/keepInventory', { value: 'true' })).status, 400);
  assert.equal((await patch('/admin/api/gamerules/unknown', { value: true })).status, 400);
  assert.equal((await app.send('/admin/api/players/bad%20name', { cookie })).status, 400);
  assert.equal((await app.send('/admin/api/players/%E0%A4%A', { cookie })).status, 400);
  const ban = (body) => app.send('/admin/api/bans', { method: 'POST', cookie, csrf, body });
  for (const body of [{ name: 'Alex' }, { name: 'Alex', reason: '' }, { name: 'Alex', reason: '@a' }, { name: 'Alex', reason: 'x\ny' }]) {
    assert.equal((await ban(body)).status, 400, JSON.stringify(body));
  }
  assert.deepEqual((await (await app.send('/admin/api/bans', { cookie })).json()).bans, { count: 0, rawOutput: 'There are no bans' });
});

test('structure lookup is CSRF-protected, validated, single-flight and cooled down', async (t) => {
  let clock = Date.parse('2026-10-08T00:00:00Z');
  const app = await setup(t, { now: () => clock });
  const { cookie, csrf } = await app.login();
  const locate = (body, options = {}) => app.send('/admin/api/locate', { method: 'POST', cookie, csrf, body, ...options });
  assert.equal((await locate({ structure: 'mansion', x: 0, z: 0 }, { csrf: undefined })).status, 403);
  assert.equal((await locate({ structure: 'mansion', x: 'a', z: 0 })).status, 400);
  assert.equal((await locate({ structure: 'mansion', z: 0 })).status, 400);
  let response = await locate({ structure: 'ocean_ruin', x: 0, z: 0 });
  assert.equal(response.status, 400);
  response = await locate({ structure: 'mansion', originDimension: 'minecraft:the_end', x: 0, z: 0 });
  assert.match((await response.json()).error.message, /末地坐标/);
  assert.equal(app.rcon.opened, 0); // validation never needs the game server
  const before = app.rcon.commands.length;
  response = await locate({ structure: 'mansion', originDimension: 'minecraft:the_nether', x: 100, z: -50 });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.result.searchOrigin, { dimension: 'minecraft:overworld', x: 800, z: -400 });
  assert.equal(app.rcon.commands.length, before + 1);
  response = await locate({ structure: 'mansion', x: 0, z: 0 });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '30');
  clock += 31_000;
  assert.equal((await locate({ structure: 'mansion', x: 0, z: 0 })).status, 200);
  clock += 31_000;
  app.sim.fail.add('execute in');
  assert.equal((await locate({ structure: 'mansion', x: 0, z: 0 })).status, 502);
  assert.equal((await locate({ structure: 'mansion', x: 0, z: 0 })).status, 429); // failures cool down too
});

test('unknown paths are 404 and wrong methods are 405 with Allow', async (t) => {
  const app = await setup(t);
  assert.equal((await app.send('/admin/api/nothing')).status, 404);
  const response = await app.send('/admin/api/whitelist', { method: 'PUT', body: {} });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET, POST');
});

test('failed logins are limited per instance and audited without the key', async (t) => {
  const lines = captureConsole(t);
  const app = await setup(t);
  for (let attempt = 0; attempt < 10; attempt += 1) assert.equal((await app.login('wrong-key-wrong-key-wrong-key-wrong')).response.status, 401);
  const limited = await app.login('wrong-key-wrong-key-wrong-key-wrong');
  assert.equal(limited.response.status, 429);
  assert.ok(Number(limited.response.headers.get('retry-after')) > 0);
  assert.equal((await app.login()).response.status, 429); // even the right key waits
  const text = JSON.stringify(lines);
  assert.equal(text.includes('wrong-key') || text.includes(ADMIN_KEY), false);
  const failure = lines.find((line) => line.event === 'admin_login' && line.outcome === 'bad_key');
  assert.equal(failure.ip, '203.0.113.9');
});

test('every request logs one structured line with the request id and no secrets', async (t) => {
  const lines = captureConsole(t);
  const app = await setup(t);
  const { cookie, csrf } = await app.login();
  await app.send('/admin/api/whitelist', { method: 'POST', cookie, csrf, body: { name: 'Zed' } });
  const requests = lines.filter((line) => line.event === 'admin_request');
  assert.deepEqual(requests.map((line) => `${line.method} ${line.route} ${line.status}`),
    ['POST /auth/login 200', 'POST /api/whitelist 200']);
  for (const line of requests) {
    assert.equal(line.requestId, 'req-1');
    assert.equal(line.region, 'ap-test');
    assert.equal(line.component, 'admin');
    assert.equal(line.level, 'info');
    assert.equal(typeof line.elapsedMs, 'number');
    assert.match(line.ts, /^\d{4}-\d{2}-\d{2}T/);
  }
  assert.ok(lines.some((line) => line.event === 'rcon_operation' && line.operation === 'whitelist_add' && line.ok));
  const text = JSON.stringify(lines);
  for (const secret of [ADMIN_KEY, PASSWORD, cookie.split('=')[1], csrf]) assert.equal(text.includes(secret), false);
});

test('LOG_LEVEL=debug explains rejected sessions without exposing tokens', async (t) => {
  const lines = captureConsole(t);
  const app = await setup(t, { env: { LOG_LEVEL: 'debug' } });
  await app.send('/admin/api/session', { cookie: 'mvs_makers_admin=abc.def' });
  assert.ok(lines.some((line) => line.event === 'admin_session_rejected' && line.cause === 'malformed'));
  assert.equal(JSON.stringify(lines).includes('abc.def'), false);
});

test('community sessions honor their signing format, expiry and key rotation', () => {
  let clock = Date.parse('2026-10-08T00:00:00Z');
  const manager = new AuthManager({ key: ADMIN_KEY, now: () => clock });
  // Re-derive the cookie independently from the documented format.
  const signingKey = createHmac('sha256', ADMIN_KEY).update('minecraft-vanilla-stack/makers-admin-key/v2\0/admin').digest();
  const csrf = Buffer.alloc(32, 7).toString('base64url');
  const nonce = Buffer.alloc(32, 9).toString('base64url');
  const issued = clock / 1000;
  const encoded = Buffer.from(JSON.stringify({ v: 2, iat: issued, exp: issued + 86400, nonce, csrf, origin: ORIGIN })).toString('base64url');
  const signature = createHmac('sha256', signingKey).update('minecraft-vanilla-stack/makers-admin-cookie/v2\0').update(encoded).digest('base64url');
  const request = (token) => new Request(`${ORIGIN}/admin/api/session`, { headers: { Cookie: `mvs_makers_admin=${token}` } });
  assert.equal(manager.session(request(`${encoded}.${signature}`))?.csrfToken, csrf);
  assert.equal(manager.session(request(`${encoded}.${signature.slice(0, -1)}A`)), null);
  assert.equal(manager.session(request(`${encoded}x.${signature}`)), null);
  assert.equal(new AuthManager({ key: `${ADMIN_KEY}-rotated`, now: () => clock }).session(request(`${encoded}.${signature}`)), null);
  clock += 86_400_000;
  assert.equal(manager.session(request(`${encoded}.${signature}`)), null);
  assert.throws(() => new AuthManager({ key: 'x'.repeat(31) }), /32 bytes/);
  assert.throws(() => new AuthManager({ key: ' '.repeat(40) }), /32 bytes/);
  // Duplicate cookies are ambiguous and rejected.
  clock = issued * 1000;
  const duplicate = new Request(`${ORIGIN}/admin/api/session`, { headers: { Cookie: `mvs_makers_admin=${encoded}.${signature}; mvs_makers_admin=${encoded}.${signature}` } });
  assert.equal(manager.session(duplicate), null);
});

test('origin rules: HTTPS or loopback only, no path, host fallback when Fetch Metadata is absent', () => {
  const manager = new AuthManager({ key: ADMIN_KEY });
  const origin = (value, headers = {}, url = `${ORIGIN}/admin/auth/login`) =>
    manager.requestOrigin(new Request(url, { method: 'POST', headers: { Origin: value, ...headers } }));
  assert.equal(origin(ORIGIN, { 'Sec-Fetch-Site': 'same-origin' })?.secure, true);
  assert.equal(origin('http://127.0.0.1:8088', { 'Sec-Fetch-Site': 'same-origin' }, 'http://127.0.0.1:8088/x')?.secure, false);
  assert.ok(origin('http://localhost:8088', { 'Sec-Fetch-Site': 'same-origin' }));
  for (const bad of ['http://minecraft.example.test', `${ORIGIN}/`, `${ORIGIN}/path`, 'https://user@minecraft.example.test', 'ftp://x.test', 'null', '']) {
    assert.equal(origin(bad, { 'Sec-Fetch-Site': 'same-origin' }), null, bad);
  }
  assert.equal(origin(ORIGIN, { 'Sec-Fetch-Site': 'cross-site' }), null);
  assert.equal(origin(ORIGIN, { 'Sec-Fetch-Site': 'same-site' }), null);
  assert.ok(origin(ORIGIN, { Host: 'minecraft.example.test' }));
  assert.equal(origin(ORIGIN, { Host: 'evil.example.test' }), null);
  assert.equal(origin(ORIGIN, { 'X-Forwarded-Host': 'minecraft.example.test', Host: 'evil.example.test' }), null);
});

test('config loader accepts the documented variables', () => {
  const config = loadAdminConfig({ ADMIN_KEY, RCON_HOST: 'mc.example.test', RCON_PASSWORD: PASSWORD });
  assert.equal(config.rcon.port, 25575);
  assert.equal(config.rcon.host, 'mc.example.test');
});
