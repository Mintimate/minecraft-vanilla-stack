// RFC 3339 timestamp with microsecond precision, for ordering observations that
// land within the same millisecond (the status cache compares sub-millisecond
// digits). Date alone only has millisecond resolution. The result has exactly
// nine fractional digits, e.g. 2026-10-06T04:00:00.123456000Z.
export function nowRfc3339Micro(
  wall = () => performance.timeOrigin + performance.now(),
) {
  const milliseconds = wall();
  const whole = Math.floor(milliseconds);
  const micros = Math.min(999, Math.floor((milliseconds - whole) * 1_000));
  return new Date(whole).toISOString().replace('Z', `${String(micros).padStart(3, '0')}000Z`);
}
