import assert from 'node:assert/strict';
import test from 'node:test';
import { createMinecraftProxyHandler } from '../web/lib/minecraft-proxy.mjs';

const ORIGIN = 'https://minecraft.example.test';
const ENV = { MC_PROXY_PUBLIC_ORIGIN: ORIGIN };
const LIMIT = 1024 * 1024;

function setup({ fetchImpl, timeoutMs = 1_000, env = ENV, wrapRequest = (request) => request } = {}) {
  const calls = [];
  const logs = [];
  const handler = createMinecraftProxyHandler({
    timeoutMs,
    log: (entry) => logs.push(entry),
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return fetchImpl ? fetchImpl(url, options) : new Response('upstream body');
    },
  });
  return {
    calls,
    logs,
    request: (path = '/mc-proxy/services/publickeys', options = {}) => {
      const { server, ...init } = options;
      return handler({
        env, server,
        request: wrapRequest(new Request(`https://untrusted.example.test${path}`, init)),
      });
    },
  };
}

function discoveryDocument() {
  return {
    environment: 'prod',
    product: 'minecraft',
    discovery: {
      minecraft: {
        validUris: ['https://api.minecraftservices.com', 'https://sessionserver.mojang.com'],
        endpoints: {
          certificates: { uri: 'https://api.minecraftservices.com/player/certificates', method: 'POST' },
          profile: { uri: 'https://api.minecraftservices.com/minecraft/profile/name/{name}', method: 'GET' },
          session: { uri: 'https://sessionserver.mojang.com/session/minecraft/profile/{profileId}?unsigned=false' },
          textures: { validUris: ['https://textures.minecraft.net/texture/'] },
        },
      },
      account: {
        validUris: ['https://api.mojang.com', 'https://authserver.mojang.com'],
        endpoints: {
          names: { uri: 'https://api.mojang.com/users/profiles/minecraft/{name}' },
          auth: { uri: 'https://authserver.mojang.com/authenticate' },
        },
      },
    },
    extra: { untouched: true },
  };
}

function noStore(response) {
  assert.equal(response.headers.get('cache-control'), 'no-store');
}

async function bodyBytes(body) {
  return new Uint8Array(await new Response(body).arrayBuffer());
}

test('a valid configured HTTPS origin is required before any upstream request', async () => {
  for (const value of [undefined, '', 'http://proxy.test', 'https://user:secret@proxy.test',
    'https://proxy.test/subpath', 'https://proxy.test?redirect=secret', 'https://proxy.test#fragment',
    'not a URL', '//proxy.test']) {
    const app = setup({ env: value === undefined ? {} : { MC_PROXY_PUBLIC_ORIGIN: value } });
    const result = await app.request();
    assert.equal(result.status, 503, `configuration ${value}`);
    noStore(result);
    const body = await result.text();
    assert.doesNotMatch(body, /user:secret|redirect=secret/);
    assert.doesNotMatch(JSON.stringify(app.logs), /user:secret|redirect=secret/);
    assert.equal(app.logs.at(-1).code, 'MC_PROXY_PUBLIC_ORIGIN_INVALID');
    assert.equal(app.calls.length, 0);
  }
});

test('fixed route aliases preserve the encoded path and query without trusting the incoming Host', async () => {
  const app = setup();
  for (const [route, upstream] of Object.entries({
    auth: 'authserver.mojang.com', account: 'api.mojang.com', session: 'sessionserver.mojang.com',
    services: 'api.minecraftservices.com', profiles: 'api.mojang.com',
  })) {
    const result = await app.request(`/mc-proxy/${route}/profile/a%2Fb?name=A%20B&name=C&redirect=https%3A%2F%2Fevil.test`,
      { headers: { Host: 'evil.test', Origin: 'https://evil.test' } });
    assert.equal(result.status, 200);
    noStore(result);
    assert.equal(await result.text(), 'upstream body');
    assert.equal(app.calls.at(-1).url,
      `https://${upstream}/profile/a%2Fb?name=A%20B&name=C&redirect=https%3A%2F%2Fevil.test`);
  }
});

