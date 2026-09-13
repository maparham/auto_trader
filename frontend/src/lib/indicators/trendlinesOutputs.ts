// The TRENDLINES pane's OUTPUT SHAPE and config parsing — split out of
// trendlines.ts as a leaf with no RUNTIME imports, so exprInstances.ts can
// import it without dragging klinecharts into a node context that has no
// `window`. Same split, same reason, as ./fvgOutputs and ./slopeOutputs.
//
// Mirrors Python indicators/trendlines.py (`parse_trendlines_config` /
// `trendlines_outputs` / `trendlines_warmup`), which is what the backend
// validates a rule reference against.

export const TL_ATR_LEN = 14;

/** DEFAULT for how many earlier same-side pivots a new pivot pairs with; the
 * live value is cfg.pairPivots (calcParams[10]). Bounds the run at O(P * n)
 * instead of O(P^2) — and bounds how far back a line can reach.
 *
 * COUNTED IN PIVOTS, NOT BARS, which is the surprising part: anything that
 * removes pivots (a higher pivotLen, minSwingAtr, minSwingReach) makes these
 * slots reach FURTHER BACK in time, so pairs that were out of range become
 * reachable and NEW lines can appear from a stricter setting. */
export const MAX_PAIR_PIVOTS = 20;

/** Live state keeps this multiple of maxLines per side, so a line that is
 * temporarily outranked is not destroyed and can return when it gains a touch.
 * maxLines itself does two things: it sizes that live state through this
 * multiplier (still per side, as a memory bound), and it sets the total FLOOR
 * for the DRAWN set (see selectDrawnLines, which draws that many by proximity
 * across both sides and then adds back any line an operand is currently
 * reading).
 *
 * BE PRECISE ABOUT THE OPERANDS. There is no rank SLICE on the emit path any
 * more — capping there discarded the very line nearest-to-the-close selection
 * wanted, so that slice is gone. But the emit path selects from the live pool,
 * and this multiplier is what bounds that pool, so maxLines still BOUNDS the
 * candidate set indirectly: raise it and a rule can see lines it could not see
 * before. Measured on the DXY monthly fixture at otherwise-default config,
 * maxLines 2 vs 3 changes an emitted value on 87 bars (including bars where
 * tl_resistance goes from undefined to 119.53, i.e. a rule stops firing
 * entirely), and 6 vs 3 differs on 136. "Does not gate" is true; "does not
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
  // Touch tolerance as a multiple of ATR(14). 0 is the strictest setting, not
  // an off switch: no gap short of the line is tolerated.
  touchMult: number;
  minTouches: number; // touches before a line is major (2 = anchors only)
  minSpanBars: number; // minimum span before a line is major
  maxProjBars: number; // how far past its last touch a line stays live
  breakHoldBars: number; // how long a broken line keeps drawing and emitting
  // Sizes live state (x MAX_LIVE_MULT, by rank) and floors the drawn set (this
  // many per side, by proximity, plus the lines the operands read).
  maxLines: number;
  // How far a pivot must stand out from the AVERAGE of its own window, as a
  // multiple of ATR(14), before it counts as a swing at all. 0 = off, which is
  // the default and keeps the fractal shape test as the only condition.
  minSwingAtr: number;
  // Bars a pivot must dominate to its LEFT before it counts as a swing, on top
  // of the fractal window. 0 = off, and so is anything <= pivotLen, since a
  // pivot already beats that many by definition. LEFT ONLY: right reach keeps
  // growing after the pivot confirms, so gating on it would repaint.
  minSwingReach: number;
  // Earlier same-side pivots a new pivot pairs with. See MAX_PAIR_PIVOTS.
  pairPivots: number;
  // Upper bound on touches, the mirror of minTouches. 0 = no limit, the
  // default. A line that keeps collecting touches is usually a flat shelf that
  // half the swings in a range graze; this is how to drop those and keep the
  // lines only a few pivots agree on.
  maxTouches: number;
  // Upper bound on span, the mirror of minSpanBars. 0 = no limit. Measured the
  // same way minSpanBars is, lastTouchIdx - i1, so the two read against the
  // same number.
  maxSpanBars: number;
  // Ceiling on how steep a line may be, in ATR(14) of price per bar. 0 = no
  // limit. A resistance line that climbs faster than price can outruns price
  // and is never touched again, which is the shape a fan off one sharp pivot
  // produces over and over.
  maxSlopeAtr: number;
  // Floor on steepness, the mirror of maxSlopeAtr. 0 = no floor. A line flat
  // enough to be a horizontal shelf is not a trendline, and SR_LEVELS already
  // draws those properly.
  minSlopeAtr: number;
  // Bars before the FIRST anchor that must sit on the line's own side of it,
  // within the Max Pierce tolerance. 0 = off. The only gate here that does not
  // default to off: a pair whose angle has nothing to do with the trend passes
  // every other test as long as its wrong side is in the past, and this is the
  // seed-time pierce test run backwards. See hasBackClearance.
  minBackBars: number;
  // Count opposite-side pivots as touches (never as anchors). 1 = on, the
  // default; 0 = off restores the strict same-side detector. Stored as a
  // number because calcParams carry numbers; every reader tests > 0.
  mixedTouches: number;
  // Widest stretch of bars allowed between two CONSECUTIVE touches. 0 = no
  // limit, the default.
  //
  // NOT maxSpanBars, which bounds the whole first-to-last distance: a line
  // touched every 40 bars for 200 and one with two touches 200 apart have the
  // same span and different spacing. NOT maxProjBars either, which measures
  // forward from the last touch to the current bar.
  //
  // Its dominant effect is on the ANCHOR gap (i1 to i2), because gaps after
  // the seed are already bounded: a line is pruned once
  // i - lastTouchIdx > maxProjBars, so no later touch can open one wider than
  // that. Pairing distance had no setting of its own before this.
  maxTouchSpacing: number;
  // Floor on that same gap, the other end of the Touch Spacing range. 0 = off,
  // the default. Drops lines whose touches BUNCH: three pivots within a few
  // bars are one test of the line, not three.
  //
  // ON A TWO-TOUCH LINE IT IS minSpanBars, exactly: a fresh same-side pair has
  // one gap, i2 - i1, and minSpanBars measures lastTouchIdx - i1. It earns its
  // slot at three or more touches, and on the mixed leg (i1 back to
  // firstTouchIdx), which minSpanBars never measures.
  //
  // Near-inert below pivotLen with Mixed touches off, like minSwingReach: two
  // same-side pivots cannot sit closer than that, each being the extreme of its
  // own window. Opposite-side pivots can sit one bar apart, so mixed touches
  // are where a small floor actually bites.
  minTouchSpacing: number;
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
  minSwingAtr: 0,
  minSwingReach: 0,
  pairPivots: MAX_PAIR_PIVOTS,
  maxTouches: 0,
  maxSpanBars: 0,
  maxSlopeAtr: 0,
  minSlopeAtr: 0,
  minBackBars: 10,
  mixedTouches: 1,
  maxTouchSpacing: 0,
  // APPENDED, not inserted beside maxTouchSpacing, however much the UI pairs
  // them: this object's key ORDER is the calcParams order (mtfCoordinator
  // builds the HTF params from Object.values), so inserting would shift every
  // slot after it and silently repoint every saved chart's settings.
  minTouchSpacing: 0,
};

/** Defaults for the render-only extendData flags, for the case nothing is
 * stored under the key — a freshly added instance, whose extendData is just
 * `{indType}` until the settings modal writes to it.
 *
 * ONE source for the draw path and indicatorMeta's `default`, because they had
 * already drifted: the meta defaults were flipped without the `??` fallbacks
 * below the chart, so a fresh pane drew plain pivot arrows the panel said were
 * off. Add a flag here and read it on both sides. */
