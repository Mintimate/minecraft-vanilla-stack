// Structure lookup through the game server's own `locate structure` command.
// IDs, village tag members and output syntax are verified against the vanilla
// 26.3 JAR (worldgen data, en_us.json and LocateCommand bytecode). The caller
// never supplies a seed, a selector or an arbitrary command.
import { ERR, rconError } from './rcon-protocol.mjs';

const MAX_COORDINATE = 29_999_984;
const OVERWORLD = 'minecraft:overworld';
const NETHER = 'minecraft:the_nether';
const END = 'minecraft:the_end';

function structureSpec(key) {
  switch (key) {
    case 'mansion': case 'swamp_hut': case 'desert_pyramid': case 'jungle_pyramid':
    case 'monument': case 'ancient_city': case 'trial_chambers': case 'stronghold':
      return { id: `minecraft:${key}`, dimension: OVERWORLD };
    case 'village':
      return { id: '#minecraft:village', dimension: OVERWORLD };
    case 'fortress': case 'bastion_remnant':
      return { id: `minecraft:${key}`, dimension: NETHER };
    case 'end_city':
      return { id: 'minecraft:end_city', dimension: END };
    default:
      return null;
  }
}

function validCoordinates(x, z) {
  return Number.isSafeInteger(x) && Number.isSafeInteger(z) &&
    Math.abs(x) <= MAX_COORDINATE && Math.abs(z) <= MAX_COORDINATE;
}

// request: { structure, originDimension?, x, z }
export function prepareLocate(request) {
  const spec = structureSpec(request?.structure);
  if (!spec) throw rconError(ERR.INVALID_LOCATE);
  // Callers that omit originDimension supply coordinates in the target's own
  // dimension, preserving the original API contract.
  const origin = { dimension: request.originDimension || spec.dimension, x: request.x, z: request.z };
  if (![OVERWORLD, NETHER, END].includes(origin.dimension)) throw rconError(ERR.INVALID_LOCATE);
  if (!validCoordinates(origin.x, origin.z)) {
    throw rconError(ERR.INVALID_LOCATE, rconError(ERR.LOCATE_COORDINATE_RANGE));
  }
  const search = { dimension: spec.dimension, x: origin.x, z: origin.z };
  if (origin.dimension !== search.dimension) {
    if (origin.dimension === END || search.dimension === END) {
      throw rconError(ERR.INVALID_LOCATE, rconError(ERR.LOCATE_DIMENSION_MISMATCH));
    }
    if (search.dimension === NETHER) {
      // Division must floor, not truncate: Overworld -1 is Nether -1.
      search.x = Math.floor(origin.x / 8);
      search.z = Math.floor(origin.z / 8);
    } else {
      search.x *= 8;
      search.z *= 8;
    }
  }
  if (!validCoordinates(search.x, search.z)) {
    throw rconError(ERR.INVALID_LOCATE, rconError(ERR.LOCATE_COORDINATE_RANGE));
  }
  // Normalize a negative zero so it never reaches the command text.
  for (const point of [origin, search]) { point.x += 0; point.z += 0; }
  return { structure: request.structure, spec, origin, search };
}

export function validateLocateRequest(request) {
  prepareLocate(request);
}

// Conversion has already happened once. Switch dimensions before positioning
// to avoid scaling the converted coordinates again. Y is only a search origin;
// structure locate replies do not provide the structure's height.
export function locateCommand(query) {
  return `execute in ${query.spec.dimension} positioned ${query.search.x} 64 ${query.search.z} run locate structure ${query.spec.id}`;
}

const LOCATE_RESPONSE = /^The nearest (.+) is at \[(-?(?:0|[1-9][0-9]*)), ~, (-?(?:0|[1-9][0-9]*))\] \((0|[1-9][0-9]*) blocks away\)$/;
const VILLAGE_NAMES = new Set([
  '#minecraft:village (minecraft:village_plains)', '#minecraft:village (minecraft:village_desert)',
  '#minecraft:village (minecraft:village_savanna)', '#minecraft:village (minecraft:village_snowy)',
  '#minecraft:village (minecraft:village_taiga)',
]);

function nameMatches(spec, name) {
  return spec.id === '#minecraft:village' ? VILLAGE_NAMES.has(name) : name === spec.id;
}

export function parseLocate(query, response) {
  if (response === `Could not find a structure of type "${query.spec.id}" nearby`) {
    throw rconError(ERR.STRUCTURE_NOT_FOUND);
  }
  const parts = LOCATE_RESPONSE.exec(response);
  if (!parts || !nameMatches(query.spec, parts[1])) throw rconError(ERR.PROTOCOL);
  const x = Number(parts[2]);
  const z = Number(parts[3]);
  const reported = Number(parts[4]);
  if (parts[2] === '-0' || parts[3] === '-0' || reported > 2_147_483_647 ||
      Math.abs(x) > 30_000_000 || Math.abs(z) > 30_000_000) throw rconError(ERR.PROTOCOL);
  // Vanilla 26.3 squares integer coordinate differences before calculating
  // distance, which can overflow on a distant mansion. Compute the horizontal
  // distance from the verified coordinates without that integer overflow.
  const distance = Math.floor(Math.hypot(x - query.search.x, z - query.search.z));
  return {
    structure: query.structure, dimension: query.spec.dimension, x, z, distance,
    origin: query.origin, searchOrigin: query.search,
  };
}
