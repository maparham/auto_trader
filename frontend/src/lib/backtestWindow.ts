// Pure window/history-depth math for the backtest run flow (BacktestButton.tsx).
// Split out so the weekend-padding and warm-up-sufficiency logic — the parts
// that were wrong before — are unit-testable without mounting the component.

import {
  longestIndicatorLength,
  riskAtrLengths,
  scalingAtrLengths,
  type BacktestConfig,
} from "./backtestConfig";
import { warmupOf } from "./expr/parser";
import type { ExprInstance } from "./expr/catalog";

/** The chart-pane half of warm-up, supplied by the caller that owns the chart
 * (BacktestButton). A row saying `SLOPE.9 > 0.5` names an OUTPUT and
 * restates none of the pane's settings, so its depth can only come from the
 * pane itself — and this module, like the parser, must not import a concrete
 * indicator to find it.
 *
 * Omitted (legacy/structured callers, and the settings modal's estimate) means
 * every reference contributes 0, which is the pre-existing behaviour. */
export interface WarmupRefs {
  instances: readonly ExprInstance[];
  warmupByRef: (instance: string, output: string) => number;
}

/** The longest warm-up (in base bars) any enabled expression row needs — @tf
 * pins scale by the timeframe ratio when `baseSeconds` is known (see warmupOf).
 * Structured (coded) configs have no `expr` rows, so this is 0 and nothing
 * changes for them. */
function exprWarmupBars(cfg: BacktestConfig, baseSeconds?: number, refs?: WarmupRefs): number {
  let m = 0;
  for (const g of [cfg.longEntry, cfg.longExit, cfg.shortEntry, cfg.shortExit]) {
    for (const r of g.rules) {
      if (r.expr == null || r.enabled === false) continue;
      m = Math.max(m, warmupOf(r.expr, baseSeconds, refs?.instances, refs?.warmupByRef));
    }
  }
  return m;
}

/** The longest warm-up need in BASE bars. ATR risk/scaling lengths are always
 * base-timeframe; expression rows contribute their own warm-up via
 * {@link exprWarmupBars}, with @tf pins scaled to base bars by `baseSeconds`. */
export function longestWarmupBars(cfg: BacktestConfig, baseSeconds: number, refs?: WarmupRefs): number {
  if (!(baseSeconds > 0)) return Math.max(longestIndicatorLength(cfg), exprWarmupBars(cfg, undefined, refs));
  return Math.max(1, ...riskAtrLengths(cfg), ...scalingAtrLengths(cfg), exprWarmupBars(cfg, baseSeconds, refs));
}

const DAY_MS = 86_400_000;
const WEEK_SECONDS = 604_800;
const RANGE_SPAN_MS: Record<string, number> = {
  lastDay: DAY_MS,
  lastWeek: 7 * DAY_MS,
  lastMonth: 30 * DAY_MS,
  lastYear: 365 * DAY_MS,
};

/** Resolve a BacktestConfig's range into the trading window [fromMs, toMs). */
export function resolveWindow(
  cfg: BacktestConfig,
  resSeconds: number,
  now: number,
): { fromMs: number; toMs: number } {
  if (cfg.range.mode === "custom") {
    return { fromMs: cfg.range.fromMs ?? now - DAY_MS, toMs: cfg.range.toMs ?? now };
  }
  if (cfg.range.mode === "bars") {
    const bars = cfg.range.bars ?? 500;
    return { fromMs: now - bars * resSeconds * 1000, toMs: now };
  }
  // Relative unit modes (lastDay/Week/Month/Year) normally trail `now`, but a
  // calendar suggestion chip sets an absolute fromMs/toMs anchor on the same
  // mode — honour it so the unit tab stays selected while the range is fixed.
  if (cfg.range.fromMs != null && cfg.range.toMs != null) {
    return { fromMs: cfg.range.fromMs, toMs: cfg.range.toMs };
  }
  return { fromMs: now - (RANGE_SPAN_MS[cfg.range.mode] ?? DAY_MS), toMs: now };
}

