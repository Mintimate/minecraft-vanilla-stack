// Minecraft Java RCON transport. Each operation opens one TCP connection, runs
// its fixed commands one at a time and closes it. RCON itself is not encrypted
// and offers no pipelining: Vanilla 26.3 rejects a second request frame that
// arrives before the first has been read.
import net from 'node:net';

export const DEFAULT_TIMEOUT_MS = 8_000;
export const MAX_TIMEOUT_MS = 10_000;
// Vanilla 26.3 splits responses at 4096 Java characters, not bytes.
export const MAX_PACKET_BYTES = 4096 * 4 + 10;
export const MAX_RESPONSE_BYTES = 1 << 20;
export const MAX_RESPONSE_PACKETS = 1024;
export const MAX_REQUEST_BYTES = 1460;
const MAX_BUFFERED_BYTES = 2 * MAX_RESPONSE_BYTES;

export const ERR = Object.freeze({
  UNAVAILABLE: 'unavailable',
  TIMEOUT: 'timeout',
  AUTHENTICATION: 'authentication',
  PROTOCOL: 'protocol',
  MUTATION_UNCONFIRMED: 'mutation_unconfirmed',
  INVALID_PLAYER: 'invalid_player',
  INVALID_SETTING: 'invalid_setting',
  INVALID_ACTION: 'invalid_action',
  NO_PLAYERS: 'no_players',
  INVALID_GAMERULE: 'invalid_gamerule',
  INVALID_BAN: 'invalid_ban',
  BAN_UNCHANGED: 'ban_unchanged',
  PLAYER_CHANGED_DIMENSION: 'player_changed_dimension',
  INVALID_LOCATE: 'invalid_locate',
  LOCATE_DIMENSION_MISMATCH: 'locate_dimension_mismatch',
  LOCATE_COORDINATE_RANGE: 'locate_coordinate_range',
  STRUCTURE_NOT_FOUND: 'structure_not_found',
});

// Fixed messages only. Never put a host, port, password or server output here.
const MESSAGES = Object.freeze({
  [ERR.UNAVAILABLE]: 'Minecraft RCON connection unavailable',
  [ERR.TIMEOUT]: 'Minecraft RCON operation timed out',
  [ERR.AUTHENTICATION]: 'Minecraft RCON authentication rejected',
  [ERR.PROTOCOL]: 'invalid or unsupported Minecraft RCON response',
  [ERR.MUTATION_UNCONFIRMED]: 'Minecraft change could not be confirmed; refresh before retrying',
  [ERR.INVALID_PLAYER]: 'invalid Minecraft player name',
  [ERR.INVALID_SETTING]: 'only a valid difficulty setting is supported',
  [ERR.INVALID_ACTION]: 'invalid Minecraft administration action',
  [ERR.NO_PLAYERS]: 'no matching online players',
  [ERR.INVALID_GAMERULE]: 'invalid or unsupported Minecraft game rule',
  [ERR.INVALID_BAN]: 'invalid Minecraft ban name or reason',
  [ERR.BAN_UNCHANGED]: 'the player is already in the requested ban state',
  [ERR.PLAYER_CHANGED_DIMENSION]: 'the player changed dimensions while reading their position; refresh to try again',
  [ERR.INVALID_LOCATE]: 'invalid Minecraft structure, origin dimension, or search coordinates',
  [ERR.LOCATE_DIMENSION_MISMATCH]: 'End coordinates cannot be converted to another dimension',
  [ERR.LOCATE_COORDINATE_RANGE]: 'input or converted Minecraft coordinates are outside the supported range',
  [ERR.STRUCTURE_NOT_FOUND]: 'Minecraft found no matching structure within its search range',
});

// An error has one primary code and may wrap a cause (the Go version joined
// errors with errors.Join). isRconError walks the whole chain.
export class RconError extends Error {
  constructor(code, cause, systemCode) {
    super(MESSAGES[code] ?? 'Minecraft RCON error', cause ? { cause } : undefined);
    this.name = 'RconError';
    this.code = code;
    if (systemCode) this.systemCode = systemCode;
  }
}

export function rconError(code, cause, systemCode) {
  return new RconError(code, cause, systemCode);
}

