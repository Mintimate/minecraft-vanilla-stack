// HTTP API of the administration console, mounted at /admin/*. Every response
// is a fixed JSON shape; there is no arbitrary-command endpoint. The static page
// (admin/index.html) is served by Makers as a public asset, not by this handler.
import { createLogger, parseLogLevel, requestContext } from '../log.mjs';
import { nowRfc3339Micro } from '../time.mjs';
import { AuthManager, mediaType } from './auth.mjs';
import { ConfigError, loadAdminConfig, loadRconConfig } from './config.mjs';
import {
  ERR, isRconError, RconClient, validateAction, validateBan, validateGameRule,
  validateLocateRequest, validatePlayerName, validateSetting,
} from './rcon.mjs';
import { describeError } from './rcon-protocol.mjs';

const PREFIX = '/admin';
const MAX_JSON_BODY = 2048;
const LOCATE_COOLDOWN_MS = 30_000;
const PUBLISH_TIMEOUT_MS = 3_000;
const SECURITY_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: https://minotar.net; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
});

const sorted = (players) => [...players].sort((a, b) => {
  const left = a.name.toLowerCase();
  const right = b.name.toLowerCase();
  return left < right ? -1 : left > right ? 1 : 0;
});
const stamp = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

function respond(status, value, headers) {
  return new Response(JSON.stringify(value), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8', ...headers,
  } });
}

function failure(status, code, message, headers) {
  return respond(status, { error: { code, message } }, headers);
}

// Decodes a small JSON object: application/json, bounded size, no unknown
// fields and each present field of the declared type. Absent and null fields
// are treated as omitted.
async function decodeJson(request, fields) {
  if (mediaType(request) !== 'application/json') throw new Error('JSON required');
  const text = await request.text();
  if (Buffer.byteLength(text) > MAX_JSON_BODY) throw new Error('body too large');
  const value = JSON.parse(text);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
  for (const [name, item] of Object.entries(value)) {
    const check = fields[name];
    if (!check) throw new Error('unknown field');
    if (item !== null && item !== undefined && !check(item)) throw new Error('invalid field type');
  }
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null));
}

const isString = (value) => typeof value === 'string';
const isInteger = (value) => typeof value === 'number' && Number.isSafeInteger(value);
const isAny = () => true;

function withTimeout(promise, milliseconds) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), milliseconds); }),
  ]).finally(() => clearTimeout(timer));
}

// The subset of an overview that visitors may see; everything else stays private.
export function publicStatusSnapshot(status, updatedAt) {
  const players = sorted(status.players);
  return {
    players: players.map((player) => ({ name: player.name })),
    onlinePlayers: players.length,
    maxPlayers: status.maxPlayers,
    updatedAt,
  };
}

// Reads the online list over RCON for the visitor status cache.
export function createOnlineProbe({ logger = createLogger({ component: 'status' }) } = {}) {
  return async function probe(env) {
    let config;
    try { config = loadRconConfig(env); }
    catch (error) {
      logger.warn('status_probe_unconfigured', { code: error?.code });
      throw Object.assign(new Error('RCON is not configured'), { code: 'STATUS_PROBE_NOT_CONFIGURED' });
    }
    const updatedAt = nowRfc3339Micro();
    const status = await new RconClient(config, logger).onlinePlayers();
    return publicStatusSnapshot(status, updatedAt);
  };
}