test('route names cannot turn the endpoint into an arbitrary or prototype-derived proxy', async () => {
  const app = setup();
  for (const path of ['/mc-proxy/constructor/publickeys', '/mc-proxy/__proto__/publickeys',
    '/mc-proxy/toString/publickeys', '/mc-proxy/https://evil.test/path', '/mc-proxy/unknown/path',
    '/mc-proxy/discovery/other', '/mc-proxy', '/other/services/publickeys']) {
    const result = await app.request(path);
    assert.ok(result.status >= 400 && result.status < 500, path);
    noStore(result);
  }
  assert.equal(app.calls.length, 0);
});

test('authority-like paths and user-supplied target queries keep the fixed upstream authority', async () => {
  const app = setup();
  for (const path of ['//evil.test/path', '/https://evil.test/path', '/%2F%2Fevil.test/path',
    '/@evil.test/path']) {
    const result = await app.request(`/mc-proxy/services${path}?url=https://evil.test&host=evil.test`);
    assert.equal(result.status, 200);
    const sent = new URL(app.calls.at(-1).url);
    assert.equal(sent.origin, 'https://api.minecraftservices.com');
    assert.equal(sent.pathname, path);
    assert.equal(sent.search, '?url=https://evil.test&host=evil.test');
  }
});

test('only allowed request headers reach Minecraft, including conditional key requests', async () => {
  const app = setup();
  const result = await app.request('/mc-proxy/services/publickeys', { headers: {
    Accept: 'application/json', 'Content-Type': 'application/json', Authorization: 'Bearer private-token',
    'User-Agent': 'Minecraft Java', 'If-None-Match': '"key-version"',
    Cookie: 'admin_session=private-cookie', Origin: 'https://evil.test', Host: 'evil.test',
    'X-Forwarded-For': '192.0.2.1', 'X-Forwarded-Host': 'evil.test',
    'Accept-Encoding': 'gzip', 'Cache-Control': 'public, max-age=86400', 'X-Api-Key': 'private-admin-key',
  } });
  assert.equal(result.status, 200);
  const { options } = app.calls[0];
  const headers = new Headers(options.headers);
  assert.deepEqual(Object.fromEntries(headers), {
    accept: 'application/json', 'accept-encoding': 'identity', authorization: 'Bearer private-token',
    'cache-control': 'no-store', 'content-type': 'application/json',
    'if-none-match': '"key-version"', 'user-agent': 'Minecraft Java',
  });
  assert.ok(['manual', 'error'].includes(options.redirect));
  assert.ok(options.signal instanceof AbortSignal);
});

test('authentication POSTs and friend mutations preserve their methods and exact body bytes', async () => {
  const payload = new TextEncoder().encode('{ "accessToken": "private-token", "name": "玩家" }\n');
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const app = setup();
    const result = await app.request('/mc-proxy/services/friends?requestId=a%2Bb', {
      method, body: payload, headers: { 'Content-Type': 'application/json' },
    });
    assert.equal(result.status, 200);
    assert.equal(app.calls[0].options.method, method);
    assert.deepEqual(await bodyBytes(app.calls[0].options.body), payload);
    assert.equal(app.calls[0].url, 'https://api.minecraftservices.com/friends?requestId=a%2Bb');
  }
});

