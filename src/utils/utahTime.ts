/**
 * Utah time utilities.
 *
 * The dashboard needs to align “days” to Utah time.
 *
 * The user requirement for now is fixed Mountain Standard Time (MST = UTC-7)
 * rather than DST-aware “America/Denver”.
 *
 * We implement fixed-offset date math to avoid timezone differences across
 * hosting providers.
 */

export type FixedOffsetSpec = {
  /** Minutes east of UTC. Example: UTC-7 => -420. */
  offsetMinutes: number;
};

export const DEFAULT_UTAH_OFFSET_MINUTES = -7 * 60;

export function getUtahOffsetFromEnv(): FixedOffsetSpec {
  // Allow overriding for debugging / future DST-aware mode.
  // Examples:
  //   DASHBOARD_TZ_OFFSET_MINUTES=-420
  //   DASHBOARD_TZ_OFFSET_HOURS=-7
  const rawMinutes = process.env.DASHBOARD_TZ_OFFSET_MINUTES;
  if (rawMinutes && Number.isFinite(Number(rawMinutes))) {
    return { offsetMinutes: Number(rawMinutes) };
  }

  const rawHours = process.env.DASHBOARD_TZ_OFFSET_HOURS;
  if (rawHours && Number.isFinite(Number(rawHours))) {
    return { offsetMinutes: Number(rawHours) * 60 };
  }

  return { offsetMinutes: DEFAULT_UTAH_OFFSET_MINUTES };
}

/**
 * Format a Date as YYYY-MM-DD in a fixed UTC offset.
 *
 * Implementation detail:
 * - Shift the timestamp by offsetMinutes
 * - Then read the shifted time in UTC components.
 */
export function formatYmdAtFixedOffset(date: Date, offsetMinutes: number): string {
  const shifted = new Date(date.getTime() + offsetMinutes * 60_000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function parseYmd(ymd: string): { y: number; m: number; d: number } {
  const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(String(ymd));
  if (!m) throw new Error(`Invalid YYYY-MM-DD: ${ymd}`);
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

/**
 * Add delta days to a YYYY-MM-DD string and return YYYY-MM-DD.
 * Uses UTC date math because YYYY-MM-DD is a calendar date (timezone-free).
 */
export function addDaysYmd(ymd: string, deltaDays: number): string {
  const { y, m, d } = parseYmd(ymd);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().slice(0, 10);
}

/**
 * Return a list of YYYY-MM-DD strings from start to end, inclusive.
 */
export function listDaysInclusive(startYmd: string, endYmd: string): string[] {
  const out: string[] = [];
  let cur = startYmd;
  // Guard: avoid infinite loops on invalid input.
  for (let i = 0; i < 5000; i++) {
    out.push(cur);
    if (cur === endYmd) break;
    cur = addDaysYmd(cur, 1);
  }
  return out;
}

export function getUtahTodayYmd(now: Date = new Date()): string {
  const { offsetMinutes } = getUtahOffsetFromEnv();
  return formatYmdAtFixedOffset(now, offsetMinutes);
}

export function getUtahLastNDaysRange(days: number, now: Date = new Date()): { startDate: string; endDate: string } {
  const endDate = getUtahTodayYmd(now);
  const safeDays = Math.max(1, Math.floor(days));
  const startDate = addDaysYmd(endDate, -(safeDays - 1));
  return { startDate, endDate };
}