// `publish` stores an administrator observation for visitors (optional).
export function createAdminHandler({ publish, now = Date.now } = {}) {
  // Per warm instance only; these are not distributed locks or rate limits.
  let mutating = false;
  const locate = { busy: false, next: 0 };
  let runtime = null;

  // Config is validated on every request but derived objects are cached so the
  // failed-login limiter survives across requests while the key is unchanged.
  function resolveRuntime(env) {
    const config = loadAdminConfig(env);
    const signature = `${config.adminKey}\0${config.rcon.host}\0${config.rcon.port}\0${config.rcon.password}`;
    if (runtime?.signature !== signature) {
      runtime = { signature, config, auth: new AuthManager({ key: config.adminKey, now }) };
    }
    return runtime;
  }

  return async function onRequest(context) {
    const started = performance.now();
    const { request } = context;
    const env = context.env ?? {};
    const log = createLogger({
      component: 'admin', level: parseLogLevel(env.LOG_LEVEL), context: requestContext(context),
    });
    let routeName = 'unmatched';
    let response;
    try {
      response = await dispatch(context, env, log, (name) => { routeName = name; });
    } catch (error) {
      // Names and codes only: messages can embed values from the environment.
      log.error('admin_unhandled', { route: routeName, errorName: error?.name, ...describeError(error) });
      response = failure(500, 'internal_error', '服务暂时不可用，请稍后重试或查看云函数日志。');
    }
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      if (!response.headers.has(name)) response.headers.set(name, value);
    }
    const status = response.status;
    const quietUnauthorized = routeName === '/api/session' && status === 401;
    log[status >= 500 ? 'error' : status >= 400 && !quietUnauthorized ? 'warn' : 'info']('admin_request', {
      method: request.method, route: routeName, status, elapsedMs: Math.round(performance.now() - started),
    });
    return response;
  };

  async function dispatch(context, env, log, name) {
    const { request } = context;
    let pathname;
    try { pathname = new URL(request.url).pathname; } catch { return failure(400, 'invalid_request', '请求地址无效。'); }
    // The platform may or may not strip the /admin mount prefix; accept both.
    if (pathname === PREFIX) return new Response(null, { status: 308, headers: { Location: `${PREFIX}/` } });
    const path = pathname.startsWith(`${PREFIX}/`) ? pathname.slice(PREFIX.length) : pathname;

    let state;
    try { state = resolveRuntime(env); }
    catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      log.error('admin_not_configured', { code: error.code });
      return failure(503, 'admin_not_configured', error.message);
    }
    const { auth, config } = state;
    const method = request.method;
    const ctx = { request, log, auth, client: () => new RconClient(config.rcon, log) };

    const routes = [
      ['POST', /^\/auth\/login$/, '/auth/login', () => auth.login(request, withIp(log, context))],
      ['POST', /^\/auth\/logout$/, '/auth/logout', () => auth.logout(request, log)],
      ['GET', /^\/api\/session$/, '/api/session', () => sessionInfo(ctx)],
      ['GET', /^\/api\/whitelist$/, '/api/whitelist', () => listWhitelist(ctx)],
      ['POST', /^\/api\/whitelist$/, '/api/whitelist', () => addWhitelist(ctx)],
      ['DELETE', /^\/api\/whitelist\/([^/]+)$/, '/api/whitelist/:name', (m) => removeWhitelist(ctx, m[1])],
      ['GET', /^\/api\/settings$/, '/api/settings', () => readSettings(ctx)],
      ['PATCH', /^\/api\/settings\/([^/]+)$/, '/api/settings/:key', (m) => changeSetting(ctx, m[1])],
      ['GET', /^\/api\/overview$/, '/api/overview', () => overview(ctx)],
      ['POST', /^\/api\/actions\/([^/]+)$/, '/api/actions/:action', (m) => runAction(ctx, m[1])],
      ['GET', /^\/api\/gamerules$/, '/api/gamerules', () => readGameRules(ctx)],
      ['PATCH', /^\/api\/gamerules\/([^/]+)$/, '/api/gamerules/:key', (m) => changeGameRule(ctx, m[1])],
      ['GET', /^\/api\/players\/([^/]+)$/, '/api/players/:name', (m) => playerDetails(ctx, m[1])],
      ['POST', /^\/api\/locate$/, '/api/locate', () => locateStructure(ctx)],
      ['GET', /^\/api\/bans$/, '/api/bans', () => readBans(ctx)],
      ['POST', /^\/api\/bans$/, '/api/bans', () => banPlayer(ctx)],
      ['DELETE', /^\/api\/bans\/([^/]+)$/, '/api/bans/:name', (m) => pardonPlayer(ctx, m[1])],
    ];
    const allowed = new Set();
    for (const [routeMethod, pattern, label, run] of routes) {
      const found = pattern.exec(path);
      if (!found) continue;
      if (routeMethod !== method) { allowed.add(routeMethod); continue; }
      name(label);
      const params = found.map((value, index) => (index === 0 ? value : decodeParam(value)));
      if (params.includes(null)) return failure(400, 'invalid_request', '请求路径包含无效字符。');
      return run(params);
    }
    if (allowed.size) {
      name('(method not allowed)');
      return failure(405, 'method_not_allowed', '此接口不支持该请求方法。', { Allow: [...allowed].join(', ') });
    }
    return failure(404, 'not_found', '接口不存在。');
  }

  function decodeParam(value) {
    try { return decodeURIComponent(value); } catch { return null; }
  }

  // Attach the client address to authentication events only: it is the one
  // place where a source address helps spot guessing against the admin key.
  function withIp(log, context) {
    const ip = typeof context.clientIp === 'string' && /^[0-9a-fA-F:.]{3,45}$/.test(context.clientIp)
      ? context.clientIp : undefined;
    return ip ? log.child({ ip }) : log;
  }

  // Returns { session } or { response }. Mutating requests also need the
  // matching Origin and CSRF token.
  function authenticate({ request, auth, log }, mutation) {
    const session = auth.session(request, log);
    if (!session) return { response: failure(401, 'unauthorized', '请先登录') };
    if (mutation && !auth.checkMutation(request, session)) {
      log.warn('admin_csrf_rejected', { method: request.method });
      return { response: failure(403, 'csrf_rejected', '请求校验失败，请刷新页面后重试') };
    }
    return { session };
  }

  // Reject concurrent writes instead of queuing a line of stale operations.
  async function exclusive(busyMessage, run) {
    if (mutating) return failure(409, 'operation_in_progress', busyMessage);
    mutating = true;
    try { return await run(); } finally { mutating = false; }
  }

  function audit(log, operation, phase, session, fields) {
    // Fixed operation names and validated identifiers only; never announcement
    // text, ban reasons or raw server output.
    log[phase === 'unconfirmed' ? 'warn' : 'info']('admin_audit', {
      operation, phase, actor: session.subject, ...fields,
    });
  }

  async function sessionInfo(ctx) {
    const auth = authenticate(ctx, false);
    if (auth.response) return auth.response;
    const { session } = auth;
    return respond(200, {
      authenticated: true, user: { subject: session.subject, name: session.name }, csrfToken: session.csrfToken,
    });
  }

  async function listWhitelist(ctx) {
    const auth = authenticate(ctx, false);
    if (auth.response) return auth.response;
    try {
      const status = await ctx.client().status();
      return respond(200, { players: sorted(status.players), updatedAt: stamp() });
    } catch {
      return failure(502, 'server_unavailable', '无法读取游戏服状态，请检查管理接口连接后刷新。');
    }
  }

  async function overview(ctx) {
    const auth = authenticate(ctx, false);
    if (auth.response) return auth.response;
    // Compare snapshots by the start of their observation, so a slow older read
    // cannot overwrite a newer administrator refresh when it completes later.
    const updatedAt = nowRfc3339Micro();
    let status;
    try { status = await ctx.client().overview(); }
    catch { return failure(502, 'server_unavailable', '无法读取在线玩家与主世界时间，请检查 RCON 连接后刷新。'); }
    status = { ...status, players: sorted(status.players) };
    let publicStatusSynced = false;
    if (publish) {
      try {
        await withTimeout(publish(publicStatusSnapshot(status, updatedAt)), PUBLISH_TIMEOUT_MS);
        publicStatusSynced = true;
      } catch (error) {
        // The authenticated result stays usable. publish() already logged the
        // coded cause; this records only that the visitor snapshot is stale.
        ctx.log.warn('public_status_sync', { outcome: 'failed', code: error?.code ?? 'timeout' });
      }
    }
    return respond(200, { server: status, updatedAt, publicStatusSynced });
  }

  async function runAction(ctx, kind) {
    const auth = authenticate(ctx, true);
    if (auth.response) return auth.response;
    const { session } = auth;
    let action;
    try {
      action = await decodeJson(ctx.request, {
        player: isString, target: isString, message: isString, value: isString, seconds: isInteger,
      });
    } catch { return failure(400, 'invalid_action', '操作参数格式不正确。'); }
    action.kind = kind;
    try { validateAction(action); }
    catch {
      return failure(400, 'invalid_action',
        '操作或参数不在允许范围内，请使用页面提供的选项。公告最多 160 个字符、512 字节，不能包含换行或控制字符。');
    }
    return exclusive('另一项修改正在进行，请完成后刷新再操作。', async () => {
      const fields = { action: action.kind, player: action.player, target: action.target };
      audit(ctx.log, 'server_action', 'requested', session, fields);
      try {
        await ctx.client().execute(action);
      } catch (error) {
        audit(ctx.log, 'server_action', 'unconfirmed', session, { action: action.kind, ...describeError(error) });
        if (isRconError(error, ERR.NO_PLAYERS)) {
          return failure(409, 'no_players', '目标玩家已离线，或当前没有在线玩家。请刷新在线列表。');
        }
        return failure(502, 'mutation_unconfirmed',
          '未能确认操作结果，服务器可能已经执行。请先核对游戏内状态；保存世界还需检查服务端日志，不要自动重复提交。');
      }
      const messages = {
        announce: '服务器已接受公告，实际显示请以在线玩家客户端为准。',
        kick: '已确认该玩家不在当前在线列表中；本操作不封禁，玩家仍可重新连接。',
        time: '主世界时间预设已设置，时间仍会按游戏规则继续推进。',
        weather: '服务器已确认天气指令；具体降水表现取决于所在维度和生物群系。',
        save: '服务器报告存档保存完成；本操作不生成备份。',
        teleport: '服务器已确认玩家传送指令，请刷新玩家详情查看当前位置。',
      };
      audit(ctx.log, 'server_action', 'acknowledged', session, { action: action.kind });
      return respond(200, { message: messages[action.kind] ?? '', updatedAt: stamp() });
    });
  }

  async function addWhitelist(ctx) {
    const auth = authenticate(ctx, true);
    if (auth.response) return auth.response;
    let body;
    try { body = await decodeJson(ctx.request, { name: isString }); }
    catch { return failure(400, 'invalid_request', '请提交有效的玩家名。'); }
    if (!validatePlayerName(body.name)) {
      return failure(400, 'invalid_player', '玩家名需为 1–16 位英文字母、数字或下划线，请填写 Java 玩家名。');
    }
    return changeWhitelist(ctx, auth.session, 'add', body.name, () => ctx.client().add(body.name));
  }

  async function removeWhitelist(ctx, name) {
    const auth = authenticate(ctx, true);
    if (auth.response) return auth.response;
    if (!validatePlayerName(name)) return failure(400, 'invalid_player', '无效的 Java 玩家名，请刷新列表后重试。');
    return changeWhitelist(ctx, auth.session, 'remove', name, () => ctx.client().remove(name));
  }

  function changeWhitelist(ctx, session, action, target, apply) {
    return exclusive('另一项修改正在进行，请稍后刷新列表。', async () => {
      audit(ctx.log, 'whitelist', 'requested', session, { action, target });
      try {
        const players = await apply();
        audit(ctx.log, 'whitelist', 'confirmed_in_memory', session, { action, target });
        return respond(200, { players: sorted(players), updatedAt: stamp() });
      } catch (error) {
        audit(ctx.log, 'whitelist', 'unconfirmed', session, { action, target, ...describeError(error) });
        return failure(502, 'mutation_unconfirmed', '未能确认 RCON 修改结果。请先刷新名单核对，不要重复提交。');
      }
    });
  }

  async function readSettings(ctx) {
    const auth = authenticate(ctx, false);
    if (auth.response) return auth.response;
    try { return respond(200, { settings: await ctx.client().settings(), updatedAt: stamp() }); }
    catch { return failure(502, 'server_unavailable', '无法读取服务器参数，请检查连接后刷新。'); }
  }

  async function changeSetting(ctx, key) {
    const auth = authenticate(ctx, true);
    if (auth.response) return auth.response;
    if (key !== 'difficulty') return failure(400, 'invalid_setting', '该参数不在允许修改的范围内。');
    let body;
    try { body = await decodeJson(ctx.request, { value: isAny }); }
    catch { return failure(400, 'invalid_setting', '请提交有效的参数值。'); }
    if (body.value === undefined) return failure(400, 'invalid_setting', '请提交有效的参数值。');
    try { validateSetting(key, body.value); }
    catch { return failure(400, 'invalid_setting', '难度只能为和平、简单、普通或困难。'); }
    return exclusive('另一项修改正在进行，请稍后刷新参数。', async () => {
      audit(ctx.log, 'setting', 'requested', auth.session, { setting: key });
      try {
        const settings = await ctx.client().setSetting(key, body.value);
        audit(ctx.log, 'setting', 'confirmed_in_memory', auth.session, { setting: key });
        return respond(200, { settings, updatedAt: stamp() });
      } catch (error) {
        if (isRconError(error, ERR.INVALID_SETTING)) {
          return failure(400, 'invalid_setting', '参数类型或范围不正确，请核对页面中的限制。');
        }
        audit(ctx.log, 'setting', 'unconfirmed', auth.session, { setting: key, ...describeError(error) });
        return failure(502, 'mutation_unconfirmed', '未能确认参数修改结果。请先刷新核对，不要重复提交。');
      }
    });
  }

  async function readGameRules(ctx) {
    const auth = authenticate(ctx, false);
    if (auth.response) return auth.response;
    try { return respond(200, { rules: await ctx.client().gameRules(), updatedAt: stamp() }); }
    catch { return failure(502, 'server_unavailable', '无法读取游戏规则，请刷新后重试。'); }
  }

  async function changeGameRule(ctx, key) {
    const auth = authenticate(ctx, true);
    if (auth.response) return auth.response;
    const invalid = () => failure(400, 'invalid_gamerule',
      '请选择支持的游戏规则；开关须为布尔值，睡眠比例须为 0–100 的整数。');
    let body;
    try { body = await decodeJson(ctx.request, { value: isAny }); validateGameRule(key, body.value); }
    catch { return invalid(); }
    return exclusive('另一项修改正在进行，请完成后刷新再操作。', async () => {
      audit(ctx.log, 'game_rule', 'requested', auth.session, { rule: key });
      try {
        const rules = await ctx.client().setGameRule(key, body.value);
        audit(ctx.log, 'game_rule', 'confirmed_in_memory', auth.session, { rule: key });
        return respond(200, { rules, updatedAt: stamp() });
      } catch (error) {
        audit(ctx.log, 'game_rule', 'unconfirmed', auth.session, { rule: key, ...describeError(error) });
        return failure(502, 'mutation_unconfirmed', '游戏规则保存结果暂时无法确认，请先刷新规则核对，不要重复提交。');
      }
    });
  }

  async function playerDetails(ctx, name) {
    const auth = authenticate(ctx, false);
    if (auth.response) return auth.response;
    if (!validatePlayerName(name)) return failure(400, 'invalid_player', '请选择有效的在线玩家。');
    try {
      return respond(200, { player: await ctx.client().playerDetails(name), updatedAt: stamp() });
    } catch (error) {
      if (isRconError(error, ERR.NO_PLAYERS)) return failure(409, 'no_players', '该玩家已离线，请刷新在线列表。');
      if (isRconError(error, ERR.PLAYER_CHANGED_DIMENSION)) {
        return failure(409, 'player_dimension_changed', '该玩家刚刚切换维度，请重新刷新玩家详情。');
      }
      return failure(502, 'server_unavailable', '无法读取玩家位置，请刷新在线列表与玩家详情后重试。');
    }
  }

  async function readBans(ctx) {
    const auth = authenticate(ctx, false);
    if (auth.response) return auth.response;
    try { return respond(200, { bans: await ctx.client().bans(), updatedAt: stamp() }); }
    catch { return failure(502, 'server_unavailable', '无法读取封禁名单报告，请刷新后重试。'); }
  }

  async function banPlayer(ctx) {
    const auth = authenticate(ctx, true);
    if (auth.response) return auth.response;
    let body;
    try {
      body = await decodeJson(ctx.request, { name: isString, reason: isString });
      validateBan(body.name, body.reason);
    } catch {
      return failure(400, 'invalid_ban',
        '请填写有效玩家名和单行原因。原因最多 160 个字符，表情较多时请进一步缩短，不能包含 @、换行或控制字符。');
    }
    return changeBan(ctx, auth.session, 'ban', body.name, () => ctx.client().ban(body.name, body.reason));
  }

  async function pardonPlayer(ctx, name) {
    const auth = authenticate(ctx, true);
    if (auth.response) return auth.response;
    if (!validatePlayerName(name)) return failure(400, 'invalid_player', '玩家名需为 1–16 位英文字母、数字或下划线。');
    return changeBan(ctx, auth.session, 'pardon', name, () => ctx.client().pardon(name));
  }

  function changeBan(ctx, session, action, player, apply) {
    return exclusive('另一项修改正在进行，请完成后刷新再操作。', async () => {
      audit(ctx.log, 'ban', 'requested', session, { action, player });
      try {
        const bans = await apply();
        audit(ctx.log, 'ban', 'acknowledged', session, { action, player });
        return respond(200, { bans, updatedAt: stamp() });
      } catch (error) {
        if (isRconError(error, ERR.BAN_UNCHANGED)) {
          return failure(409, 'ban_unchanged', '该玩家已处于目标封禁状态，未作修改。请刷新名单报告核对。');
        }
        audit(ctx.log, 'ban', 'unconfirmed', session, { action, player, ...describeError(error) });
        return failure(502, 'mutation_unconfirmed',
          '封禁修改结果暂时无法确认，请先刷新名单报告并核对服务端状态，不要重复提交。');
      }
    });
  }

  async function locateStructure(ctx) {
    // Although this is a read, require an explicit same-origin, CSRF-checked
    // submission: locating structures can be expensive on the game server.
    const auth = authenticate(ctx, true);
    if (auth.response) return auth.response;
    let query;
    try {
      const body = await decodeJson(ctx.request, {
        structure: isString, originDimension: isString, x: isInteger, z: isInteger,
      });
      if (body.x === undefined || body.z === undefined) throw new Error('coordinates required');
      query = { structure: body.structure ?? '', originDimension: body.originDimension ?? '', x: body.x, z: body.z };
    } catch { return failure(400, 'invalid_locate', '请选择结构，并填写起点 X、Z 整数坐标。'); }
    try { validateLocateRequest(query); }
    catch (error) {
      let message = '请选择支持的结构与出发维度（主世界、下界或末地）。';
      if (isRconError(error, ERR.LOCATE_DIMENSION_MISMATCH)) {
        message = '末地坐标不能与主世界或下界换算。请使用目标结构所在维度的出发坐标。';
      } else if (isRconError(error, ERR.LOCATE_COORDINATE_RANGE)) {
        message = '输入坐标及维度换算后的坐标必须在 -29999984 至 29999984 之间；下界到主世界会乘以 8，请换一个更近的起点。';
      }
      return failure(400, 'invalid_locate', message);
    }
    // The gate is per warm function instance, not a distributed global limit.
    // Keep a cooldown after failures too: closing RCON does not cancel work
    // already running on the Minecraft server. Never automatically retry.
    if (locate.busy) {
      return failure(429, 'locate_busy', '另一项结构定位正在进行，请等待完成后再查询。', { 'Retry-After': '30' });
    }
    const remaining = locate.next - now();
    if (remaining > 0) {
      const seconds = String(Math.ceil(remaining / 1000));
      return failure(429, 'locate_cooldown', `请等待约 ${seconds} 秒后再定位，给游戏服留出计算时间。`,
        { 'Retry-After': seconds });
    }
    locate.busy = true;
    try {
      audit(ctx.log, 'locate', 'requested', auth.session, { structure: query.structure });
      const result = await ctx.client().locate(query);
      return respond(200, { result, updatedAt: stamp() });
    } catch (error) {
      if (isRconError(error, ERR.STRUCTURE_NOT_FOUND)) {
        return failure(404, 'structure_not_found', '游戏服未在此起点的搜索范围内找到该结构，请换一个起点再试。');
      }
      return failure(502, 'locate_unavailable',
        '未取得定位结果，可能是连接异常、搜索超时或服务器回复不兼容。游戏服可能仍在搜索，请稍后再试。');
    } finally {
      locate.busy = false;
      locate.next = now() + LOCATE_COOLDOWN_MS;
    }
  }
}
