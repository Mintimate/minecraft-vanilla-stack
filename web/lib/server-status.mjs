import { randomUUID } from 'node:crypto';
import { createLogger, entryLogger } from './log.mjs';

const INTERVAL_MS = 300_000;
const STORE_NAME = 'public-server-status-v1';
const SNAPSHOT_KEY = /^snapshots\/(\d+)\.json$/;
const ADMIN_SNAPSHOT_KEY = /^admin-snapshots\/(\d+)-(?:(\d{6})-)?[0-9a-f-]+\.json$/;
const LAST_ONLINE_KEY = /^last-online\/(\d+)-(\d{6})-[0-9a-f-]+\.json$/;
const CLAIM_KEY = /^claims\/(\d+)\.json$/;
const POLL_ATTEMPTS = 16;
const ERROR_MESSAGES = Object.freeze({
  STATUS_PROBE_NOT_CONFIGURED: 'RCON is not configured for the server status probe.',
  STATUS_PROBE_FAILED: 'The server status probe is unavailable.',
  STATUS_PROBE_INVALID_RESULT: 'The server status probe returned an invalid result.',
  STATUS_REFRESH_PENDING: 'A server status refresh is already in progress. Please retry shortly.',
  STATUS_CACHE_EMPTY: 'A server status sample is not available yet.',
  STATUS_PUBLISH_INVALID: 'The server status sample is invalid.',
  MISSING_ENVIRONMENT: 'Blob deployment credentials are not configured.',
  MISSING_PROJECT_ID: 'The Blob project is not configured.',
  CREDENTIAL_ERROR: 'Blob credentials could not be obtained.',
  INVALID_STORE_NAME: 'The Blob store configuration is invalid.',
  INVALID_KEY: 'The Blob cache key is invalid.',
  PRECONDITION_FAILED: 'The Blob conditional write could not be completed.',
  QUOTA_EXCEEDED: 'The Blob storage quota has been exceeded.',
  RATE_LIMITED: 'Blob requests are temporarily rate limited.',
  COS_ERROR: 'Blob storage is temporarily unavailable.',
  UNKNOWN_ERROR: 'Server status is temporarily unavailable.',
});

function failure(code) {
  return Object.assign(new Error(ERROR_MESSAGES[code]), { code });
}

// Failures are warnings and routine outcomes are informational; both go to the
// shared structured logger unless a test injects its own callbacks.
const statusLogger = createLogger({ component: 'status' });
const defaultLog = entryLogger(statusLogger, 'warn');
const defaultTrace = entryLogger(statusLogger, 'info');

function diagnose(log, stage, error) {
  // Never pass raw upstream errors, URLs, environment values, or stack traces to logs or clients.
  const code = typeof error?.code === 'string' && Object.hasOwn(ERROR_MESSAGES, error.code)
    ? error.code : 'UNKNOWN_ERROR';
  try { log({ event: 'server_status_failure', stage, code }); } catch { /* Logging must not break fallback. */ }
  return { code, message: ERROR_MESSAGES[code] };
}

function note(trace, entry) {
  try { trace({ event: 'server_status', ...entry }); } catch { /* Logging must not break the response. */ }
}

function timestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

// Keep sub-millisecond ordering from RFC3339 timestamps with up to nine
// fractional digits. The public timestamps remain ISO milliseconds for
// compatibility with existing clients.
function observation(value) {
  return typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && timestamp(value)
    ? value : null;
}

function submillis(value) {
  return (value.match(/\.(\d+)/)?.[1] ?? '').padEnd(9, '0').slice(3);
}

function compareObserved(a, b) {
  const left = a.observedAt;
  const right = b.observedAt;
  const milliseconds = Date.parse(left) - Date.parse(right);
  if (milliseconds) return milliseconds;
  return Number(submillis(left)) - Number(submillis(right));
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000;
}

function players(value) {
  if (!Array.isArray(value) || value.length > 10_000 ||
      !value.every((player) => player && typeof player.name === 'string' &&
        player.name.length > 0 && player.name.length <= 64 && !/[\u0000-\u001f\u007f]/.test(player.name))) return null;
  return value.map((player) => ({ name: player.name }));
}

