// Signed, time-limited administrator sessions for Makers.
//
// This community edition uses its own cookie name and signing domain. No server-side session store exists: the cookie is an HMAC-signed
// payload. Logout clears this browser's cookie but cannot revoke a copied token
// before expiry; rotating ADMIN_KEY invalidates every session. The failed-login
// limiter is per function instance, not global.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import net from 'node:net';

const MAX_LOGIN_FAILURES = 10;
const LOGIN_WINDOW_MS = 60_000;
const MAX_LOGIN_BODY = 8192;
const COOKIE_PATH = '/admin';
const COOKIE_NAME = 'mvs_makers_admin';
const SESSION_TTL_SECONDS = 24 * 60 * 60;
const MAX_PAYLOAD_BYTES = 512;
const MAX_TOKEN_BYTES = 1024;
const SIGNING_DOMAIN = 'minecraft-vanilla-stack/makers-admin-cookie/v2\0';
const KEY_DOMAIN = `minecraft-vanilla-stack/makers-admin-key/v2\0${COOKIE_PATH}`;
const PAYLOAD_KEYS = ['v', 'iat', 'exp', 'nonce', 'csrf', 'origin'];

const sha256 = (value) => createHash('sha256').update(value).digest();
const base64url = (buffer) => Buffer.from(buffer).toString('base64url');

// Node's base64url decoder is lenient; require the canonical encoding.
function decodeStrict(text) {
  const data = Buffer.from(text, 'base64url');
  return data.toString('base64url') === text ? data : null;
}

function isLoopbackHost(hostname) {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host === '[::1]' || (net.isIPv4(host) && host.startsWith('127.'));
}

// Returns { origin, secure } for a browser Origin header, or null.
export function parseOrigin(raw) {
  if (typeof raw !== 'string' || raw.length > 300) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !url.hostname ||
      url.username || url.password || url.origin !== raw) return null;
  const secure = url.protocol === 'https:';
  if (!secure && !isLoopbackHost(url.hostname)) return null;
  return { origin: url.origin, secure };
}

function validRandomToken(token) {
  return typeof token === 'string' && token.length === 43 && decodeStrict(token)?.length === 32;
}

const randomToken = () => base64url(randomBytes(32));

function cookieValue(request) {
  const header = request.headers.get('cookie');
  if (!header) return { missing: true };
  let token = null;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at < 0 || part.slice(0, at).trim() !== COOKIE_NAME) continue;
    let value = part.slice(at + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    if (token !== null || value === '') return { invalid: 'duplicate_cookie' };
    token = value;
  }
  return token === null ? { missing: true } : { token };
}

function jsonResponse(status, value, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store', ...headers,
  } });
}

const ERROR_CODES = {
  400: 'invalid_request', 401: 'unauthorized', 403: 'forbidden', 405: 'method_not_allowed',
  415: 'unsupported_media_type', 429: 'too_many_requests',
};

function errorResponse(status, message, headers) {
  return jsonResponse(status, { error: { code: ERROR_CODES[status] ?? 'internal_error', message } }, headers);
}