// A flat "N bars back" calendar-time subtraction undercounts real candles for
// any resolution finer than a week: markets are closed weekends, so a lookback
// spanning multiple days loses ~2/7 of its span to non-trading time (e.g. 200
// calendar days back yields only ~143 real DAY candles). Padding the ask by
// 1.5x (7/5 for weekends, plus a little slack for holidays) compensates
// without needing to know the actual trading calendar client-side. Weekly+
// bars have no such gap (a week always produces one candle regardless of
// weekends within it).
const WEEKEND_PADDING = 1.5;

function paddedLookbackMs(bars: number, resSeconds: number): number {
  const factor = resSeconds < WEEK_SECONDS ? WEEKEND_PADDING : 1;
  return Math.ceil(bars * resSeconds * factor) * 1000;
}

export function minimalHistoryStart(
  cfg: BacktestConfig, windowFromMs: number, resSeconds: number, refs?: WarmupRefs,
): number {
  return windowFromMs - paddedLookbackMs(longestWarmupBars(cfg, resSeconds, refs), resSeconds);
}

// "Full" history is bounded, not literally epoch 0: Capital's REST history API
// 400s on a from-date this old, and that error surfaces as an empty candle
// list. 5 years of calendar time is a generous upper bound to attempt; the
// actual broker/account limit varies by resolution and instrument (observed: a
// live account 400s on HOUR history older than a few months), so this is a
// starting point, not a guarantee — see BacktestButton.tsx's insufficient-
// warmup retry for what happens when it isn't enough.
const FULL_HISTORY_LOOKBACK_MS = 5 * 365 * DAY_MS;

/** How far before the window to fetch so every indicator is warm at the window's
 * first bar (D6) — full history, a user-typed bar count, or just the longest
 * indicator's length. */
export function resolveHistoryStart(
  cfg: BacktestConfig, windowFromMs: number, resSeconds: number, refs?: WarmupRefs,
): number {
  const depth = cfg.range.history ?? "minimal";
  if (depth === "full") return windowFromMs - FULL_HISTORY_LOOKBACK_MS;
  if (depth === "bars") return windowFromMs - paddedLookbackMs(cfg.range.historyBars ?? 500, resSeconds);
  return minimalHistoryStart(cfg, windowFromMs, resSeconds, refs);
}

/** How many times the run may widen the history ask before giving up. Each pass
 * doubles the span, so 6 reaches 64x the *minimal* lookback (see
 * {@link warmupWalkFloor}) — enough to clear a multi-day holiday closure at any
 * intraday resolution. */
export const MAX_WARMUP_PASSES = 6;

/** Next (earlier) history start to try when the fetched bars didn't actually
 * contain `requiredWarmupBars` before the window.
 *
 * Warm-up depth is a bar count, but a history fetch can only be asked in
 * calendar time — and the two only line up while the market is open.
 * {@link paddedLookbackMs}'s fixed 1.5x can't bridge that: a lookback whose
 * start lands *inside* a closure gets back far fewer bars than it asked for
 * (EMA(50) on 5m asks 6h15m, but a window opening Monday 00:00Z has only 24
 * real bars in that span, because the weekly open was 22:00Z). No multiplier
 * fixes it in general — the gap can be longer than the whole lookback.
 *
 * So instead of guessing the calendar, double the span and re-ask until the bars
 * are actually there — see {@link widenUntilWarm} for when the walk stops. The
 * result is always strictly earlier than `historyFromMs`, including for a
 * degenerate (zero-width or inverted) input, so the walk cannot stall. */
export function widenedHistoryStart(
  historyFromMs: number,
  windowFromMs: number,
  resSeconds: number,
): number {
  const span = Math.max(windowFromMs - historyFromMs, resSeconds * 1000);
  return windowFromMs - span * 2;
}

