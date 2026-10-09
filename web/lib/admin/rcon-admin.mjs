// Game rules, player positions and bans over an authenticated RCON session.
// Names and response strings were checked against the vanilla 26.3 JAR. These
// helpers take a Session; rcon.mjs owns connection lifecycle and logging.
import {
  ERR, MAX_RESPONSE_BYTES, rconError, validatePlayerName,
} from './rcon-protocol.mjs';

const COUNT_LIMIT = Math.floor(MAX_RESPONSE_BYTES / 3);
const CANONICAL_INT = /^(?:0|[1-9][0-9]*)$/;

// Stable application keys deliberately differ from the current command IDs.
const GAME_RULES = Object.freeze([
  { key: 'keepInventory', id: 'keep_inventory' },
  { key: 'playersSleepingPercentage', id: 'players_sleeping_percentage', number: true },
  { key: 'mobGriefing', id: 'mob_griefing' },
  { key: 'doDaylightCycle', id: 'advance_time' },
  { key: 'doWeatherCycle', id: 'advance_weather' },
]);

// Returns the rule and the exact command argument, or throws INVALID_GAMERULE.
export function gameRuleInput(key, value) {
  const rule = GAME_RULES.find((candidate) => candidate.key === key);
  if (!rule) throw rconError(ERR.INVALID_GAMERULE);
  if (rule.number) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100) {
      throw rconError(ERR.INVALID_GAMERULE);
    }
    return { rule, desired: String(value) };
  }
  if (typeof value !== 'boolean') throw rconError(ERR.INVALID_GAMERULE);
  return { rule, desired: String(value) };
}

export function validateGameRule(key, value) {
  gameRuleInput(key, value);
}

function parseGameRule(rule, response) {
  const prefix = `Game rule ${rule.id} is currently set to `;
  if (!response.startsWith(prefix)) throw rconError(ERR.PROTOCOL);
  const text = response.slice(prefix.length);
  if (rule.number) {
    // The server permits values above 100. Show such an existing value, but
    // restrict changes through this administration UI to percentages 0–100.
    const value = Number(text);
    if (!/^-?(?:0|[1-9][0-9]*)$/.test(text) || value < 0 || value > 2_147_483_647) throw rconError(ERR.PROTOCOL);
    return value;
  }
  if (text === 'true') return true;
  if (text === 'false') return false;
  throw rconError(ERR.PROTOCOL);
}

export async function readGameRules(session) {
  const rules = [];
  for (const rule of GAME_RULES) {
    const response = await session.command(`gamerule minecraft:${rule.id}`);
    rules.push({ key: rule.key, value: parseGameRule(rule, response) });
  }
  return rules;
}

export async function writeGameRule(session, key, value) {
  const { rule, desired } = gameRuleInput(key, value);
  let response;
  try { response = await session.command(`gamerule minecraft:${rule.id} ${desired}`); }
  catch (error) { throw rconError(ERR.MUTATION_UNCONFIRMED, error); }
  if (response !== `Game rule ${rule.id} is now set to ${desired}` &&
      response !== `Game rule ${rule.id} is already set to ${desired}`) {
    throw rconError(ERR.MUTATION_UNCONFIRMED, rconError(ERR.PROTOCOL));
  }
  let rules;
  try { rules = await readGameRules(session); }
  catch (error) { throw rconError(ERR.MUTATION_UNCONFIRMED, error); }
  const current = rules.find((candidate) => candidate.key === key);
  if (!current || String(current.value) !== desired) throw rconError(ERR.MUTATION_UNCONFIRMED);
  return rules;
}

function onlineName(players, name) {
  const found = players.find((player) => player.name.toLowerCase() === name.toLowerCase());
  return found?.name;
}

export { onlineName };

async function entityData(session, name, path) {
  const response = await session.command(`data get entity ${name} ${path}`);
  if (response === 'No entity was found' || response === 'No player was found') throw rconError(ERR.NO_PLAYERS);
  // The prefix is a display name and can contain a scoreboard team prefix.
  // The fixed query selects exactly one validated online player.
  const marker = ' has the following entity data: ';
  const at = response.lastIndexOf(marker);
  if (at <= 0) throw rconError(ERR.PROTOCOL);
  return response.slice(at + marker.length);
}

const SNBT_DOUBLE = /^-?[0-9]+(?:\.[0-9]+)?(?:[Ee][+-]?[0-9]+)?d$/;

function parsePosition(text) {
  if (text.length < 2 || text[0] !== '[' || text[text.length - 1] !== ']') throw rconError(ERR.PROTOCOL);
  const values = text.slice(1, -1).split(', ');
  if (values.length !== 3) throw rconError(ERR.PROTOCOL);
  return values.map((value) => {
    if (!SNBT_DOUBLE.test(value)) throw rconError(ERR.PROTOCOL);
    const number = Number(value.slice(0, -1));
    if (!Number.isFinite(number)) throw rconError(ERR.PROTOCOL);
    return number;
  });
}