export function mediaType(request) {
  return (request.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
}

export class AuthManager {
  constructor({ key, now = Date.now }) {
    if (typeof key !== 'string' || Buffer.byteLength(key) < 32 || key.trim() === '') {
      throw new Error('management key must contain at least 32 bytes');
    }
    this.keyHash = sha256(key);
    // Keep the session-key derivation separate from the cookie-signing domain.
    this.signingKey = createHmac('sha256', key).update(KEY_DOMAIN).digest();
    this.ttl = SESSION_TTL_SECONDS;
    this.now = now;
    this.failures = 0;
    this.windowFrom = 0;
  }

  // Fetch Metadata comes from the browser and survives Makers' internal
  // host/TLS rewriting. Older clients must match the actual request host.
  // Proxy headers are deliberately ignored.
  requestOrigin(request) {
    const origin = parseOrigin(request.headers.get('origin'));
    if (!origin) return null;
    const site = request.headers.get('sec-fetch-site');
    if (site !== null) return site === 'same-origin' ? origin : null;
    let host;
    try { host = request.headers.get('host') ?? new URL(request.url).host; } catch { return null; }
    return new URL(origin.origin).host.toLowerCase() === host.toLowerCase() ? origin : null;
  }

  sessionCookie(value, { expires, maxAge, secure }) {
    return [`${COOKIE_NAME}=${value}`, `Path=${COOKIE_PATH}`, `Expires=${new Date(expires).toUTCString()}`,
      `Max-Age=${maxAge}`, 'HttpOnly', ...(secure ? ['Secure'] : []), 'SameSite=Strict'].join('; ');
  }

  signature(encoded) {
    return createHmac('sha256', this.signingKey).update(SIGNING_DOMAIN).update(encoded).digest();
  }

  sign(payload) {
    const data = JSON.stringify(payload);
    if (Buffer.byteLength(data) > MAX_PAYLOAD_BYTES) throw new Error('session payload is invalid');
    const encoded = base64url(Buffer.from(data));
    return `${encoded}.${base64url(this.signature(encoded))}`;
  }

  // Failure accounting uses a bounded pair of counters; successful logins
  // allocate no server-side sessions.
  checkKey(key, nowMs) {
    const provided = sha256(typeof key === 'string' ? key : '');
    if (!this.windowFrom || nowMs >= this.windowFrom + LOGIN_WINDOW_MS) {
      this.windowFrom = nowMs;
      this.failures = 0;
    }
    if (this.failures >= MAX_LOGIN_FAILURES) {
      return { status: 429, retryAfter: Math.ceil((this.windowFrom + LOGIN_WINDOW_MS - nowMs) / 1000) };
    }
    if (!timingSafeEqual(provided, this.keyHash)) {
      this.failures += 1;
      return { status: 401 };
    }
    return { status: 200 };
  }

  // `audit` receives fixed event names only; the key is never logged.
  async login(request, log) {
    if (request.method !== 'POST') {
      return errorResponse(405, '此操作仅支持 POST 请求', { Allow: 'POST' });
    }
    const origin = this.requestOrigin(request);
    if (!origin) {
      log?.warn('admin_login', { outcome: 'rejected_origin' });
      return errorResponse(403, '请从管理页面提交请求');
    }
    if (mediaType(request) !== 'application/json') {
      return errorResponse(415, '请求格式必须为 application/json');
    }
    let body;
    try {
      const text = await request.text();
      if (Buffer.byteLength(text) > MAX_LOGIN_BODY) throw new Error('too large');
      body = JSON.parse(text);
      if (body === null || typeof body !== 'object' || Array.isArray(body) ||
          Object.keys(body).some((name) => name !== 'key') || typeof body.key !== 'string') {
        throw new Error('invalid');
      }
    } catch {
      return errorResponse(400, '登录请求格式不正确');
    }
    const nowMs = this.now();
    const result = this.checkKey(body.key, nowMs);
    if (result.status === 429) {
      log?.warn('admin_login', { outcome: 'rate_limited', retryAfter: result.retryAfter });
      return errorResponse(429, '登录失败次数过多，请稍后重试', { 'Retry-After': String(result.retryAfter) });
    }
    if (result.status !== 200) {
      log?.warn('admin_login', { outcome: 'bad_key', failures: this.failures });
      return errorResponse(401, '管理密钥不正确');
    }
    const issued = Math.floor(nowMs / 1000);
    const payload = {
      v: 2, iat: issued, exp: issued + this.ttl, nonce: randomToken(), csrf: randomToken(), origin: origin.origin,
    };
    log?.info('admin_login', { outcome: 'success' });
    return jsonResponse(200, {
      authenticated: true, user: { subject: 'admin', name: '管理员' }, csrfToken: payload.csrf,
    }, { 'Set-Cookie': this.sessionCookie(this.sign(payload), {
      expires: payload.exp * 1000, maxAge: this.ttl, secure: origin.secure,
    }) });
  }

  logout(request, log) {
    if (request.method !== 'POST') {
      return errorResponse(405, '此操作仅支持 POST 请求', { Allow: 'POST' });
    }
    const session = this.session(request, log);
    if (!session) return errorResponse(401, '请先登录');
    if (!this.checkMutation(request, session)) {
      return errorResponse(403, '请求来源或安全令牌无效，请刷新页面后重试');
    }
    log?.info('admin_logout', { outcome: 'success' });
    return new Response(null, { status: 204, headers: {
      'Cache-Control': 'no-store',
      'Set-Cookie': this.sessionCookie('', { expires: 1000, maxAge: 0, secure: session.origin.startsWith('https://') }),
    } });
  }

  // Returns the verified session or null. The rejection reason is logged at
  // debug level (never the token) to explain unexpected sign-outs.
  session(request, log) {
    const reject = (cause) => { log?.debug('admin_session_rejected', { cause }); return null; };
    const cookie = cookieValue(request);
    if (cookie.missing) return null;
    if (cookie.invalid) return reject(cookie.invalid);
    const { token } = cookie;
    if (token.length > MAX_TOKEN_BYTES) return reject('token_too_long');
    const dot = token.indexOf('.');
    if (dot < 0) return reject('malformed');
    const encoded = token.slice(0, dot);
    const signature = token.slice(dot + 1);
    if (encoded.length > Math.ceil(MAX_PAYLOAD_BYTES * 4 / 3) || signature.length !== 43) return reject('malformed');
    const actual = decodeStrict(signature);
    const expected = this.signature(encoded);
    if (!actual || actual.length !== expected.length || !timingSafeEqual(actual, expected)) return reject('bad_signature');
    const data = decodeStrict(encoded);
    if (!data || data.length > MAX_PAYLOAD_BYTES) return reject('malformed');
    let payload;
    try {
      payload = JSON.parse(data.toString('utf8'));
    } catch { return reject('malformed'); }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload) ||
        Object.keys(payload).length !== PAYLOAD_KEYS.length ||
        !PAYLOAD_KEYS.every((name) => Object.hasOwn(payload, name))) return reject('malformed');
    const nowSeconds = Math.floor(this.now() / 1000);
    if (payload.v !== 2 || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) ||
        payload.iat <= 0 || payload.iat > nowSeconds || payload.exp <= payload.iat ||
        payload.exp - payload.iat > this.ttl || !validRandomToken(payload.nonce) ||
        !validRandomToken(payload.csrf)) return reject('invalid_claims');
    if (payload.exp <= nowSeconds) return reject('expired');
    const origin = parseOrigin(payload.origin);
    if (!origin) return reject('invalid_origin');
    return { subject: 'admin', name: '管理员', csrfToken: payload.csrf, origin: origin.origin };
  }

  checkMutation(request, session) {
    const origin = this.requestOrigin(request);
    const token = request.headers.get('x-csrf-token');
    if (!origin || origin.origin !== session.origin || !validRandomToken(token) ||
        !validRandomToken(session.csrfToken)) return false;
    return timingSafeEqual(Buffer.from(token), Buffer.from(session.csrfToken));
  }
}