// Construct public objects field by field: upstream/storage additions stay private.
function sample(value) {
  const names = players(value?.players);
  if (!value || !names ||
      !count(value.onlinePlayers) || !count(value.maxPlayers) || !timestamp(value.updatedAt)) return null;
  return {
    players: names,
    onlinePlayers: value.onlinePlayers,
    maxPlayers: value.maxPlayers,
    updatedAt: timestamp(value.updatedAt),
  };
}

function lastOnline(value, now) {
  const names = players(value?.players);
  const updatedAt = timestamp(value?.updatedAt);
  const observedAt = Date.parse(value?.observedAt) === Date.parse(updatedAt)
    ? observation(value?.observedAt) ?? observation(value?.updatedAt) : observation(value?.updatedAt);
  if (!names?.length || !updatedAt || !observedAt ||
      Date.parse(observedAt) > now + 5_000 || Date.parse(updatedAt) > now + 5_000) return null;
  return { players: names, updatedAt, observedAt };
}

function newestOnline(values) {
  return values.filter(Boolean).sort((a, b) => compareObserved(b, a))[0] ?? null;
}

function emptySample() {
  return { players: [], onlinePlayers: null, maxPlayers: null, updatedAt: null };
}

function snapshot(value, now) {
  if (!value || !['online', 'unavailable'].includes(value.status)) return null;
  const checkedAt = timestamp(value.checkedAt);
  if (!checkedAt || Date.parse(checkedAt) > now + 5_000) return null;
  let data = sample(value);
  if (!data && value.status === 'unavailable' && value.updatedAt === null &&
      value.onlinePlayers === null && value.maxPlayers === null &&
      Array.isArray(value.players) && value.players.length === 0) data = emptySample();
  const observedAt = observation(value.observedAt) ??
    (value.status === 'online' ? observation(value.updatedAt) : null) ?? checkedAt;
  if (Date.parse(observedAt) > now + 5_000) return null;
  return data ? { status: value.status, ...data, checkedAt, observedAt } : null;
}

function entries(blobs, pattern) {
  if (!Array.isArray(blobs)) throw new Error('Invalid cache listing');
  return blobs.flatMap((blob) => {
    const match = typeof blob?.key === 'string' && pattern.exec(blob.key);
    const slot = match ? Number(match[1]) : NaN;
    return Number.isSafeInteger(slot) && slot >= 0
      ? [{ key: blob.key, slot, submillis: Number(match[2] ?? 0) }] : [];
  }).sort((a, b) => b.slot - a.slot || b.submillis - a.submillis);
}

async function latest(store, now, log, beforeCleanup = false) {
  const sources = [
    { prefix: 'snapshots/', pattern: SNAPSHOT_KEY, source: 'automatic' },
    { prefix: 'admin-snapshots/', pattern: ADMIN_SNAPSHOT_KEY, source: 'admin' },
  ];
  const groups = await Promise.all(sources.map(async ({ prefix, pattern, source }) => {
    const { blobs } = await store.list({ prefix });
    // Bucket numbers and epoch milliseconds use separate prefixes. Compare
    // actual observation timestamps after reading a bounded set from each.
    // Normal visitor reads are bounded. Before GC, include any older records
    // retained during an archive outage so their final nonempty sample survives.
    const records = entries(blobs, pattern);
    return Promise.all((beforeCleanup ? records : records.slice(0, 6)).map(async (entry) => {
      const value = snapshot(await store.get(entry.key, { type: 'json' }), now);
      return value ? { ...value, source } : null;
    }));
  }));
  const candidates = groups.flat().filter(Boolean).sort((a, b) =>
    compareObserved(b, a) || Number(b.source === 'admin') - Number(a.source === 'admin'));
  let storedLastOnline = null;
  try {
    const { blobs } = await store.list({ prefix: 'last-online/' });
    storedLastOnline = newestOnline(await Promise.all(entries(blobs, LAST_ONLINE_KEY).slice(0, 6)
      .map(async ({ key }) => lastOnline(await store.get(key, { type: 'json' }), now))));
  } catch (error) { diagnose(log, 'last-online-read', error); }
  // Upgrade old caches using only successful samples that still exist. Failed
  // samples carry old players; they must never advance the historical timestamp.
  return {
    value: candidates[0] ?? null,
    lastOnline: newestOnline([storedLastOnline,
      ...candidates.filter((value) => value.status === 'online').map((value) => lastOnline(value, now))]),
    storedLastOnline,
  };
}

