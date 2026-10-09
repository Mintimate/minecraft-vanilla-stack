// A fixed set of Minecraft administration operations over RCON. There is no
// arbitrary-command API, connection pool, background work or automatic retry.
// RconClient is created per request so every log line carries that request's
// identifier; construction only validates configuration and never connects.
import {
  describeError, ERR, isRconError, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, openSession,
  rconError, validatePlayerName, validateRconConfig,
} from './rcon-protocol.mjs';
import {
  changeBan, gameRuleInput, onlineName, readBans, readGameRules, readPlayerDetails, teleportPlayers,
  validateBan, writeGameRule,
} from './rcon-admin.mjs';
import { locateCommand, parseLocate, prepareLocate } from './rcon-locate.mjs';

export { ERR, isRconError, validatePlayerName };
export { validateGameRule, validateBan } from './rcon-admin.mjs';
export { validateLocateRequest } from './rcon-locate.mjs';

const COUNT_LIMIT = Math.floor(MAX_RESPONSE_BYTES / 3);
const CANONICAL_INT = /^(?:0|[1-9][0-9]*)$/;
const DIFFICULTIES = ['peaceful', 'easy', 'normal', 'hard'];

export function validateSetting(key, value) {
  if (key !== 'difficulty' || typeof value !== 'string' || !DIFFICULTIES.includes(value)) {
    throw rconError(ERR.INVALID_SETTING);
  }
}

// action: { kind, player, target, message, value, seconds }. Absent fields are
// undefined (or null/''/0 from a decoded request body).
export function actionCommand(action) {
  const { kind } = action;
  const player = action.player ?? '';
  const target = action.target ?? '';
  const message = action.message ?? '';
  const value = action.value ?? '';
  const seconds = action.seconds ?? 0;
  const invalid = () => rconError(ERR.INVALID_ACTION);
  if (kind !== 'teleport' && target !== '') throw invalid();
  let command;
  switch (kind) {
    case 'teleport':
      if (!validatePlayerName(player) || !validatePlayerName(target) ||
          player.toLowerCase() === target.toLowerCase() || message !== '' || value !== '' || seconds !== 0) throw invalid();
      command = `tp ${player} ${target}`;
      break;
    case 'announce':
      if (player !== '' || value !== '' || seconds !== 0 || typeof message !== 'string' ||
          !message.isWellFormed() || Buffer.byteLength(message) > 512 || [...message].length > 160 ||
          message.trim() === '' || /\p{Cc}/u.test(message)) throw invalid();
      // The user controls only literal text, never selectors or JSON components.
      command = `tellraw @a ${JSON.stringify({ text: message })}`;
      break;
    case 'kick':
      if (!validatePlayerName(player) || message !== '' || value !== '' || seconds !== 0) throw invalid();
      command = `kick ${player} Disconnected by administrator.`;
      break;
    case 'time':
      if (player !== '' || message !== '' || seconds !== 0) throw invalid();
      if (!['day', 'noon', 'night', 'midnight'].includes(value)) throw invalid();
      command = `time set ${value}`;
      break;
    case 'weather':
      if (player !== '' || message !== '' || !Number.isInteger(seconds) || seconds < 1 || seconds > 3600) throw invalid();
      if (!['clear', 'rain', 'thunder'].includes(value)) throw invalid();
      // Vanilla's unsuffixed duration is ticks, so specify seconds explicitly.
      command = `weather ${value} ${seconds}s`;
      break;
    case 'save':
      if (player !== '' || message !== '' || value !== '' || seconds !== 0) throw invalid();
      command = 'save-all flush';
      break;
    default:
      throw invalid();
  }
  if (Buffer.byteLength(command) + 14 > MAX_REQUEST_BYTES) throw invalid();
  return command;
}

export function validateAction(action) {
  actionCommand(action);
}

// These strings were verified against assets/minecraft/lang/en_us.json and
// RconConsoleSource/WhitelistCommand/DifficultyCommand in the local 26.3 JAR.
// Vanilla RCON joins components without trailing newlines. Unknown or localized
// responses fail closed, never silently becoming an empty whitelist.
function cut(text, separator) {
  const at = text.indexOf(separator);
  return at < 0 ? null : [text.slice(0, at), text.slice(at + separator.length)];
}

function parsePlayers(namesText, count) {
  if (count === 0 && namesText === '') return [];
  const names = namesText.split(', ');
  if (names.length !== count) throw rconError(ERR.PROTOCOL);
  const seen = new Set();
  return names.map((name) => {
    const key = name.toLowerCase();
    if (!validatePlayerName(name) || seen.has(key)) throw rconError(ERR.PROTOCOL);
    seen.add(key);
    return { name };
  });
}

