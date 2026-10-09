import { Agent, fetch as upstreamFetch, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { createMinecraftProxyHandler } from '../../lib/minecraft-proxy.mjs';

// Makers wraps global fetch with a fallback proxy/retry even for HTTP errors.
// Authentication mutations must run once and retain the official status code.
// Replace only the default direct Agent. A test MockAgent, or an operator-supplied
// dispatcher, stays in place. Mojang publishes IPv6 addresses that often blackhole
// from mainland cloud egress and fail after about four seconds; Happy Eyeballs
// moves that attempt to IPv4 before authlib gives up on the login.
const dispatcher = getGlobalDispatcher();
if (dispatcher?.constructor?.name === 'Agent') {
  setGlobalDispatcher(new Agent({
    connect: { autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 250 },
    connectTimeout: 4_000,
    headersTimeout: 8_000,
    bodyTimeout: 8_000,
  }));
}

export const onRequest = createMinecraftProxyHandler({ fetchImpl: upstreamFetch });
