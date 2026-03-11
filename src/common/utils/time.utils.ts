export function nowMs(): number { return Date.now(); }

export function msUntilNextUtcMidnight(): number {
  const now = new Date();
  const ms = now.getUTCHours() * 3_600_000 + now.getUTCMinutes() * 60_000
    + now.getUTCSeconds() * 1_000 + now.getUTCMilliseconds();
  return 86_400_000 - ms;
}