test('Makers parsed, promised and throwing body getters cannot alter the native request bytes', async () => {
  const valid = '{ "accessToken": "private-token", "name": "玩家", "extra": null }\n';
  const malformed = '{ "accessToken": "private-token", malformed JSON\n';
  for (const [raw, wrappedBody] of [
    [valid, () => JSON.parse(valid)],
    [valid, () => Promise.resolve(JSON.parse(valid))],
    [malformed, () => { throw new SyntaxError('private invalid JSON parser detail'); }],
  ]) {
    let getterReads = 0;
    const payload = new TextEncoder().encode(raw);
    const app = setup({ wrapRequest: (request) => Object.defineProperty(request, 'body', { get() {
      getterReads += 1;
      return wrappedBody();
    } }) });
    const result = await app.request('/mc-proxy/auth/authenticate', {
      method: 'POST', body: payload, headers: { 'Content-Type': 'application/json' },
    });
    assert.equal(result.status, 200);
    assert.equal(getterReads, 0);
    assert.equal(app.calls.length, 1);
    assert.deepEqual(await bodyBytes(app.calls[0].options.body), payload);
    assert.equal(new Headers(app.calls[0].options.headers).get('content-type'), 'application/json');
  }
});

test('Makers parsed body overrides cannot bypass the native byte limit', async () => {
  let getterReads = 0;
  const app = setup({ wrapRequest: (request) => Object.defineProperty(request, 'body', { get() {
    getterReads += 1;
    return { short: true };
  } }) });
  const result = await app.request('/mc-proxy/auth/authenticate', {
    method: 'POST', body: new Uint8Array(LIMIT + 1), headers: { 'Content-Type': 'application/json' },
  });
  assert.equal(result.status, 413);
  assert.equal(getterReads, 0);
  assert.equal(app.calls.length, 0);
  noStore(result);
});

test('Makers body overrides cannot bypass the native stream timeout or cancellation',
  { timeout: 1_000 }, async () => {
    let cancelled = false;
    let getterReads = 0;
    const app = setup({ timeoutMs: 20,
      wrapRequest: (request) => Object.defineProperty(request, 'body', { get() {
        getterReads += 1;
        return Promise.resolve({ complete: true });
      } }),
    });
    const body = new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{ "partial":')); },
      cancel() { cancelled = true; },
    });
    const result = await app.request('/mc-proxy/auth/authenticate', {
      method: 'POST', body, duplex: 'half', headers: { 'Content-Type': 'application/json' },
    });
    assert.equal(result.status, 504);
    assert.equal(getterReads, 0);
    assert.equal(cancelled, true);
    assert.equal(app.calls.length, 0);
    noStore(result);
  });

test('unsupported methods return a no-store 405 with an Allow header before fetching', async () => {
  const app = setup();
  const result = await app.request('/mc-proxy/services/publickeys', { method: 'OPTIONS' });
  assert.equal(result.status, 405);
  noStore(result);
  const allowed = new Set(result.headers.get('allow').split(/,\s*/));
  for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']) assert.ok(allowed.has(method));
  assert.ok(!allowed.has('OPTIONS'));
  assert.equal(app.calls.length, 0);
});

test('discovery rewrites endpoint origins while preserving templates, metadata and validUris', async () => {
  const original = discoveryDocument();
  const app = setup({ fetchImpl: async () => Response.json(original) });
  const result = await app.request('/mc-proxy/discovery/minecraft/client', {
    headers: { Host: 'evil.test', 'X-Forwarded-Host': 'evil.test',
      Authorization: 'Bearer private-token', Cookie: 'admin_session=private-cookie' },
  });
  assert.equal(result.status, 200);
  noStore(result);
  assert.equal(app.calls[0].url, 'https://discovery.minecraftservices.com/minecraft/client');
  assert.deepEqual(Object.fromEntries(new Headers(app.calls[0].options.headers)), {
    'accept-encoding': 'identity', 'cache-control': 'no-store',
  });
  const expected = structuredClone(original);
  expected.discovery.minecraft.endpoints.certificates.uri = `${ORIGIN}/mc-proxy/services/player/certificates`;
  expected.discovery.minecraft.endpoints.profile.uri = `${ORIGIN}/mc-proxy/services/minecraft/profile/name/{name}`;
  expected.discovery.minecraft.endpoints.session.uri = `${ORIGIN}/mc-proxy/session/session/minecraft/profile/{profileId}?unsigned=false`;
  expected.discovery.account.endpoints.names.uri = `${ORIGIN}/mc-proxy/profiles/users/profiles/minecraft/{name}`;
  expected.discovery.account.endpoints.auth.uri = `${ORIGIN}/mc-proxy/auth/authenticate`;
  assert.deepEqual(await result.json(), expected);
});

