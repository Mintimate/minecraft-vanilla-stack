// Authlib 10 discovers full endpoint URLs; older releases use individual hosts.
// Keep every upstream fixed here: no request parameter may select an origin.
const UPSTREAMS = new Map([
  ['auth', 'https://authserver.mojang.com'],
  ['account', 'https://api.mojang.com'],
  ['session', 'https://sessionserver.mojang.com'],
  ['services', 'https://api.minecraftservices.com'],
  ['profiles', 'https://api.mojang.com'],
]);
const DISCOVERY = 'https://discovery.minecraftservices.com/minecraft/client';
const PREFIX = '/mc-proxy';
const LIMIT = 1024 * 1024;
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];
const REQUEST_HEADERS = ['accept', 'content-type', 'authorization', 'user-agent', 'if-none-match'];
const RESPONSE_HEADERS = ['content-type', 'retry-after', 'www-authenticate', 'etag'];

class ProxyError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

function safeErrorName(error) {
  const name = error?.name;
  return typeof name === 'string' && /^(?:Error|TypeError|DOMException|[A-Z][A-Za-z0-9]{0,40}Error)$/.test(name)
    ? name : 'Error';
}

function safeErrorCode(error) {
  const code = typeof error?.code === 'string' ? error.code
    : typeof error?.cause?.code === 'string' ? error.cause.code : '';
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : undefined;
}

// Classify transport failures without reading error.message. Undici and Node put
// the full upstream URL, including hasJoined query secrets, in that message.
function transportFailure(error, aborted) {
  const errorName = safeErrorName(error);
  const errorCode = safeErrorCode(error);
  const timeout = aborted
    || errorName === 'TimeoutError' || errorName === 'ConnectTimeoutError'
    || errorName === 'HeadersTimeoutError' || errorName === 'BodyTimeoutError'
    || errorCode === 'UND_ERR_CONNECT_TIMEOUT' || errorCode === 'UND_ERR_HEADERS_TIMEOUT'
    || errorCode === 'UND_ERR_BODY_TIMEOUT' || errorCode === 'ETIMEDOUT';
  if (timeout) return { status: 504, code: 'UPSTREAM_TIMEOUT', errorName, errorCode };
  if (errorCode === 'ENOTFOUND' || errorCode === 'EAI_AGAIN') {
    return { status: 502, code: 'UPSTREAM_DNS_FAILED', errorName, errorCode };
  }
  if (errorCode === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || errorCode === 'DEPTH_ZERO_SELF_SIGNED_CERT'
      || errorCode?.startsWith('CERT_') || errorCode?.startsWith('ERR_TLS_')) {
    return { status: 502, code: 'UPSTREAM_TLS_FAILED', errorName, errorCode };
  }
  if (errorName === 'SocketError' || [
    'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH',
    'UND_ERR_SOCKET', 'UND_ERR_CLOSED', 'UND_ERR_DESTROYED',
  ].includes(errorCode)) {
    return { status: 502, code: 'UPSTREAM_CONNECT_FAILED', errorName, errorCode };
  }
  return { status: 502, code: 'UPSTREAM_UNAVAILABLE', errorName, errorCode };
}

function operationOf(pathname, discovery) {
  if (discovery) return 'discovery';
  if (pathname.endsWith('/publickeys')) return 'publickeys';
  if (pathname.includes('/hasJoined')) return 'hasJoined';
  if (pathname.endsWith('/join')) return 'join';
  if (pathname.includes('/certificates')) return 'certificates';
  if (pathname.includes('/login_with_xbox')) return 'login';
  if (pathname.includes('/profile')) return 'profile';
  return 'other';
}

function safeLabel(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? value : undefined;
}

function defaultLog(entry) {
  const line = JSON.stringify(entry);
  if (entry.result === 'error' || entry.result === 'retry') console.error(line);
  else console.log(line);
}