export function isRconError(error, code) {
  for (let current = error, depth = 0; current && depth < 8; current = current.cause, depth += 1) {
    if (current.code === code) return true;
  }
  return false;
}

// Log-safe description: error codes only, never messages (they may be tainted
// by a platform or upstream string) and never a host or password.
export function describeError(error) {
  const codes = [];
  let systemCode;
  for (let current = error, depth = 0; current && depth < 8; current = current.cause, depth += 1) {
    if (current instanceof RconError) {
      codes.push(current.code);
      systemCode ??= current.systemCode;
    }
  }
  return {
    code: codes[0] ?? 'unknown',
    causes: codes.slice(1),
    ...(systemCode ? { errorCode: systemCode } : {}),
  };
}

export function validatePlayerName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9_]{1,16}$/.test(name);
}

function validHost(host) {
  if (typeof host !== 'string') return false;
  if (net.isIP(host)) return true;
  if (!host || host.length > 253) return false;
  return host.replace(/\.$/, '').split('.').every((label) =>
    label.length >= 1 && label.length <= 63 && !label.startsWith('-') && !label.endsWith('-') &&
    /^[A-Za-z0-9-]+$/.test(label));
}

// Validates local configuration only. It never resolves or connects to host.
export function validateRconConfig({ host, port, password, timeoutMs = 0 }) {
  if (!validHost(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('RCON requires a hostname or IP and a port between 1 and 65535');
  }
  if (typeof password !== 'string' || password.length < 32 || password.length > 128 ||
      !/^[!-~]+$/.test(password)) {
    throw new Error('RCON password must contain 32–128 printable ASCII bytes without spaces');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error('RCON timeout must not be negative');
  return {
    host, port, password,
    timeoutMs: Math.min(timeoutMs === 0 ? DEFAULT_TIMEOUT_MS : timeoutMs, MAX_TIMEOUT_MS),
  };
}

const SYSTEM_CODE = /^[A-Z][A-Z0-9_]{0,31}$/;

function transportFailure(error) {
  const code = typeof error?.code === 'string' && SYSTEM_CODE.test(error.code) ? error.code : undefined;
  if (code === 'ETIMEDOUT') return rconError(ERR.UNAVAILABLE, rconError(ERR.TIMEOUT), code);
  return rconError(ERR.UNAVAILABLE, undefined, code);
}

// Buffered, deadline-bound frame reader/writer over a TCP socket.
class Wire {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.failure = null;
    this.waiter = null;
    this.connected = new Promise((resolve, reject) => {
      this.onConnect = resolve;
      this.onConnectFailure = reject;
    });
    this.connected.catch(() => {}); // Failures are surfaced by the awaiting caller.
    socket.on('connect', () => this.onConnect());
    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      if (this.buffer.length > MAX_BUFFERED_BYTES) this.fail(rconError(ERR.PROTOCOL));
      else this.flush();
    });
    socket.on('error', (error) => this.fail(transportFailure(error)));
    socket.on('close', () => this.fail(rconError(ERR.UNAVAILABLE)));
  }

  fail(error) {
    if (!this.failure) {
      this.failure = error;
      this.socket.destroy();
      this.onConnectFailure(error);
    }
    this.flush();
  }

  flush() {
    const waiter = this.waiter;
    if (!waiter) return;
    if (this.buffer.length >= waiter.size) {
      this.waiter = null;
      const data = Buffer.from(this.buffer.subarray(0, waiter.size));
      this.buffer = this.buffer.subarray(waiter.size);
      waiter.resolve(data);
    } else if (this.failure) {
      this.waiter = null;
      waiter.reject(this.failure);
    }
  }

  read(size) {
    return new Promise((resolve, reject) => {
      this.waiter = { size, resolve, reject };
      this.flush();
    });
  }

  write(frame) {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.socket.write(frame, (error) => (error ? reject(transportFailure(error)) : resolve()));
    });
  }
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

// A connected, authenticated RCON conversation. Operations run commands with
// session.command(text); the connection is closed by RconClient.withSession.
export class Session {
  constructor(wire, timer, trace) {
    this.wire = wire;
    this.timer = timer;
    this.trace = trace;
    this.nextId = 2;
    this.calls = 0;
  }