function parseDimension(text) {
  let dimension;
  try { dimension = JSON.parse(text); } catch { throw rconError(ERR.PROTOCOL); }
  if (typeof dimension !== 'string') throw rconError(ERR.PROTOCOL);
  const separator = dimension.indexOf(':');
  if (separator < 0) throw rconError(ERR.PROTOCOL);
  const parts = [dimension.slice(0, separator), dimension.slice(separator + 1)];
  if (!parts[0] || !parts[1] || !/^[a-z0-9_.-]+$/.test(parts[0]) || !/^[a-z0-9_.\-/]+$/.test(parts[1])) {
    throw rconError(ERR.PROTOCOL);
  }
  return dimension;
}

// `players` is the fresh online list read on the same session.
export async function readPlayerDetails(session, players, name) {
  if (!validatePlayerName(name)) throw rconError(ERR.INVALID_PLAYER);
  const canonical = onlineName(players, name);
  if (!canonical) throw rconError(ERR.NO_PLAYERS);
  const dimension = parseDimension(await entityData(session, canonical, 'Dimension'));
  const position = parsePosition(await entityData(session, canonical, 'Pos'));
  const latest = parseDimension(await entityData(session, canonical, 'Dimension'));
  // Reading a position and dimension in separate commands can straddle a portal
  // crossing. Reject an observed transition rather than label the old
  // coordinates with a different dimension. Ordinary movement is allowed.
  if (latest !== dimension) throw rconError(ERR.PLAYER_CHANGED_DIMENSION);
  return { name: canonical, dimension, position };
}

export async function teleportPlayers(session, players, action) {
  const player = onlineName(players, action.player);
  const target = onlineName(players, action.target);
  if (!player || !target) throw rconError(ERR.NO_PLAYERS);
  let response;
  try { response = await session.command(`tp ${player} ${target}`); }
  catch (error) { throw rconError(ERR.MUTATION_UNCONFIRMED, error); }
  if (response === 'No player was found' || response === 'No entity was found') throw rconError(ERR.NO_PLAYERS);
  // Vanilla's single-target success branch uses both entities' display names
  // and also moves across dimensions. Errors use different translation keys.
  if (!response.startsWith('Teleported ')) throw rconError(ERR.MUTATION_UNCONFIRMED, rconError(ERR.PROTOCOL));
  const names = response.slice('Teleported '.length);
  const split = names.indexOf(' to ');
  if (split <= 0 || split + 4 >= names.length) throw rconError(ERR.MUTATION_UNCONFIRMED, rconError(ERR.PROTOCOL));
}

export function validateBan(name, reason) {
  if (!validatePlayerName(name) || typeof reason !== 'string' || !reason.isWellFormed() ||
      Buffer.byteLength(reason) > 512 || [...reason].length > 160 || reason.length > 256 ||
      reason.trim() === '' || reason.includes('@') || /[\p{Cc}\u2028\u2029]/u.test(reason)) {
    throw rconError(ERR.INVALID_BAN);
  }
}

function parseBans(response) {
  if (response === 'There are no bans') return { count: 0, rawOutput: response };
  if (!response.startsWith('There are ')) throw rconError(ERR.PROTOCOL);
  const rest = response.slice('There are '.length);
  const split = rest.indexOf(' ban(s):');
  if (split < 0) throw rconError(ERR.PROTOCOL);
  const countText = rest.slice(0, split);
  const entries = rest.slice(split + ' ban(s):'.length);
  const count = Number(countText);
  if (!CANONICAL_INT.test(countText) || count < 1 || count > COUNT_LIMIT || entries === '' ||
      Buffer.byteLength(response) > MAX_RESPONSE_BYTES) throw rconError(ERR.PROTOCOL);
  return { count, rawOutput: response };
}

export async function readBans(session) {
  return parseBans(await session.command('banlist players'));
}

// BanList preserves the actual console output. Vanilla RCON concatenates the
// header and entries without delimiters, and both the source and reason may
// contain arbitrary text, so splitting into named entries would be ambiguous.
export async function changeBan(session, name, reason, ban) {
  const command = ban ? `ban ${name} ${reason}` : `pardon ${name}`;
  let response;
  try { response = await session.command(command); }
  catch (error) { throw rconError(ERR.MUTATION_UNCONFIRMED, error); }
  if ((ban && response === 'Nothing changed. The player is already banned') ||
      (!ban && response === "Nothing changed. The player isn't banned")) {
    throw rconError(ERR.BAN_UNCHANGED);
  }
  let confirmed = false;
  if (ban) {
    if (response.startsWith('Banned ')) {
      const rest = response.slice('Banned '.length);
      const split = rest.indexOf(': ');
      confirmed = split >= 0 && rest.slice(0, split).toLowerCase() === name.toLowerCase() &&
        rest.slice(split + 2) === reason;
    }
  } else if (response.startsWith('Unbanned ')) {
    confirmed = response.slice('Unbanned '.length).toLowerCase() === name.toLowerCase();
  }
  if (!confirmed) throw rconError(ERR.MUTATION_UNCONFIRMED, rconError(ERR.PROTOCOL));
  // A precise acknowledgement confirms the mutation. The following snapshot is
  // intentionally raw: RCON has no reliable per-player readback.
  try { return await readBans(session); }
  catch (error) { throw rconError(ERR.MUTATION_UNCONFIRMED, error); }
}