export function parseWhitelist(text) {
  if (text === 'There are no whitelisted players') return [];
  const prefix = 'There are ';
  if (!text.startsWith(prefix)) throw rconError(ERR.PROTOCOL);
  const parts = cut(text.slice(prefix.length), ' whitelisted player(s): ');
  if (!parts) throw rconError(ERR.PROTOCOL);
  const count = Number(parts[0]);
  if (!CANONICAL_INT.test(parts[0]) || count < 1 || count > COUNT_LIMIT) throw rconError(ERR.PROTOCOL);
  return parsePlayers(parts[1], count);
}

export function parseDifficulty(text) {
  switch (text) {
    case 'The difficulty is Peaceful': return 'peaceful';
    case 'The difficulty is Easy': return 'easy';
    case 'The difficulty is Normal': return 'normal';
    case 'The difficulty is Hard': return 'hard';
    default: throw rconError(ERR.PROTOCOL);
  }
}

export function parseOnlinePlayers(text) {
  const prefix = 'There are ';
  if (!text.startsWith(prefix)) throw rconError(ERR.PROTOCOL);
  const counts = cut(text.slice(prefix.length), ' of a max of ');
  const limits = counts && cut(counts[1], ' players online: ');
  if (!counts || !limits) throw rconError(ERR.PROTOCOL);
  const count = Number(counts[0]);
  const maximum = Number(limits[0]);
  if (!CANONICAL_INT.test(counts[0]) || count > COUNT_LIMIT) throw rconError(ERR.PROTOCOL);
  if (!CANONICAL_INT.test(limits[0]) || maximum > 2_147_483_647) throw rconError(ERR.PROTOCOL);
  // Operators can bypass the player limit; count may exceed maximum.
  return { players: parsePlayers(limits[1], count), maxPlayers: maximum };
}

export function parseDayTime(text) {
  const prefix = 'Timeline minecraft:day is at ';
  const suffix = ' tick(s)';
  if (!text.startsWith(prefix) || !text.endsWith(suffix)) throw rconError(ERR.PROTOCOL);
  const value = text.slice(prefix.length, text.length - suffix.length);
  const ticks = Number(value);
  if (!CANONICAL_INT.test(value) || ticks >= 24_000) throw rconError(ERR.PROTOCOL);
  return ticks;
}

const readWhitelist = async (session) => parseWhitelist(await session.command('whitelist list'));
const readOnline = async (session) => parseOnlinePlayers(await session.command('list'));
const readDayTime = async (session) => parseDayTime(await session.command('time query minecraft:day'));
const readDifficulty = async (session) => ({ difficulty: parseDifficulty(await session.command('difficulty')) });

export class RconClient {
  constructor(config, logger) {
    this.config = validateRconConfig(config);
    this.logger = logger;
  }

  // Runs fn on a fresh connection that is always closed afterwards, and logs
  // one summary line per operation: outcome, command count and elapsed time.
  async withSession(operation, fn) {
    const started = performance.now();
    const elapsedMs = () => Math.round(performance.now() - started);
    const trace = (event, fields) => this.logger?.debug(event, { operation, ...fields });
    let session;
    try {
      session = await openSession(this.config, trace);
    } catch (error) {
      this.logger?.warn('rcon_operation', { operation, ok: false, stage: 'connect',
        ...describeError(error), elapsedMs: elapsedMs() });
      throw error;
    }
    try {
      const result = await fn(session);
      this.logger?.info('rcon_operation', { operation, ok: true, calls: session.calls, elapsedMs: elapsedMs() });
      return result;
    } catch (error) {
      // Expected answers (offline player, nothing to change, no structure) are
      // information for the administrator rather than connectivity failures.
      const expected = [ERR.NO_PLAYERS, ERR.BAN_UNCHANGED, ERR.STRUCTURE_NOT_FOUND]
        .some((code) => isRconError(error, code));
      this.logger?.[expected ? 'info' : 'warn']('rcon_operation', { operation, ok: false, stage: 'command',
        calls: session.calls, ...describeError(error), elapsedMs: elapsedMs() });
      throw error;
    } finally {
      session.close();
    }
  }

  // Reads only the online list, without world time or the whitelist. Public
  // callers must project the result onto their own response fields.
  onlinePlayers() {
    return this.withSession('online_players', readOnline);
  }

  overview() {
    return this.withSession('overview', async (session) => ({
      ...await readOnline(session), dayTime: await readDayTime(session),
    }));
  }

  status() {
    return this.withSession('whitelist', async (session) => ({ players: await readWhitelist(session) }));
  }