export const TRENDLINES_EXTEND_DEFAULTS = {
  showPivots: false,
  showLinePivots: true,
} as const;

/** calcParams order: [pivotLen, violMult, touchMult, minTouches, minSpanBars,
 * maxProjBars, breakHoldBars, maxLines, minSwingAtr, minSwingReach,
 * pairPivots, maxTouches, maxSpanBars, maxSlopeAtr, minSlopeAtr, minBackBars,
 * mixedTouches, maxTouchSpacing, minTouchSpacing].
 * Mirrored by backend trendlines.parse_trendlines_config — keep in sync.
 *
 * violMult, touchMult and minSwingAtr take ZERO (exact containment on the
 * first two; the swing-size gate switched off on the third), so they validate
 * on `>= 0` while every other param keeps the usual `> 0` rule. For minSwingAtr
 * that is the difference between an OFF switch and no switch at all: on `> 0`,
 * a stored 0 would fall back to the default and the setting could never be
 * turned off. touchMult 0 is the STRICTEST touch rule rather than an off
 * switch, the mirror of violMult 0: it leaves the touch band as
 * [line, line + violMult] on a resistance (see inTouchBand's asymmetry), so a
 * pivot short of the line by any gap at all stops counting.
 * Getting this wrong silently restores tolerant containment, so both runtimes
 * test it.
 *
 * Integer params (pivotLen, minTouches, minSpanBars, maxProjBars, breakHoldBars,
 * maxLines, pairPivots) are floored and then clamped to at least 1 via intAt. minTouches
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
    touchMult: numAt(2, d.touchMult, true),
    minTouches: Math.max(2, Math.floor(numAt(3, d.minTouches, false))),
    minSpanBars: intAt(4, d.minSpanBars),
    maxProjBars: intAt(5, d.maxProjBars),
    breakHoldBars: intAt(6, d.breakHoldBars),
    maxLines: intAt(7, d.maxLines),
    minSwingAtr: numAt(8, d.minSwingAtr, true),
    // Floored like the integer params but clamped to 0, not 1: intAt's floor of
    // 1 would make the off state unreachable, and 1 is a no-op anyway.
    minSwingReach: Math.max(0, Math.floor(numAt(9, d.minSwingReach, true))),
    pairPivots: intAt(10, d.pairPivots),
    // Floored, clamped to 0 not 1, like minSwingReach: 0 is the off state and
    // intAt would make it unreachable. 1 is also meaningless (a line has two
    // anchors, so touches is never below 2), but it is not this parser's job to
    // second-guess that.
    maxTouches: Math.max(0, Math.floor(numAt(11, d.maxTouches, true))),
    maxSpanBars: Math.max(0, Math.floor(numAt(12, d.maxSpanBars, true))),
    maxSlopeAtr: numAt(13, d.maxSlopeAtr, true),
    minSlopeAtr: numAt(14, d.minSlopeAtr, true),
    // Clamped to 0, not 1, like minSwingReach: 0 is the off state and intAt
    // would make it unreachable. Unlike the others its DEFAULT is not the off
    // state, so a chart saved before this param existed reads undefined here
    // and gets the gate at 10, which is intended.
    minBackBars: Math.max(0, Math.floor(numAt(15, d.minBackBars, true))),
    // Clamped to {0, 1}: floor sends fractions to 0 or 1, the min/max pin
    // anything else. Absent (a chart saved before the param existed) reads the
    // default, which is ON — like minBackBars, the default is not the off
    // state, and that is intended.
    mixedTouches: Math.min(1, Math.max(0, Math.floor(numAt(16, d.mixedTouches, true)))),
    // Clamped to 0, not 1, like the other ceilings: 0 is the off state, and 1
    // would be unreachable through intAt.
    maxTouchSpacing: Math.max(0, Math.floor(numAt(17, d.maxTouchSpacing, true))),
    minTouchSpacing: Math.max(0, Math.floor(numAt(18, d.minTouchSpacing, true))),
  };
}

/** Bars before the first line can possibly exist: ATR(14) warm-up, plus the two
 * pivots that must confirm (pivotLen each), plus the span they must cover.
 * Lines keep forming after that, so this is the floor — the same convention as
 * the other specs. Every output shares it.
 *
 * LEFT-WINDOW GATES ARE LEFT OUT, and there are two of them now: minSwingReach
 * and minBackBars each require that many bars before the first anchor, and
 * neither is added here. Right for each one alone (this floor is about the
 * shape of the spec, not the strictest reachable config), but say it as the
 * pattern it has become rather than as an exception: the floor is now
 * optimistic by their SUM, so a third such gate belongs on this list too. What
 * would change the answer is a caller that treats the floor as exact.
 *
 * Unlike fvgWarmup(), this depends on the parsed config. */
export function trendlinesWarmup(cfg: TrendlinesConfig): number {
  return TL_ATR_LEN + 2 * cfg.pivotLen + cfg.minSpanBars;
}
