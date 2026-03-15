'use strict'

export function nowMs(): number { return Date.now(); }

export function msUntilNextUtcMidnight(): number {
  const now = new Date();
  const ms = now.getUTCHours() * 3_600_000 + now.getUTCMinutes() * 60_000
    + now.getUTCSeconds() * 1_000 + now.getUTCMilliseconds();
  return 86_400_000 - ms;
}

// ── Timezone-aware date helpers ────────────────────────────────────────────────
//
// All dates are stored as UTC in the DB (Postgres Timestamptz).
// These helpers convert UTC → user's local date for grouping and display,
// so that e.g. "trades on March 1st" means March 1st in the user's timezone,
// not UTC.

/**
 * Returns the local date string (YYYY-MM-DD) for a UTC date in the given timezone.
 * Uses Intl — no extra dependencies.
 *
 * Example: UTC 2024-03-01T23:00:00Z in America/New_York → "2024-03-01"
 *          UTC 2024-03-01T23:00:00Z in Asia/Tokyo       → "2024-03-02"
 */
export function toLocalDateString(utcDate: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(utcDate);
  // en-CA formats as YYYY-MM-DD — safe for DB queries and key comparisons
}

/**
 * Returns the local hour (0–23) for a UTC date in the given timezone.
 */
export function toLocalHour(utcDate: Date, timezone: string): number {
  const hourStr = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    hour12: false,
  }).format(utcDate);
  return parseInt(hourStr, 10) % 24;
}

/**
 * Returns the UTC start and end of a calendar month in the user's timezone.
 * e.g. "March 2024" in America/New_York →
 *   from: 2024-03-01T05:00:00Z (midnight EST)
 *   to:   2024-04-01T04:59:59Z (just before midnight EST)
 */
export function monthBoundariesInTz(
  year: number,
  month: number, // 1-based
  timezone: string,
): { from: Date; to: Date } {
  // Construct ISO strings in the target timezone, then parse as UTC
  const fromStr = `${year}-${String(month).padStart(2, '0')}-01T00:00:00`;
  const toStr = month === 12
    ? `${year + 1}-01-01T00:00:00`
    : `${year}-${String(month + 1).padStart(2, '0')}-01T00:00:00`;

  return {
    from: localToUtc(fromStr, timezone),
    to: new Date(localToUtc(toStr, timezone).getTime() - 1), // 1ms before next month start
  };
}

/**
 * Returns the UTC start and end of a calendar day in the user's timezone.
 * e.g. "2024-03-15" in America/New_York →
 *   from: 2024-03-15T05:00:00Z
 *   to:   2024-03-16T04:59:59Z
 */
export function dayBoundariesInTz(
  dateStr: string, // YYYY-MM-DD
  timezone: string,
): { from: Date; to: Date } {
  const from = localToUtc(`${dateStr}T00:00:00`, timezone);
  const to = new Date(localToUtc(`${dateStr}T00:00:00`, timezone).getTime() + 86_400_000 - 1);
  return { from, to };
}

/**
 * Converts a local datetime string (no timezone info) to UTC Date,
 * interpreting it as being in the given timezone.
 */
function localToUtc(localDateTimeStr: string, timezone: string): Date {
  // Use Intl to find the UTC offset for this timezone at this moment
  const naive = new Date(localDateTimeStr + 'Z'); // treat as UTC first
  const tzOffset = getTzOffsetMs(naive, timezone);
  return new Date(naive.getTime() - tzOffset);
}

/**
 * Returns the UTC offset in milliseconds for a given timezone at a given UTC instant.
 * Positive = ahead of UTC, negative = behind.
 */
function getTzOffsetMs(utcDate: Date, timezone: string): number {
  // Format the date in UTC and in the target timezone, compare
  const utcStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'UTC',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(utcDate);

  const tzStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(utcDate);

  const utcMs = new Date(utcStr.replace(',', '')).getTime();
  const tzMs = new Date(tzStr.replace(',', '')).getTime();
  return tzMs - utcMs;
}