function fresh(value, now) {
  return value && now - Date.parse(value.checkedAt) < INTERVAL_MS;
}

function response(value, now, status = 200, forceStale = false, error, history = null) {
  return Response.json({
    status: value?.status ?? 'unavailable',
    ...(value ? sample(value) ?? emptySample() : emptySample()),
    checkedAt: value?.checkedAt ?? null,
    stale: forceStale || !fresh(value, now) || value?.status !== 'online',
    refreshIntervalSeconds: INTERVAL_MS / 1000,
    lastOnline: history ? { players: players(history.players), updatedAt: timestamp(history.updatedAt) } : null,
    ...(status === 503 && error ? { error } : {}),
  }, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      ...(status === 405 ? { Allow: 'GET' } : {}) },
  });
}

// The probe is injected (the production one reads the online list over RCON).
// It returns the public subset {players, onlinePlayers, maxPlayers, updatedAt}.
async function runProbe(probe, env) {
  let body;
  try { body = await probe(env); }
  catch (error) {
    throw failure(error?.code === 'STATUS_PROBE_NOT_CONFIGURED' ? 'STATUS_PROBE_NOT_CONFIGURED' : 'STATUS_PROBE_FAILED');
  }
  const data = sample(body);
  if (!data) throw failure('STATUS_PROBE_INVALID_RESULT');
  return { ...data, observedAt: observation(body.updatedAt) ?? data.updatedAt };
}

async function preserveLastOnline(store, candidate, stored, log) {
  if (!candidate || (stored && compareObserved(stored, candidate) >= 0)) return true;
  try {
    const key = `last-online/${Date.parse(candidate.observedAt)}-${submillis(candidate.observedAt)}-${randomUUID()}.json`;
    await store.setJSON(key, candidate, { onlyIfNew: true });
    return true;
  } catch (error) {
    diagnose(log, 'last-online-write', error);
    // Keep ordinary snapshots recoverable when archiving is temporarily down.
    return false;
  }
}

async function cleanup(store, slot, now, log) {
  const snapshots = entries((await store.list({ prefix: 'snapshots/' })).blobs, SNAPSHOT_KEY);
  const admin = entries((await store.list({ prefix: 'admin-snapshots/' })).blobs, ADMIN_SNAPSHOT_KEY);
  // UUID suffixes do not order observations within a millisecond. Preserve
  // RFC3339Nano ordering when deciding which three admin samples to retain.
  const recentAdmin = await Promise.all(admin.slice(0, 6).map(async (entry) => ({
    ...entry, value: snapshot(await store.get(entry.key, { type: 'json' }), now),
  })));
  recentAdmin.sort((a, b) => Number(Boolean(b.value)) - Number(Boolean(a.value)) ||
    (a.value && b.value ? compareObserved(b.value, a.value) : b.slot - a.slot));
  const claims = entries((await store.list({ prefix: 'claims/' })).blobs, CLAIM_KEY);
  const history = entries((await store.list({ prefix: 'last-online/' })).blobs, LAST_ONLINE_KEY);
  const obsolete = [
    ...snapshots.slice(3),
    ...recentAdmin.slice(3), ...admin.slice(6),
    ...claims.filter((entry) => entry.slot < slot - 2),
    ...history.slice(3),
  ].slice(0, 6);
  // A publisher may have stored a nonempty sample after our previous cache
  // read, then failed to archive it. Protect the exact immutable records this
  // cleanup is about to delete, including records from concurrent publishers.
  const retiring = await Promise.all(obsolete.filter(({ key }) =>
    SNAPSHOT_KEY.test(key) || ADMIN_SNAPSHOT_KEY.test(key)).map(async ({ key }) =>
    snapshot(await store.get(key, { type: 'json' }), now)));
  const candidate = newestOnline(retiring.filter((value) => value?.status === 'online')
    .map((value) => lastOnline(value, now)));
  if (candidate) {
    const stored = newestOnline(await Promise.all(history.slice(0, 6).map(async ({ key }) =>
      lastOnline(await store.get(key, { type: 'json' }), now))));
    if (!await preserveLastOnline(store, candidate, stored, log)) return candidate;
  }
  await Promise.allSettled(obsolete.map((entry) => store.delete(entry.key)));
  return candidate;
}