function failure(status, code, headers = {}) {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: { ...headers, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function publicOrigin(value) {
  if (typeof value !== 'string' || /[\s\\@?#%]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.pathname !== '/') return null;
    return url.origin;
  } catch { return null; }
}

async function readLimited(body, status, signal) {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      length += value.byteLength;
      if (length > LIMIT) {
        await reader.cancel();
        throw new ProxyError(status, status === 413 ? 'REQUEST_TOO_LARGE' : 'UPSTREAM_RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function rewriteDiscovery(bytes, origin) {
  const invalid = () => new ProxyError(502, 'INVALID_UPSTREAM_DISCOVERY');
  let document;
  try { document = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw invalid(); }
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!object(document) || document.product !== 'minecraft' || typeof document.environment !== 'string' ||
      !object(document.discovery) || !Object.keys(document.discovery).length) throw invalid();
  const replacements = [
    ['https://sessionserver.mojang.com', 'session'],
    ['https://api.minecraftservices.com', 'services'],
    ['https://api.mojang.com', 'profiles'],
    ['https://authserver.mojang.com', 'auth'],
  ];
  let count = 0;
  for (const group of Object.values(document.discovery)) {
    if (!object(group) || !object(group.endpoints)) throw invalid();
    for (const endpoint of Object.values(group.endpoints)) {
      if (!object(endpoint)) throw invalid();
      if (!Object.hasOwn(endpoint, 'uri')) continue; // Texture validUris must stay official.
      if (typeof endpoint.uri !== 'string') throw invalid();
      const match = replacements.find(([host]) => endpoint.uri.startsWith(host + '/'));
      if (!match) throw invalid(); // Fail closed if Mojang introduces a new service origin.
      // Do not serialize with URL: it percent-encodes Authlib's {profileId}/{name} templates.
      endpoint.uri = origin + PREFIX + '/' + match[1] + endpoint.uri.slice(match[0].length);
      count++;
    }
  }
  if (!count) throw invalid();
  return JSON.stringify(document);
}

export function createMinecraftProxyHandler({ fetchImpl = fetch, timeoutMs = 8000, log = defaultLog } = {}) {
  return async function onRequest({ request, env = {}, server = {} }) {
    const started = Date.now();
    let service = 'proxy';
    let operation = 'reject';
    let attempt = 0;
    const region = safeLabel(server?.region);
    const requestId = safeLabel(server?.requestId);
    const report = (entry) => {
      const fields = {
        event: 'mc_proxy', service, operation, method: request.method,
        elapsedMs: Date.now() - started, ...entry,
      };
      if (region) fields.region = region;
      if (requestId) fields.requestId = requestId;
      if (attempt) fields.attempt = attempt;
      try { log(fields); } catch { /* Logging must not change the auth response. */ }
    };
    const fail = (status, code, headers = {}, detail = {}) => {
      const diagnostic = { result: 'error', status, code };
      if (detail.errorName) diagnostic.errorName = detail.errorName;
      if (detail.errorCode) diagnostic.errorCode = detail.errorCode;
      report(diagnostic);
      const response = failure(status, code, headers);
      return request.method === 'HEAD' ? new Response(null, response) : response;
    };
    const origin = publicOrigin(env.MC_PROXY_PUBLIC_ORIGIN);
    if (!origin) return fail(503, 'MC_PROXY_PUBLIC_ORIGIN_INVALID');
    const url = new URL(request.url);
    const discovery = url.pathname === PREFIX + '/discovery/minecraft/client';
    const route = url.pathname.match(/^\/mc-proxy\/([^/]+)(\/.*)?$/);
    if (!discovery && (!route || !UPSTREAMS.has(route[1]))) return fail(404, 'UNKNOWN_SERVICE');
    service = discovery ? 'discovery' : route[1];
    operation = operationOf(url.pathname, discovery);
    const allowed = discovery ? ['GET', 'HEAD'] : METHODS;
    if (!allowed.includes(request.method)) return fail(405, 'METHOD_NOT_ALLOWED', { allow: allowed.join(', ') });
    if (discovery && url.search) return fail(400, 'INVALID_DISCOVERY_REQUEST');
    if (Number(request.headers.get('content-length')) > LIMIT) return fail(413, 'REQUEST_TOO_LARGE');

    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new ProxyError(504, 'UPSTREAM_TIMEOUT'));
        controller.abort();
      }, timeoutMs);
    });
    // Public key and discovery reads are idempotent. A reset during the first
    // connect is the usual login failure; one retry stays inside the same budget.
    // Join and other mutations must still be sent exactly once.
    const fetchUpstream = async (target, init) => {
      const idempotent = request.method === 'GET' || request.method === 'HEAD';
      for (attempt = 1; attempt <= (idempotent ? 2 : 1); attempt += 1) {
        try {
          return await fetchImpl(target, init);
        } catch (error) {
          if (!idempotent || attempt === 2 || controller.signal.aborted || error instanceof ProxyError) throw error;
          const failure = transportFailure(error, false);
          report({
            result: 'retry', status: failure.status, code: failure.code,
            errorName: failure.errorName, ...(failure.errorCode ? { errorCode: failure.errorCode } : {}),
          });
        }
      }
      throw new ProxyError(502, 'UPSTREAM_UNAVAILABLE');
    };
    try {
      return await Promise.race([timeout, (async () => {
        const headers = { 'cache-control': 'no-store', 'accept-encoding': 'identity' };
        if (!discovery) {
          for (const name of REQUEST_HEADERS) {
            const value = request.headers.get(name);
            if (value !== null) headers[name] = value;
          }
        }
        // Makers overrides request.body with parsed JSON. Read the native Fetch
        // stream so whitespace, binary data and even invalid JSON stay unchanged.
        const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await readLimited(
          Object.getOwnPropertyDescriptor(Request.prototype, 'body').get.call(request), 413, controller.signal,
        );
        controller.signal.throwIfAborted();
        const target = discovery ? DISCOVERY : UPSTREAMS.get(route[1]) + (route[2] || '/') + url.search;
        const upstream = await fetchUpstream(target, {
          method: discovery ? 'GET' : request.method,
          headers, body, redirect: 'manual', cache: 'no-store', signal: controller.signal,
        });
        if (upstream.status >= 300 && upstream.status < 400 && upstream.status !== 304) {
          await upstream.body?.cancel();
          throw new ProxyError(502, 'UPSTREAM_REDIRECT');
        }
        if (discovery && upstream.status !== 200) {
          await upstream.body?.cancel();
          throw new ProxyError(502, 'UPSTREAM_DISCOVERY_UNAVAILABLE');
        }
        const bytes = await readLimited(upstream.body, 502, controller.signal);
        const responseHeaders = { 'cache-control': 'no-store' };
        for (const name of RESPONSE_HEADERS) {
          const value = upstream.headers.get(name);
          if (value !== null) responseHeaders[name] = value;
        }
        let result = bytes;
        if (discovery) {
          result = rewriteDiscovery(bytes, origin);
          responseHeaders['content-type'] = 'application/json; charset=utf-8';
          delete responseHeaders.etag; // The rewritten representation has different bytes.
        }
        const empty = request.method === 'HEAD' || [204, 205, 304].includes(upstream.status);
        report({
          result: upstream.status >= 400 ? 'upstream' : 'ok', status: upstream.status,
        });
        return new Response(empty ? null : result, { status: upstream.status, headers: responseHeaders });
      })()]);
    } catch (error) {
      if (error instanceof ProxyError) return fail(error.status, error.code);
      const failure = transportFailure(error, controller.signal.aborted);
      return fail(failure.status, failure.code, {}, failure);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  };
}