/** Deepest start {@link widenUntilWarm} may reach: MAX_WARMUP_PASSES doublings
 * of the *minimal* ask, regardless of the config's own history depth.
 *
 * Without this floor the walk is anchored to whatever depth the user picked, and
 * doubling a deep ask is absurd rather than corrective — "full" starts 5 years
 * back, so six doublings would ask for 320 years. A config already reaching past
 * this floor is not short because of a session gap (its span dwarfs any closure),
 * so the walk declines to run at all and the existing short-warm-up warning
 * reports the shortfall honestly. */
export function warmupWalkFloor(
  cfg: BacktestConfig,
  windowFromMs: number,
  resSeconds: number,
  refs?: WarmupRefs,
): number {
  const minimalSpan = windowFromMs - minimalHistoryStart(cfg, windowFromMs, resSeconds, refs);
  return windowFromMs - minimalSpan * 2 ** MAX_WARMUP_PASSES;
}

/** Widen the history ask until it really holds `required` bars before the window.
 *
 * A pass that adds no bars must NOT stop the walk: that is exactly what every ask
 * still inside a closure looks like, and clearing a weekend takes several
 * (6h15m -> 12h30m -> 25h -> 50h can all land in it; only ~100h reaches back into
 * Friday's session). A gap and the history edge are indistinguishable from a
 * single short pass, so the walk runs its bounded course and keeps the deepest
 * result. Only a completely empty fetch — a broker refusing the ask outright —
 * ends it early. Returns the best bars found, which may still be short. */
export async function widenUntilWarm<T extends { timestamp: number }>(
  bars: T[],
  historyFromMs: number,
  opts: { windowFromMs: number; resSeconds: number; required: number; floorMs: number },
  fetchBars: (fromMs: number) => Promise<T[]>,
): Promise<T[]> {
  const { windowFromMs, resSeconds, required, floorMs } = opts;
  let best = bars;
  let from = historyFromMs;
  for (let pass = 0; pass < MAX_WARMUP_PASSES; pass++) {
    if (warmupBarCount(best, windowFromMs) >= required) break;
    // Already reaching deeper than the walk ever would — a gap isn't the problem.
    if (from <= floorMs) break;
    // Strictly earlier than `from`: widenedHistoryStart is monotonic (asserted in
    // its tests) and floorMs < from, checked above. The pass budget bounds the
    // loop regardless, so no extra no-progress guard is needed here.
    const widened = Math.max(widenedHistoryStart(from, windowFromMs, resSeconds), floorMs);
    from = widened;
    const deeper = await fetchBars(widened);
    if (deeper.length === 0) break;
    if (warmupBarCount(deeper, windowFromMs) > warmupBarCount(best, windowFromMs)) best = deeper;
  }
  return best;
}

/** The minimum number of real (non-warm-up-gap) bars the history fetch must
 * contain before the window for the config to be honestly "warmed up" — "full"
 * has no fixed target size, but still can't honestly warm less than the
 * longest indicator needs. */
export function requiredWarmupBars(
  cfg: BacktestConfig, baseSeconds?: number, refs?: WarmupRefs,
): number {
  const depth = cfg.range.history ?? "minimal";
  if (depth === "bars") {
    const asked = cfg.range.historyBars ?? 500;
    // A higher-timeframe indicator can need more base bars than the user's "N
    // bars" ask (N/ratio HTF bars won't warm it). Raise the requirement so the
    // insufficient-warmup retry refetches at the TF-scaled minimal depth and the
    // short-warm-up warning fires honestly. Base-only configs keep asking N.
    return baseSeconds != null ? Math.max(asked, longestWarmupBars(cfg, baseSeconds, refs)) : asked;
  }
  return baseSeconds != null ? longestWarmupBars(cfg, baseSeconds, refs) : longestIndicatorLength(cfg);
}

/** How many of the fetched bars fall strictly before the trading window — i.e.
 * how much real warm-up history was actually obtained. */
export function warmupBarCount(bars: Array<{ timestamp: number }>, windowFromMs: number): number {
  return bars.reduce((n, b) => (b.timestamp < windowFromMs ? n + 1 : n), 0);
}
