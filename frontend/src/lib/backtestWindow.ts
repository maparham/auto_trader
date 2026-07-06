// Pure window/history-depth math for the backtest run flow (BacktestButton.tsx).
// Split out so the weekend-padding and warm-up-sufficiency logic — the parts
// that were wrong before — are unit-testable without mounting the component.

import {
  longestIndicatorLength,
  collectSeriesOperands,
  operandBaseLen,
  riskAtrLengths,
  scalingAtrLengths,
  slopeLen,
  type BacktestConfig,
} from "./backtestConfig";
import { RESOLUTION_SECONDS } from "./feed";

/** The longest warm-up need in BASE bars, accounting for per-operand timeframes:
 * an indicator of length N on a timeframe T needs N × (T / base) base bars of
 * history before it's warm. Base-timeframe operands (the common case) scale by 1,
 * so this equals {@link longestIndicatorLength}. ATR risk/scaling lengths are
 * always base-timeframe. `baseSeconds` unknown/≤0 ⇒ no scaling. */
export function longestWarmupBars(cfg: BacktestConfig, baseSeconds: number): number {
  if (!(baseSeconds > 0)) return longestIndicatorLength(cfg);
  const scaled = collectSeriesOperands(cfg).map((op) => {
    // A sloped operand needs `slope.len` extra bars in its OWN timeframe (it reads
    // v[i] and v[i−len] on that timeframe), so add it BEFORE scaling by the ratio.
    const len = operandBaseLen(op) + (slopeLen(op) ?? 0);
    // Both indicator and (pasted chart) series operands can carry a per-operand
    // higher timeframe; a drawing series never does. Scale by that TF's ratio.
    const tf = op.kind === "indicator" || op.kind === "series" ? op.timeframe : undefined;
    const tfSec = tf ? RESOLUTION_SECONDS[tf] ?? baseSeconds : baseSeconds;
    const ratio = Math.max(1, Math.ceil(tfSec / baseSeconds));
    return len * ratio;
  });
  return Math.max(1, ...scaled, ...riskAtrLengths(cfg), ...scalingAtrLengths(cfg));
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

export function minimalHistoryStart(cfg: BacktestConfig, windowFromMs: number, resSeconds: number): number {
  return windowFromMs - paddedLookbackMs(longestWarmupBars(cfg, resSeconds), resSeconds);
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
export function resolveHistoryStart(cfg: BacktestConfig, windowFromMs: number, resSeconds: number): number {
  const depth = cfg.range.history ?? "full";
  if (depth === "full") return windowFromMs - FULL_HISTORY_LOOKBACK_MS;
  if (depth === "bars") return windowFromMs - paddedLookbackMs(cfg.range.historyBars ?? 500, resSeconds);
  return minimalHistoryStart(cfg, windowFromMs, resSeconds);
}

/** The minimum number of real (non-warm-up-gap) bars the history fetch must
 * contain before the window for the config to be honestly "warmed up" — "full"
 * has no fixed target size, but still can't honestly warm less than the
 * longest indicator needs. */
export function requiredWarmupBars(cfg: BacktestConfig, baseSeconds?: number): number {
  const depth = cfg.range.history ?? "full";
  if (depth === "bars") {
    const asked = cfg.range.historyBars ?? 500;
    // A higher-timeframe indicator can need more base bars than the user's "N
    // bars" ask (N/ratio HTF bars won't warm it). Raise the requirement so the
    // insufficient-warmup retry refetches at the TF-scaled minimal depth and the
    // short-warm-up warning fires honestly. Base-only configs keep asking N.
    return baseSeconds != null ? Math.max(asked, longestWarmupBars(cfg, baseSeconds)) : asked;
  }
  return baseSeconds != null ? longestWarmupBars(cfg, baseSeconds) : longestIndicatorLength(cfg);
}

/** How many of the fetched bars fall strictly before the trading window — i.e.
 * how much real warm-up history was actually obtained. */
export function warmupBarCount(bars: Array<{ timestamp: number }>, windowFromMs: number): number {
  return bars.reduce((n, b) => (b.timestamp < windowFromMs ? n + 1 : n), 0);
}
