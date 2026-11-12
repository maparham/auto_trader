// Test helper: the day and week starts a broker with UTC daily bars and
// Monday weekly bars would give for these candles (a daily bar on every day
// that holds a candle, a weekly bar on every week that holds one).
import type { SlotAnchors } from "./equalWidthDays";

const DAY = 86_400_000;

export function utcAnchors(times: readonly number[]): SlotAnchors {
  const days = [...new Set(times.map((t) => Math.floor(t / DAY) * DAY))].sort((a, b) => a - b);
  // 1970-01-01 was a Thursday: Monday is 3 days earlier in the week.
  const monday = (d: number) => d - ((Math.floor(d / DAY) + 3) % 7) * DAY;
  const weeks = [...new Set(days.map(monday))].sort((a, b) => a - b);
  return { dayStarts: days, weekStarts: weeks };
}