test('discovery refuses extra query parameters before fetching its fixed document', async () => {
  const app = setup({ fetchImpl: async () => Response.json(discoveryDocument()) });
  const result = await app.request('/mc-proxy/discovery/minecraft/client?url=https://evil.test');
  assert.equal(result.status, 400);
  noStore(result);
  assert.equal(app.calls.length, 0);
});

test('discovery HEAD validates the rewritten document but returns no body or stale ETag', async () => {
  const app = setup({ fetchImpl: async () => Response.json(discoveryDocument(), {
    headers: { ETag: '"unmodified-upstream-representation"' },
  }) });
  const result = await app.request('/mc-proxy/discovery/minecraft/client', { method: 'HEAD' });
  assert.equal(result.status, 200);
  assert.equal(app.calls[0].options.method, 'GET');
  assert.equal(result.headers.get('etag'), null);
  assert.equal(await result.text(), '');
  noStore(result);
});

test('discovery rejects unknown or spoofed endpoint authorities without publishing partial results', async () => {
  for (const uri of ['https://evil.test/authenticate', 'https://api.minecraftservices.com.evil.test/player',
    'https://api.minecraftservices.com@evil.test/player', 'http://api.minecraftservices.com/player',
    'https://api.minecraftservices.com:444/player', '/relative/player']) {
    const document = discoveryDocument();
    document.discovery.minecraft.endpoints.profile.uri = uri;
    const app = setup({ fetchImpl: async () => Response.json(document) });
    const result = await app.request('/mc-proxy/discovery/minecraft/client');
    assert.equal(result.status, 502, uri);
    noStore(result);
    assert.doesNotMatch(await result.text(), /evil\.test|certificates/);
  }
});

test('malformed discovery JSON and endpoint shapes fail closed', async () => {
  const malformed = [null, [], {}, { discovery: [] },
    { ...discoveryDocument(), discovery: { minecraft: { endpoints: [] } } },
    { ...discoveryDocument(), discovery: { minecraft: { endpoints: { key: { uri: 42 } } } } },
  ];
  for (const value of malformed) {
    const app = setup({ fetchImpl: async () => Response.json(value) });
    const result = await app.request('/mc-proxy/discovery/minecraft/client');
    assert.equal(result.status, 502, JSON.stringify(value));
    noStore(result);
  }
  const app = setup({ fetchImpl: async () => new Response('not-json private-upstream-data') });
  const result = await app.request('/mc-proxy/discovery/minecraft/client');
  assert.equal(result.status, 502);
  assert.doesNotMatch(await result.text(), /private-upstream-data/);
});

test('HTTP errors preserve Minecraft body/status and relevant headers without cache or cookie leakage', async () => {
  for (const status of [400, 401, 403, 404, 429, 500, 503]) {
    const bytes = new TextEncoder().encode(`{ "error": "Minecraft error ${status}" }\n`);
    const app = setup({ fetchImpl: async () => new Response(bytes, { status, headers: {
      'Content-Type': 'application/json', 'Retry-After': '12', 'WWW-Authenticate': 'Bearer realm="Minecraft"',
      ETag: '"key-version"', 'Set-Cookie': 'session=upstream-private',
      'Content-Length': String(bytes.length), 'Content-Encoding': 'gzip', 'Cache-Control': 'public,max-age=3600',
      'Access-Control-Allow-Origin': '*', 'X-Upstream-Internal': 'private-upstream-header',
    } }) });
    const result = await app.request();
    assert.equal(result.status, status);
    assert.deepEqual(new Uint8Array(await result.arrayBuffer()), bytes);
    noStore(result);
    assert.equal(result.headers.get('content-type'), 'application/json');
    assert.equal(result.headers.get('retry-after'), '12');
    assert.equal(result.headers.get('www-authenticate'), 'Bearer realm="Minecraft"');
    assert.equal(result.headers.get('etag'), '"key-version"');
    for (const header of ['set-cookie', 'content-length', 'content-encoding', 'access-control-allow-origin', 'x-upstream-internal']) {
      assert.equal(result.headers.get(header), null, header);
    }
  }
});

