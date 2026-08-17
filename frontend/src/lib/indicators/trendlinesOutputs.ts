// The TRENDLINES pane's OUTPUT SHAPE and config parsing — split out of
// trendlines.ts as a leaf with no RUNTIME imports, so exprInstances.ts can
// import it without dragging klinecharts into a node context that has no
// `window`. Same split, same reason, as ./fvgOutputs and ./slopeOutputs.
//
// Mirrors Python indicators/trendlines.py (`parse_trendlines_config` /
// `trendlines_outputs` / `trendlines_warmup`), which is what the backend
// validates a rule reference against.

export const TL_ATR_LEN = 14;

/** How many earlier same-side pivots a new pivot pairs with. Bounds the run at
 * O(P * 20) instead of O(P^2) — and bounds how far back a line can reach, so a
 * long line needs a proportionally large pivotLen. */
export const MAX_PAIR_PIVOTS = 20;

/** Live state keeps this multiple of maxLines per side, so a line that is
 * temporarily outranked is not destroyed and can return when it gains a touch.
 * maxLines itself does two things: it sizes that live state through this
 * multiplier, and it sets the per-side FLOOR for the DRAWN set (see
 * selectDrawnLines, which draws that many by proximity and then adds back any
 * line an operand is currently reading).
 *
 * BE PRECISE ABOUT THE OPERANDS. There is no rank SLICE on the emit path any
 * more — capping there discarded the very line nearest-to-the-close selection
 * wanted, so that slice is gone. But the emit path selects from the live pool,
 * and this multiplier is what bounds that pool, so maxLines still BOUNDS the
 * candidate set indirectly: raise it and a rule can see lines it could not see
 * before. Measured on the DXY monthly fixture at otherwise-default config,
 * maxLines 2 vs 3 changes an emitted value on 113 bars (including bars where
 * tl_resistance goes from undefined to 134.60, i.e. a rule stops firing
 * entirely), and 6 vs 3 differs on 158. "Does not gate" is true; "does not
 * change what a rule reads" is FALSE, and user-facing copy has already been
 * written wrong off the older wording once. */
export const MAX_LIVE_MULT = 4;

/** The rule-operand names, in pane order — the SAME strings as the backend's
 * trendlines_outputs, so an operand a user inserts and the series the backend
 * computes cannot drift apart. (No chart figure keys to match: the pane paints
 * its own canvas and declares `figures: []`.) */
export const TRENDLINES_OUTPUTS = [
  "tl_support",
  "tl_resistance",
  "tl_broken_support",
  "tl_broken_resistance",
] as const;

export type TrendlinesOutput = (typeof TRENDLINES_OUTPUTS)[number];

export interface TrendlinesConfig {
  pivotLen: number; // fractal lookback each side; confirm lag = this many bars
  violMult: number; // pierce tolerance as a multiple of ATR(14)
  touchMult: number; // touch tolerance as a multiple of ATR(14)
  minTouches: number; // touches before a line is major (2 = anchors only)
  minSpanBars: number; // minimum span before a line is major
  maxProjBars: number; // how far past its last touch a line stays live
  breakHoldBars: number; // how long a broken line keeps drawing and emitting
  // Sizes live state (x MAX_LIVE_MULT, by rank) and floors the drawn set (this
  // many per side, by proximity, plus the lines the operands read).
  maxLines: number;
}

export const TRENDLINES_DEFAULTS: TrendlinesConfig = {
  pivotLen: 5,
  violMult: 0.25,
  touchMult: 0.75,
  minTouches: 2,
  minSpanBars: 20,
  maxProjBars: 250,
  breakHoldBars: 30,
  maxLines: 3,
};

/** calcParams order: [pivotLen, violMult, touchMult, minTouches, minSpanBars,
 * maxProjBars, breakHoldBars, maxLines]. Mirrored by backend
 * trendlines.parse_trendlines_config — keep in sync.
 *
 * violMult takes ZERO (exact containment, the strictest setting), so it
 * validates on `>= 0` while every other param keeps the usual `> 0` rule.
 * Getting this wrong silently restores tolerant containment, so both runtimes
 * test it.
 *
 * Integer params (pivotLen, minTouches, minSpanBars, maxProjBars, breakHoldBars,
 * maxLines) are floored and then clamped to at least 1 via intAt. minTouches
 * has an additional clamp to at least 2, because a line is defined by two
 * anchor pivots and cannot exist with fewer touches.
 *
 * Number coercion: invalid input (null, "", []) coerces via Number() to 0,
 * which passes violMult's `>= 0` rule, giving the strictest setting. Python's
 * float() raises for all three instead (TypeError for None and [], ValueError
 * for ""), so the Python twin returns the default. This divergence is
 * deliberate (caught by tests on both sides).
 *
 * `false` is NOT one of them, despite an earlier version of this comment
 * listing it: Number(false) is 0 and float(False) is 0.0 (bool subclasses int
 * in Python, so float() does not raise), so both runtimes give 0 and AGREE.
 * Verified against the TS by cross-running both parsers over a junk corpus. */
export function parseTrendlinesConfig(calcParams: unknown): TrendlinesConfig {
  const p = Array.isArray(calcParams) ? calcParams : [];
  const d = TRENDLINES_DEFAULTS;
  const numAt = (i: number, def: number, allowZero: boolean): number => {
    const v = Number(p[i]);
    return Number.isFinite(v) && (allowZero ? v >= 0 : v > 0) ? v : def;
  };
  const intAt = (i: number, def: number): number => Math.max(1, Math.floor(numAt(i, def, false)));
  return {
    pivotLen: intAt(0, d.pivotLen),
    violMult: numAt(1, d.violMult, true),
    touchMult: numAt(2, d.touchMult, false),
    minTouches: Math.max(2, Math.floor(numAt(3, d.minTouches, false))),
    minSpanBars: intAt(4, d.minSpanBars),
    maxProjBars: intAt(5, d.maxProjBars),
    breakHoldBars: intAt(6, d.breakHoldBars),
    maxLines: intAt(7, d.maxLines),
  };
}

/** Bars before the first line can possibly exist: ATR(14) warm-up, plus the two
 * pivots that must confirm (pivotLen each), plus the span they must cover.
 * Lines keep forming after that, so this is the floor — the same convention as
 * the other specs. Every output shares it.
 *
 * Unlike fvgWarmup(), this depends on the parsed config. */
export function trendlinesWarmup(cfg: TrendlinesConfig): number {
  return TL_ATR_LEN + 2 * cfg.pivotLen + cfg.minSpanBars;
}