// Storage and clock are injected so independent serverless instances can be tested.
export function createStatusHandler({ getStore, probe, now = Date.now,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  log = defaultLog, trace = defaultTrace }) {
  return async function handle({ request, env }) {
    if (request.method !== 'GET') return response(null, now(), 405);
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);

    let store;
    let cached = null;
    let history = null;
    let storedHistory = null;
    let stage = 'config';
    const read = async (beforeCleanup = false) => {
      const result = await latest(store, now(), log, beforeCleanup);
      cached = result.value ?? cached;
      history = newestOnline([history, result.lastOnline]);
      storedHistory = newestOnline([storedHistory, result.storedLastOnline]);
    };
    // One summary line per request says how it was served and how long it took.
    const reply = (status = 200, stale = false, error, outcome = 'served') => {
      note(trace, { outcome, httpStatus: status, stale: stale || !fresh(cached, now()),
        sampleStatus: cached?.status, elapsedMs: elapsed() });
      return response(cached, now(), status, stale, error, history);
    };
    try {
      stage = 'blob-init';
      store = getStore({ name: STORE_NAME, consistency: 'strong' });
      stage = 'blob-read';
      await read();
      if (new URL(request.url).searchParams.get('cached') === '1') {
        return reply(cached ? 200 : 503, false,
          cached ? undefined : { code: 'STATUS_CACHE_EMPTY', message: ERROR_MESSAGES.STATUS_CACHE_EMPTY },
          'cache_only');
      }
      if (fresh(cached, now())) return reply(200, false, undefined, 'cache_hit');
      const slot = Math.floor(now() / INTERVAL_MS);
      try {
        stage = 'blob-claim';
        // Claims are immutable. Never delete an active claim to take over a lease.
        await store.setJSON(`claims/${slot}.json`, { claimedAt: new Date(now()).toISOString() }, { onlyIfNew: true });
      } catch (error) {
        if (error?.code !== 'PRECONDITION_FAILED') throw error;
        for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
          await sleep(500);
          stage = 'blob-read';
          await read();
          if (fresh(cached, now())) return reply(200, false, undefined, 'waited_for_refresh');
        }
        const diagnostic = diagnose(log, 'blob-claim', failure('STATUS_REFRESH_PENDING'));
        return reply(cached ? 200 : 503, true, diagnostic, 'refresh_pending');
      }

      // Another bucket may have completed while this request was claiming.
      stage = 'blob-read';
      await read();
      if (fresh(cached, now())) return reply(200, false, undefined, 'cache_hit');

      const observedAt = new Date(now()).toISOString();
      let next;
      const probeStarted = performance.now();
      try {
        next = { status: 'online', ...await runProbe(probe, env), checkedAt: new Date(now()).toISOString() };
        note(trace, { outcome: 'probe_ok', onlinePlayers: next.onlinePlayers, maxPlayers: next.maxPlayers,
          probeMs: Math.round(performance.now() - probeStarted) });
      } catch (error) {
        diagnose(log, 'probe', error);
        // A failed probe keeps the most recently known successful sample.
        stage = 'blob-read';
        await read();
        next = { status: 'unavailable', ...(cached ? sample(cached) ?? emptySample() : emptySample()),
          checkedAt: new Date(now()).toISOString(), observedAt };
      }
      // An administrator can publish while RCON is in flight. Neither a slow
      // success nor a slow failure may replace that newer observation.
      stage = 'blob-read';
      await read();
      if (cached?.source === 'admin' && compareObserved(cached, next) >= 0) {
        history = newestOnline([history, next.status === 'online' ? lastOnline(next, now()) : null]);
        await preserveLastOnline(store, history, storedHistory, log);
        return reply(200, false, undefined, 'admin_sample_newer');
      }
      // Per-bucket snapshots prevent a late old request overwriting a newer result.
      stage = 'blob-write';
      await store.setJSON(`snapshots/${slot}.json`, next, { onlyIfNew: true });
      cached = next;
      history = newestOnline([history, next.status === 'online' ? lastOnline(next, now()) : null]);
      let safeToClean = false;
      try { await read(true); safeToClean = true; } catch (error) { diagnose(log, 'blob-read', error); }
      if (await preserveLastOnline(store, history, storedHistory, log) && safeToClean) {
        try { history = newestOnline([history, await cleanup(store, Math.floor(now() / INTERVAL_MS), now(), log)]); }
        catch (error) { diagnose(log, 'blob-cleanup', error); }
      }
      return reply(200, false, undefined, 'refreshed');
    } catch (error) {
      // Storage failures never fall back to an uncached RCON request.
      const diagnostic = diagnose(log, stage, error);
      return reply(cached ? 200 : 503, true, diagnostic, 'error');
    }
  };
}