test('upstream redirects cannot forward tokens to a new authority or leak Location', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const app = setup({ fetchImpl: async () => new Response('private redirect body', {
      status, headers: { Location: 'https://evil.test/collect?token=private-token' },
    }) });
    const result = await app.request('/mc-proxy/auth/authenticate', {
      method: 'POST', body: '{"accessToken":"private-token"}',
    });
    assert.equal(result.status, 502);
    noStore(result);
    assert.equal(result.headers.get('location'), null);
    assert.doesNotMatch(await result.text(), /private|evil\.test/);
    assert.equal(app.calls.length, 1);
    assert.ok(['manual', 'error'].includes(app.calls[0].options.redirect));
  }
});

test('HEAD, 204 and conditional 304 responses keep their required empty bodies', async () => {
  const head = setup({ fetchImpl: async () => new Response('ignored HEAD body', {
    headers: { 'Content-Type': 'application/json' },
  }) });
  const headResult = await head.request('/mc-proxy/services/publickeys', { method: 'HEAD' });
  assert.equal(headResult.status, 200);
  assert.equal(head.calls[0].options.method, 'HEAD');
  assert.equal(await headResult.text(), '');
  noStore(headResult);
  for (const status of [204, 304]) {
    const app = setup({ fetchImpl: async () => new Response(null, { status, headers: { ETag: '"key-version"' } }) });
    const result = await app.request();
    assert.equal(result.status, status);
    assert.equal(await result.text(), '');
    assert.equal(result.headers.get('etag'), '"key-version"');
    noStore(result);
  }
});

