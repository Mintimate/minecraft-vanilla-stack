// Install the pinned runtime first: npm ci --prefix web
// Run: node --test tools/test_minecraft_proxy_route.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

const require = createRequire(new URL('../web/package.json', import.meta.url));
const { MockAgent, getGlobalDispatcher, setGlobalDispatcher } = require('undici');
const ENV = { MC_PROXY_PUBLIC_ORIGIN: 'https://minecraft.example.test' };

function requestHeaders(value) {
  if (!Array.isArray(value)) return new Headers(value);
  const pairs = [];
  for (let index = 0; index < value.length; index += 2) pairs.push([value[index], value[index + 1]]);
  return new Headers(pairs);
}

test('the actual Makers route uses pinned undici without invoking global fetch or retrying mutations', async (t) => {
  assert.equal(require('undici/package.json').version, require('./package.json').dependencies.undici);
  const originalFetch = globalThis.fetch;
  const originalDispatcher = getGlobalDispatcher();
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  let globalFetchCalls = 0;
  globalThis.fetch = async () => {
    globalFetchCalls += 1;
    throw new Error('Makers global fetch fallback must not be invoked');
  };
  setGlobalDispatcher(mockAgent);
  t.after(async () => {
    globalThis.fetch = originalFetch;
    setGlobalDispatcher(originalDispatcher);
    await mockAgent.close();
  });

  // Import only after replacing global fetch, so a route that captures the
  // platform's retrying wrapper fails this integration test.
  const { onRequest } = await import('../web/cloud-functions/mc-proxy/[[path]].js');
  assert.equal(getGlobalDispatcher(), mockAgent, 'the route must not replace a test dispatcher');

  await t.test('an official join denial retains its body/status and is sent exactly once', async () => {
    const rawBody = '{ "accessToken": "private-token", "selectedProfile": "profile-id", "serverId": "a+b" }\n';
    const officialError = '{"error":"ForbiddenOperationException","errorMessage":"Invalid token."}\n';
    const calls = [];
    mockAgent.get('https://sessionserver.mojang.com')
      .intercept({ path: '/session/minecraft/join?requestId=a%2Bb', method: 'POST' })
      .reply((options) => {
        calls.push(options);
        return { statusCode: 403, data: officialError, responseOptions: { headers: {
          'content-type': 'application/json', 'cache-control': 'public, max-age=3600',
          'set-cookie': 'upstream-session=private-cookie',
        } } };
      }).persist();

    const result = await onRequest({ env: ENV, request: new Request(
      'https://untrusted.example.test/mc-proxy/session/session/minecraft/join?requestId=a%2Bb', {
        method: 'POST', body: rawBody, headers: {
          Authorization: 'Bearer private-token', 'Content-Type': 'application/json',
          Cookie: 'admin_session=private-cookie', 'User-Agent': 'Minecraft Java',
          Origin: 'https://untrusted.example.test', 'X-Forwarded-For': '192.0.2.1',
        },
      },
    ) });

    assert.equal(result.status, 403);
    assert.equal(await result.text(), officialError);
    assert.equal(result.headers.get('content-type'), 'application/json');
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.equal(result.headers.get('set-cookie'), null);
    assert.equal(calls.length, 1);
    assert.equal(await new Response(calls[0].body).text(), rawBody);
    const headers = requestHeaders(calls[0].headers);
    assert.equal(headers.get('authorization'), 'Bearer private-token');
    assert.equal(headers.get('content-type'), 'application/json');
    assert.equal(headers.get('user-agent'), 'Minecraft Java');
    assert.equal(headers.get('accept-encoding'), 'identity');
    assert.equal(headers.get('cookie'), null);
    assert.equal(headers.get('origin'), null);
    assert.equal(headers.get('x-forwarded-for'), null);
    assert.equal(globalFetchCalls, 0);
  });

  await t.test('gzip responses are decoded once and stale encoding and length headers are removed', async () => {
    const officialBody = '{ "profileId": "test-profile", "name": "玩家" }\n';
    const compressed = gzipSync(Buffer.from(officialBody));
    let calls = 0;
    mockAgent.get('https://api.minecraftservices.com')
      .intercept({ path: '/minecraft/profile', method: 'GET' })
      .reply(() => {
        calls += 1;
        return { statusCode: 200, data: compressed, responseOptions: { headers: {
          'content-type': 'application/json', 'content-encoding': 'gzip',
          'content-length': String(compressed.byteLength), 'cache-control': 'max-age=3600',
        } } };
      });
    const result = await onRequest({ env: ENV,
      request: new Request('https://minecraft.example.test/mc-proxy/services/minecraft/profile') });
    assert.equal(result.status, 200);
    assert.equal(await result.text(), officialBody);
    assert.equal(result.headers.get('content-type'), 'application/json');
    assert.equal(result.headers.get('content-encoding'), null);
    assert.equal(result.headers.get('content-length'), null);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.equal(calls, 1);
    assert.equal(globalFetchCalls, 0);
  });

  mockAgent.assertNoPendingInterceptors();
  assert.equal(globalFetchCalls, 0);
});