  add(name) { return this.#changePlayer(name, true); }

  remove(name) { return this.#changePlayer(name, false); }

  async #changePlayer(name, add) {
    if (!validatePlayerName(name)) throw rconError(ERR.INVALID_PLAYER);
    return this.withSession(add ? 'whitelist_add' : 'whitelist_remove', async (session) => {
      // The mutation's human-readable success or failure text is not trusted.
      // Read back the list on the same connection and verify the desired state.
      try { await session.command(`whitelist ${add ? 'add' : 'remove'} ${name}`); }
      catch (error) { throw rconError(ERR.MUTATION_UNCONFIRMED, error); }
      let players;
      try { players = await readWhitelist(session); }
      catch (error) { throw rconError(ERR.MUTATION_UNCONFIRMED, error); }
      const found = players.some((player) => player.name.toLowerCase() === name.toLowerCase());
      if (found !== add) throw rconError(ERR.MUTATION_UNCONFIRMED);
      return players;
    });
  }

  settings() {
    return this.withSession('settings', readDifficulty);
  }

  async setSetting(key, value) {
    validateSetting(key, value);
    return this.withSession('set_difficulty', async (session) => {
      try { await session.command(`difficulty ${value}`); }
      catch (error) { throw rconError(ERR.MUTATION_UNCONFIRMED, error); }
      let settings;
      try { settings = await readDifficulty(session); }
      catch (error) { throw rconError(ERR.MUTATION_UNCONFIRMED, error); }
      if (settings.difficulty !== value) throw rconError(ERR.MUTATION_UNCONFIRMED);
      return settings;
    });
  }

  async execute(action) {
    const command = actionCommand(action);
    return this.withSession(`action_${action.kind}`, async (session) => {
      if (action.kind === 'teleport') {
        return teleportPlayers(session, (await readOnline(session)).players, action);
      }
      let response;
      try { response = await session.command(command); }
      catch (error) { throw rconError(ERR.MUTATION_UNCONFIRMED, error); }
      const unconfirmed = () => rconError(ERR.MUTATION_UNCONFIRMED, rconError(ERR.PROTOCOL));
      switch (action.kind) {
        case 'announce':
          if (response === 'No player was found') throw rconError(ERR.NO_PLAYERS);
          // TellRawCommand sends no success text. An empty, fully framed
          // response confirms server acceptance, not delivery to a client.
          if (response !== '') throw unconfirmed();
          break;
        case 'kick': {
          if (response === 'No player was found') throw rconError(ERR.NO_PLAYERS);
          const prefix = 'Kicked ';
          const suffix = ': Disconnected by administrator.';
          if (!response.startsWith(prefix) || !response.endsWith(suffix) ||
              response.length <= prefix.length + suffix.length) throw unconfirmed();
          // The acknowledgement uses the display name, which may include a team
          // prefix. Check the target's actual name in a fresh online list.
          let overview;
          try { overview = await readOnline(session); }
          catch (error) { throw rconError(ERR.MUTATION_UNCONFIRMED, error); }
          if (onlineName(overview.players, action.player)) throw rconError(ERR.MUTATION_UNCONFIRMED);
          break;
        }
        case 'time': {
          const marker = `minecraft:${action.value}`;
          if (response !== `Set minecraft:overworld to time marker ${marker}` &&
              response !== `Clock minecraft:overworld is already at time marker ${marker}`) throw unconfirmed();
          // Time advances between commands. Require a valid fresh snapshot
          // rather than exact equality to the marker's tick.
          try { await readDayTime(session); }
          catch (error) { throw rconError(ERR.MUTATION_UNCONFIRMED, error); }
          break;
        }
        case 'weather': {
          const expected = action.value === 'thunder'
            ? 'Set the weather to rain and thunder' : `Set the weather to ${action.value}`;
          if (response !== expected) throw unconfirmed();
          break;
        }
        case 'save':
          if (response !== 'Saving the game (this may take a moment!)Saved the game') throw unconfirmed();
          break;
        default:
          break;
      }
      return undefined;
    });
  }

  gameRules() {
    return this.withSession('gamerules', readGameRules);
  }

  async setGameRule(key, value) {
    gameRuleInput(key, value);
    return this.withSession('set_gamerule', (session) => writeGameRule(session, key, value));
  }

  async playerDetails(name) {
    if (!validatePlayerName(name)) throw rconError(ERR.INVALID_PLAYER);
    return this.withSession('player_details', async (session) =>
      readPlayerDetails(session, (await readOnline(session)).players, name));
  }

  bans() {
    return this.withSession('bans', readBans);
  }

  async ban(name, reason) {
    validateBan(name, reason);
    return this.withSession('ban', (session) => changeBan(session, name, reason.trim(), true));
  }

  async pardon(name) {
    if (!validatePlayerName(name)) throw rconError(ERR.INVALID_PLAYER);
    return this.withSession('pardon', (session) => changeBan(session, name, '', false));
  }

  async locate(request) {
    const query = prepareLocate(request);
    return this.withSession('locate', async (session) =>
      parseLocate(query, await session.command(locateCommand(query))));
  }
}
