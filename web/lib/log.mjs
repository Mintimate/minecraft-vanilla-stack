// Structured, single-line JSON logging for Makers cloud functions.
//
// Makers collects console output as the function log, so each entry is one JSON
// object per line: {"ts","level","component","event",...fields}. Callers pass
// only fixed event names and allowlisted metadata. As a second line of defense,
// field names that commonly carry secrets or free text are redacted here, and
// nested values are dropped, so a careless call cannot leak a key, cookie,
// announcement text, ban reason or upstream response.

const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });
const REDACTED_FIELD = /pass(?:word)?|secret|token|authorization|cookie|credential|csrf|(?:^|_)key$|message|reason|body|text|payload|command|response/i;
const MAX_STRING = 200;

export function parseLogLevel(value, fallback = 'info') {
  const level = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return Object.hasOwn(LEVELS, level) ? level : fallback;
}

function clean(fields) {
  const result = {};
  for (const [name, value] of Object.entries(fields ?? {})) {
    if (value === undefined || value === null) continue;
    if (REDACTED_FIELD.test(name)) { result[name] = '[redacted]'; continue; }
    if (typeof value === 'string') result[name] = value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
    else if (typeof value === 'number') { if (Number.isFinite(value)) result[name] = value; }
    else if (typeof value === 'boolean') result[name] = value;
    else if (Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length <= 64)) {
      result[name] = value.slice(0, 16);
    }
    // Objects, errors and functions are intentionally dropped.
  }
  return result;
}

function defaultSink(level, line) {
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

// sink and clock are injectable for tests. context fields (for example the
// requestId) are attached to every entry written by this logger and its children.
export function createLogger({ component, level = 'info', context = {}, sink = defaultSink,
  clock = () => new Date().toISOString() } = {}) {
  const threshold = LEVELS[parseLogLevel(level)];
  const write = (name, event, fields) => {
    if (LEVELS[name] < threshold) return;
    try {
      const line = JSON.stringify({ ts: clock(), level: name, component, event,
        ...clean(context), ...clean(fields) });
      sink(name, line);
    } catch { /* Logging must never change a response. */ }
  };
  return {
    debug: (event, fields) => write('debug', event, fields),
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
    child: (extra = {}, childComponent = component) => createLogger({
      component: childComponent, level, context: { ...context, ...extra }, sink, clock,
    }),
  };
}

// Request metadata from the Makers EventContext. Only values that look like
// plain identifiers are accepted, so a malformed platform value cannot inject
// text into the log.
function label(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? value : undefined;
}

export function requestContext(context) {
  return {
    requestId: label(context?.server?.requestId) ?? label(context?.uuid),
    region: label(context?.server?.region),
  };
}

// Adapt an existing `log(entry)` callback style (entry.event + fields) to a
// level of the shared logger. Used by modules that predate this logger.
export function entryLogger(logger, level) {
  return ({ event = 'log', ...fields }) => logger[level](event, fields);
}