test('network failures return generic no-store errors without credentials or internal diagnostics', async () => {
  const app = setup({ fetchImpl: async () => { throw new Error('private-token at 192.0.2.99 internal socket'); } });
  const result = await app.request();
  assert.equal(result.status, 502);
  noStore(result);
  const body = await result.text();
  assert.equal(JSON.parse(body).error, 'UPSTREAM_UNAVAILABLE');
  assert.doesNotMatch(body, /private-token|192\.0\.2\.99|internal socket/);
  assert.equal(app.logs.at(-1).event, 'mc_proxy');
  assert.equal(app.logs.at(-1).operation, 'publickeys');
  assert.equal(app.logs.at(-1).code, 'UPSTREAM_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(app.logs), /private-token|192\.0\.2\.99|internal socket/);
});

test('idempotent reads retry one transport failure and mutations stay single-shot', async () => {
  let reads = 0;
  const read = setup({ fetchImpl: async () => {
    reads += 1;
    if (reads === 1) {
      const error = new Error('https://sessionserver.mojang.com/session/minecraft/hasJoined?serverId=secret-token');
      error.code = 'ECONNRESET';
      error.name = 'SocketError';
      throw error;
    }
    return new Response('upstream body');
  } });
  const result = await read.request('/mc-proxy/services/publickeys');
  assert.equal(result.status, 200);
  assert.equal(reads, 2);
  assert.equal(read.logs[0].result, 'retry');
  assert.equal(read.logs[0].code, 'UPSTREAM_CONNECT_FAILED');
  assert.equal(read.logs[0].operation, 'publickeys');
  assert.equal(read.logs[0].service, 'services');
  assert.equal(read.logs[0].errorCode, 'ECONNRESET');
  assert.equal(read.logs[0].errorName, 'SocketError');
  assert.equal(read.logs.at(-1).result, 'ok');
  assert.equal(read.logs.at(-1).attempt, 2);
  assert.doesNotMatch(JSON.stringify(read.logs), /secret-token|sessionserver|hasJoined\?/);

  let writes = 0;
  const write = setup({ fetchImpl: async () => {
    writes += 1;
    const error = new Error('secret-token');
    error.code = 'ECONNRESET';
    throw error;
  } });
  const denied = await write.request('/mc-proxy/session/session/minecraft/join', {
    method: 'POST', body: '{"accessToken":"secret-token"}',
  });
  assert.equal(denied.status, 502);
  assert.equal(writes, 1);
  assert.equal(JSON.parse(await denied.text()).error, 'UPSTREAM_CONNECT_FAILED');
  assert.equal(write.logs.length, 1);
  assert.doesNotMatch(JSON.stringify(write.logs), /secret-token|accessToken/);
});

test('dns failures stay distinct from a generic upstream outage', async () => {
  const app = setup({ fetchImpl: async () => {
    const error = new Error('getaddrinfo ENOTFOUND sessionserver.mojang.com secret-token');
    error.code = 'ENOTFOUND';
    throw error;
  } });
  const result = await app.request('/mc-proxy/session/session/minecraft/hasJoined?serverId=secret-token&username=Player');
  assert.equal(result.status, 502);
  assert.equal(JSON.parse(await result.text()).error, 'UPSTREAM_DNS_FAILED');
  assert.equal(app.logs.at(-1).errorCode, 'ENOTFOUND');
  assert.equal(app.logs.at(-1).operation, 'hasJoined');
  assert.equal(app.logs.filter((entry) => entry.result === 'retry').length, 1);
  assert.doesNotMatch(JSON.stringify(app.logs), /secret-token|sessionserver|username|getaddrinfo/);
});

test('logs keep a safe region and request id and drop anything else', async () => {
  const app = setup();
  const result = await app.request('/mc-proxy/services/publickeys', {
    server: { region: 'ap-singapore', requestId: '189e9bfc-c2df-11f1-9525-525400ef7398', clientIp: '192.0.2.9' },
  });
  assert.equal(result.status, 200);
  assert.equal(app.logs.at(-1).region, 'ap-singapore');
  assert.equal(app.logs.at(-1).requestId, '189e9bfc-c2df-11f1-9525-525400ef7398');
  assert.equal(app.logs.at(-1).clientIp, undefined);
  const unsafe = setup();
  await unsafe.request('/mc-proxy/services/publickeys', {
    server: { region: 'not a region', requestId: 'raw error https://evil.test?token=secret' },
  });
  assert.equal(unsafe.logs.at(-1).region, undefined);
  assert.equal(unsafe.logs.at(-1).requestId, undefined);
  assert.doesNotMatch(JSON.stringify(unsafe.logs), /evil\.test|secret|192\.0\.2\.9/);
});

test('HEAD errors always have null response bodies, including errors before upstream access', async () => {
  const cases = [
    { config: { env: {} }, status: 503 },
    { path: '/mc-proxy/unknown/path', status: 404 },
    { path: '/mc-proxy/discovery/minecraft/client?invalid=1', status: 400 },
    { config: { fetchImpl: async () => { throw new Error('private failure'); } }, status: 502 },
    { config: { fetchImpl: async () => new Response('redirect', { status: 302,
      headers: { Location: 'https://evil.test' } }) }, status: 502 },
    { config: { timeoutMs: 10, fetchImpl: async () => new Promise(() => {}) }, status: 504 },
  ];
  for (const { config, path, status } of cases) {
    const app = setup(config);
    const result = await app.request(path, { method: 'HEAD' });
    assert.equal(result.status, status);
    assert.equal(result.body, null, `HEAD error ${status}`);
    assert.equal(await result.text(), '');
    noStore(result);
  }
});

test('the timeout aborts fetch and returns a generic 504', { timeout: 1_000 }, async () => {
  let signal;
  const app = setup({ timeoutMs: 20, fetchImpl: async (_url, options) => {
    signal = options.signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
      reject(new Error('private abort diagnostic'));
    }, { once: true }));
  } });
  const result = await app.request();
  assert.equal(result.status, 504);
  assert.equal(signal.aborted, true);
  noStore(result);
  const body = await result.text();
  assert.equal(JSON.parse(body).error, 'UPSTREAM_TIMEOUT');
  assert.doesNotMatch(body, /private abort diagnostic/);
  assert.equal(app.logs.at(-1).code, 'UPSTREAM_TIMEOUT');
  assert.doesNotMatch(JSON.stringify(app.logs), /private abort diagnostic/);
});