// Validates an administrator sample: exact public fields, consistent counts and
// a timestamp close to now. The sample comes from this same deployment's admin
// handler, never from a request body, so no public HTTP endpoint can publish.
function publishSample(body, now) {
  try {
    const data = sample(body);
    const observedAt = observation(body?.updatedAt);
    if (!data || !observedAt || Object.keys(body).some((key) =>
      !['players', 'onlinePlayers', 'maxPlayers', 'updatedAt'].includes(key)) ||
      body.players.some((player) => Object.keys(player).some((key) => key !== 'name')) ||
      data.players.length !== data.onlinePlayers ||
      Date.parse(observedAt) < now - INTERVAL_MS || Date.parse(observedAt) > now + 5_000) {
      throw failure('STATUS_PUBLISH_INVALID');
    }
    return { status: 'online', ...data, checkedAt: timestamp(observedAt), observedAt };
  } catch {
    throw failure('STATUS_PUBLISH_INVALID');
  }
}

// Stores an administrator observation so the public page shows it immediately.
// Resolves when the snapshot is stored (or a newer one already exists); rejects
// with a coded error after logging a safe diagnostic.
export function createStatusPublisher({ getStore, now = Date.now, log = defaultLog, trace = defaultTrace }) {
  return async function publish(body) {
    const started = performance.now();
    let stage = 'publish-body';
    try {
      const next = publishSample(body, now());
      stage = 'blob-init';
      const store = getStore({ name: STORE_NAME, consistency: 'strong' });
      stage = 'blob-read';
      const cached = await latest(store, now(), log, true);
      const history = newestOnline([cached.lastOnline, lastOnline(next, now())]);
      if (cached.value && compareObserved(cached.value, next) > 0) {
        await preserveLastOnline(store, history, cached.storedLastOnline, log);
        note(trace, { outcome: 'publish_superseded', elapsedMs: Math.round(performance.now() - started) });
        return;
      }
      stage = 'blob-write';
      const key = `admin-snapshots/${Date.parse(next.observedAt)}-${submillis(next.observedAt)}-${randomUUID()}.json`;
      await store.setJSON(key, next, { onlyIfNew: true });
      if (await preserveLastOnline(store, history, cached.storedLastOnline, log)) {
        try { await cleanup(store, Math.floor(now() / INTERVAL_MS), now(), log); }
        catch (error) { diagnose(log, 'blob-cleanup', error); }
      }
      note(trace, { outcome: 'published', onlinePlayers: next.onlinePlayers,
        elapsedMs: Math.round(performance.now() - started) });
    } catch (error) {
      const diagnostic = diagnose(log, stage, error);
      throw Object.assign(new Error(diagnostic.message), { code: diagnostic.code });
    }
  };
}
