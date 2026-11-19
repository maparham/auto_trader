// When the forming bar stops trading, from the broker's weekly opening hours.
//
// A bar's nominal end (open + width) can sit in a closed stretch: Friday's
// daily and 4H bars end at midnight on paper, two hours after the close, and
// a weekly bar ends on Monday. The countdown is for "how long does this bar
// still trade", so it ends at the last open moment inside the bar.

/** `[start, end)` in minutes of the UTC week, Monday 00:00 = 0. Sorted,
 *  merged, never across the week edge (the backend's `week_sessions`). */
export type WeekSessions = Array<[number, number]>;

const MIN_MS = 60_000;
const WEEK_MS = 7 * 86_400_000;
// 1970-01-01 was a Thursday, so the first Monday 00:00 UTC is 4 days in.
const MONDAY_OFFSET_MS = 4 * 86_400_000;
/** A break this long is a weekend, not the daily pause. */
const WEEKEND_GAP_MS = 24 * 3_600_000;

function weekStartMs(ms: number): number {
  return Math.floor((ms - MONDAY_OFFSET_MS) / WEEK_MS) * WEEK_MS + MONDAY_OFFSET_MS;
}

/** The sessions as absolute `[start, end)` ms over the weeks around
 *  `[fromMs, toMs]`, merged, so a session over the week edge (Capital's
 *  Sunday 23:00 hour running into Monday) is one interval. */
function absoluteSessions(sessions: WeekSessions, fromMs: number, toMs: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let w = weekStartMs(fromMs) - WEEK_MS; w <= toMs + WEEK_MS; w += WEEK_MS) {
    for (const [s, e] of sessions) {
      const start = w + s * MIN_MS;
      const end = w + e * MIN_MS;
      const last = out[out.length - 1];
      if (last && start <= last[1]) last[1] = Math.max(last[1], end);
      else out.push([start, end]);
    }
  }
  return out;
}

/** When the countdown of the bar `[openMs, nominalEndMs)` should reach zero:
 *  the last open moment inside the bar. When that moment is in a session that
 *  opens after a weekend and the session has not started yet, the count stops
 *  at the close before the weekend instead (Capital puts the Sunday-evening
 *  hour into the old week's bar, which would carry the count through the
 *  weekend). The result can be at or before now: the bar has stopped trading
 *  and the count stays at zero. The nominal end without a schedule, or when
 *  nothing inside the bar trades. */
export function sessionBarEnd(
  sessions: WeekSessions | null | undefined,
  nowMs: number,
  openMs: number,
  nominalEndMs: number,
): number {
  if (!sessions || sessions.length === 0) return nominalEndMs;
  // Only the stretch around the end matters, also for monthly and yearly bars.
  const from = Math.max(openMs, nominalEndMs - 2 * WEEK_MS);
  const ivs = absoluteSessions(sessions, from, nominalEndMs);
  let k = -1;
  for (let i = 0; i < ivs.length && ivs[i][0] < nominalEndMs; i++) k = i;
  if (k < 0) return nominalEndMs;
  const end = Math.min(ivs[k][1], nominalEndMs);
  if (end <= openMs) return nominalEndMs;
  if (k > 0 && nowMs < ivs[k][0] && ivs[k][0] - ivs[k - 1][1] >= WEEKEND_GAP_MS && ivs[k - 1][1] > openMs) {
    return ivs[k - 1][1];
  }
  return end;
}