test('the timeout covers body consumption after upstream headers arrive', { timeout: 1_000 }, async () => {
  let signal;
  const app = setup({ timeoutMs: 20, fetchImpl: async (_url, options) => {
    signal = options.signal;
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('partial private response'));
      signal.addEventListener('abort', () => controller.error(new Error('private slow body')), { once: true });
    } }));
  } });
  const result = await app.request();
  assert.equal(result.status, 504);
  assert.equal(signal.aborted, true);
  noStore(result);
  assert.doesNotMatch(await result.text(), /partial private response|private slow body/);
});

test('request body timeout cancels the stream and never starts an upstream fetch after the response',
  { timeout: 1_000 }, async () => {
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('partial private token')); },
      cancel() { cancelled = true; },
    });
    const app = setup({ timeoutMs: 20 });
    const result = await app.request('/mc-proxy/auth/authenticate', { method: 'POST', body, duplex: 'half' });
    assert.equal(result.status, 504);
    assert.equal(cancelled, true);
    noStore(result);
    assert.equal(app.calls.length, 0);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(app.calls.length, 0);
    assert.doesNotMatch(await result.text(), /partial private token/);
  });

test('response body timeout cancels a stalled reader even when the stream ignores the fetch signal',
  { timeout: 1_000 }, async () => {
    let cancelled = false;
    const app = setup({ timeoutMs: 20, fetchImpl: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('partial private response')); },
      cancel() { cancelled = true; },
    })) });
    const result = await app.request();
    assert.equal(result.status, 504);
    assert.equal(cancelled, true);
    noStore(result);
    assert.doesNotMatch(await result.text(), /partial private response/);
  });

test('the request limit checks streamed bytes even when Content-Length is absent or understated', async () => {
  for (const headers of [{}, { 'Content-Length': '1' }, { 'Content-Length': String(LIMIT + 1) }]) {
    const app = setup();
    const result = await app.request('/mc-proxy/auth/authenticate', { method: 'POST',
      body: new Uint8Array(LIMIT + 1), headers });
    assert.equal(result.status, 413);
    noStore(result);
    assert.equal(app.calls.length, 0);
  }
  const app = setup();
  const result = await app.request('/mc-proxy/auth/authenticate', {
    method: 'POST', body: new Uint8Array(LIMIT),
  });
  assert.equal(result.status, 200);
  assert.equal((await bodyBytes(app.calls[0].options.body)).byteLength, LIMIT);
});

test('oversized upstream bodies fail closed at the byte limit regardless of claimed length', async () => {
  for (const headers of [{}, { 'Content-Length': '1' }, { 'Content-Length': String(LIMIT + 1) }]) {
    const app = setup({ fetchImpl: async () => new Response(new Uint8Array(LIMIT + 1), { headers }) });
    const result = await app.request();
    assert.equal(result.status, 502);
    noStore(result);
    assert.ok((await result.text()).length < 1_000);
  }
  const bytes = new Uint8Array(LIMIT);
  bytes[0] = 65;
  const app = setup({ fetchImpl: async () => new Response(bytes) });
  const result = await app.request();
  assert.equal(result.status, 200);
  assert.deepEqual(new Uint8Array(await result.arrayBuffer()), bytes);
});
