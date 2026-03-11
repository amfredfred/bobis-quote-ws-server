export function msUntilNextUtcMidnight(): number {
  const now = new Date();
  const utcHours = now.getUTCHours();
  const utcMinutes = now.getUTCMinutes();
  const utcSeconds = now.getUTCSeconds();
  const utcMillis = now.getUTCMilliseconds();

  const secondsIntoDay = utcHours * 3600 + utcMinutes * 60 + utcSeconds;
  const secondsUntilMidnight = 86400 - secondsIntoDay;

  return secondsUntilMidnight * 1000 - utcMillis;
}

export function isSameUtcDate(ts1: string, ts2: string): boolean {
  const date1 = new Date(ts1);
  const date2 = new Date(ts2);
  return date1.getUTCFullYear() === date2.getUTCFullYear() && date1.getUTCMonth() === date2.getUTCMonth() && date1.getUTCDate() === date2.getUTCDate();
}

export function getUtcMidnight(date: Date = new Date()): Date {
  const midnight = new Date(date);
  midnight.setUTCHours(0, 0, 0, 0);
  return midnight;
}

export function parseIso(timestamp: string): Date {
  return new Date(timestamp);
}

export function now(): string {
  return new Date().toISOString();
}

export function nowMs(): number {
  return new Date().getMilliseconds();
}