  close() {
    clearTimeout(this.timer);
    this.wire.socket.destroy();
  }

  async write(id, kind, body) {
    const bodyBytes = Buffer.from(body, 'utf8');
    const frame = Buffer.alloc(bodyBytes.length + 14);
    frame.writeUInt32LE(bodyBytes.length + 10, 0);
    frame.writeInt32LE(id, 4);
    frame.writeInt32LE(kind, 8);
    bodyBytes.copy(frame, 12);
    // One complete frame per write, and never retried: a partial mutation must
    // surface as unconfirmed rather than be sent twice.
    await this.wire.write(frame);
  }

  async read() {
    const sizeBytes = await this.wire.read(4);
    const size = sizeBytes.readUInt32LE(0);
    if (size < 10 || size > MAX_PACKET_BYTES) throw rconError(ERR.PROTOCOL);
    const frame = await this.wire.read(size);
    if (frame[size - 2] !== 0 || frame[size - 1] !== 0) throw rconError(ERR.PROTOCOL);
    let body;
    try { body = utf8.decode(frame.subarray(8, size - 2)); } catch { throw rconError(ERR.PROTOCOL); }
    if (body.includes('\0')) throw rconError(ERR.PROTOCOL);
    return { id: frame.readInt32LE(0), kind: frame.readInt32LE(4), body };
  }

  // command drains every response fragment. After the first frame arrives, a
  // distinct read-only `difficulty` request acts as an end marker; a packet's
  // size or a short idle timeout cannot reliably indicate the end (including
  // exact multiples of 4096). The marker is sent only after the first frame, so
  // requests are never pipelined.
  async command(text) {
    const verb = text.split(' ', 1)[0];
    const started = performance.now();
    const id = this.nextId;
    const marker = this.nextId + 1;
    this.nextId += 2;
    this.calls += 1;
    try {
      await this.write(id, 2, text);
      const first = await this.read();
      if (first.id !== id || first.kind !== 0) throw rconError(ERR.PROTOCOL);
      const parts = [first.body];
      let length = Buffer.byteLength(first.body);
      await this.write(marker, 2, 'difficulty');
      for (let count = 1; count <= MAX_RESPONSE_PACKETS; count += 1) {
        const packet = await this.read();
        if (packet.kind !== 0) throw rconError(ERR.PROTOCOL);
        if (packet.id === marker) {
          if (!DIFFICULTIES.has(packet.body)) throw rconError(ERR.PROTOCOL);
          this.trace?.('rcon_command', { verb, ok: true, packets: count, bytes: length,
            elapsedMs: Math.round(performance.now() - started) });
          return parts.join('');
        }
        const size = Buffer.byteLength(packet.body);
        if (packet.id !== id || count === MAX_RESPONSE_PACKETS || length + size > MAX_RESPONSE_BYTES) {
          throw rconError(ERR.PROTOCOL);
        }
        parts.push(packet.body);
        length += size;
      }
      throw rconError(ERR.PROTOCOL);
    } catch (error) {
      this.trace?.('rcon_command', { verb, ok: false, ...describeError(error),
        elapsedMs: Math.round(performance.now() - started) });
      throw error;
    }
  }
}

const DIFFICULTIES = new Set([
  'The difficulty is Peaceful', 'The difficulty is Easy', 'The difficulty is Normal', 'The difficulty is Hard',
]);

// Opens and authenticates one connection. The deadline covers connecting,
// authenticating and every command run on the returned session.
export async function openSession(config, trace) {
  const socket = net.connect({ host: config.host, port: config.port });
  socket.setNoDelay(true);
  const wire = new Wire(socket);
  const timer = setTimeout(() => wire.fail(rconError(ERR.UNAVAILABLE, rconError(ERR.TIMEOUT))), config.timeoutMs);
  const session = new Session(wire, timer, trace);
  try {
    await wire.connected;
    await session.write(1, 3, config.password);
    const reply = await session.read();
    if (reply.kind !== 2 || reply.body !== '') throw rconError(ERR.PROTOCOL);
    if (reply.id === -1) throw rconError(ERR.AUTHENTICATION);
    if (reply.id !== 1) throw rconError(ERR.PROTOCOL);
    return session;
  } catch (error) {
    session.close();
    throw error;
  }
}
