// The TRENDLINES pane's OUTPUT SHAPE and config parsing, split out of
// trendlines.ts as a leaf with no RUNTIME imports so exprInstances.ts can
// import it in a node context. Same split, same reason, as ./fvgOutputs.
//
// Mirrors Python indicators/trendlines.py (parse_trendlines_config,
// trendlines_outputs, trendlines_warmup), which is what the backend validates
// a rule reference against.

export const TL_ATR_LEN = 14;

/** DEFAULT for how many earlier pivots a new pivot pairs with; the live value
 * is cfg.pairPivots (calcParams[8]). ONE POOL holds highs and lows together,
 * so this reaches about half as far back in time as the old per-side 20 did,
 * which is why the default doubled. Counted in pivots, not bars: filtering
 * pivots out lets the same slots reach further back. */
export const MAX_PAIR_PIVOTS = 40;

/** DEFAULT size of the MAJOR tier (cfg.majorPivots, calcParams[24]): the
 * strongest swings seen so far, kept beyond the recent window so a fresh
 * pivot can still start a line from a big old one. Mirrors MAJOR_PIVOTS in
 * indicators/trendlines.py. */
export const MAJOR_PIVOTS = 12;

/** DEFAULT window that makes a pivot MAJOR (cfg.majorLen, calcParams[25]):
 * the extreme over this many bars on each side. Mirrors MAJOR_LEN in
 * indicators/trendlines.py. */
export const MAJOR_LEN = 30;

/** DEFAULT min swing, in ATR(14), for a pivot to be MAJOR (cfg.majorSizeAtr,
 * calcParams[26]). 3: on OIL_CRUDE daily 5 rejected the swings a reader
 * would call major and 4.5 kept them; 0 (length alone) let in too many.
 * Mirrors MAJOR_SIZE_ATR in indicators/trendlines.py. */
export const MAJOR_SIZE_ATR = 3;

/** Live state keeps this multiple of maxLines lines IN TOTAL, so a line that is
 * temporarily outranked is not destroyed and can return when it gains a touch.
 * Raising maxLines therefore also widens the candidate set a rule can see.
 *
 * 16, not 4: a line is built once, at its second anchor, so the cap is a
 * one-shot test it can never retake. compareSurvival fixed WHICH lines the cap
 * keeps; this is the headroom that ordering still needs on real charts. The
 * DXY monthly 2011 low line needs a cap of 224 to reach the last bar, so even
 * at 16 one acceptance fixture runs above the pane default. Cost is close to
 * linear in the cap, over a fixed base: measured on the 1209-bar TSLA daily
 * fixture, a full recompute takes 6.0ms at cap 16, 8.7ms at cap 48 (the pane
 * default) and 35.4ms at cap 288. */
export const MAX_LIVE_MULT = 16;

/** Hard ceiling on Max Trendlines, applied at parse time.
 *
 * The slot was re-cut by the sideless rewrite, so a pane saved under the OLD
 * layout reads its Max Projection (250 by default) into this one. Each unit
 * costs a rule operand AND MAX_LIVE_MULT live lines, so 250 would mint 251
 * operands over 4000 live lines on a pane nobody asked to change. 50 is far
 * above any usable pane (the acceptance fixtures run at 8, 9 and 14) and far
 * below the runaway. Mirrored by MAX_MAX_LINES in trendlines.py. */
export const MAX_MAX_LINES = 50;

/** The nearest-to-price operand, the one output whose name does not carry a
 * rank. */
export const TL_NEAREST = "tl_nearest";

/** The ranked operand names: rank 1 is the strongest live line on that bar. */
export function tlOutputName(rank: number): string {
  return `tl_${rank}`;
}

/** The rule-operand names, in pane order. Config-driven: one per Max
 * Trendlines slot, then the nearest. The SAME strings as the backend's
 * trendlines_outputs. */
export function trendlinesOutputs(cfg: TrendlinesConfig): string[] {
  const out: string[] = [];
  for (let r = 1; r <= cfg.maxLines; r++) out.push(tlOutputName(r));
  out.push(TL_NEAREST);
  return out;
}

export interface TrendlinesConfig {
  pivotLen: number; // fractal lookback each side; confirm lag = this many bars
  // How far a pivot may stop SHORT of the line and still count, as a multiple
  // of ATR(14). A pivot short of the line scores HALF a touch. 0 (the default)
  // means a gap never counts; see pierceMult for the other half of the rule.
  touchMult: number;
  minTouches: number; // touches before a line is major (2 = anchors only)
  minSpanBars: number; // minimum span before a line is major
  maxProjBars: number; // how far past its last touch a line stays live
  // Sizes live state (x MAX_LIVE_MULT) and is the number of ranked outputs
  // (tl_1 .. tl_maxLines) and the drawn budget.
  maxLines: number;
  // How far a pivot must stand out from the last pivot of the other kind, in
  // ATR(14), before it counts as a swing at all. 0 = off.
  minSwingAtr: number;
  // Bars a pivot must dominate to its LEFT, on top of the fractal window. 0 =
  // off, and so is anything <= pivotLen.
  minSwingReach: number;
  pairPivots: number; // earlier pivots (either kind) a new pivot pairs with
  maxTouches: number; // upper bound on touches; 0 = no limit
  maxSpanBars: number; // upper bound on span; 0 = no limit
  maxSlopeAtr: number; // ceiling on SIGNED slope (rising +, falling -), ATR(14) per bar; 0 = no limit
  minSlopeAtr: number; // floor on signed slope, same units; 0 = no floor
  maxTouchSpacing: number; // widest gap between consecutive touches; 0 = no limit
  minTouchSpacing: number; // narrowest such gap; 0 = off
  // How many times the close must have changed side of the line, at least
  // (a floor a line can grow into) and at most (0 = no limit; a ceiling that
  // silences, like Max Touches).
  minCrossings: number;
  maxCrossings: number;
  // How far a pivot may poke THROUGH the line and still count, same units. A
  // pivot that pierces scores a FULL touch, because price cutting a line and
  // turning there is a stronger test of it than price stopping short. Which
  // way is "through" comes from the pivot's kind: a swing high tests the line
  // from below, so its high at or above the line pierces; a swing low from
  // above, so its low at or below the line pierces. 0 means only an extreme
  // exactly ON the line pierces.
  pierceMult: number;
  // Bars before a line's first anchor over which the close must stay on ONE
  // side of the line. A line whose extension was already being crossed before
  // it started is a pair whose angle has nothing to do with the move. 0 = off.
  // Runs off the start of the series by REJECTING: a line anchored fewer than
  // this many bars from bar 0 has not demonstrated the clearance.
  minBackBars: number;
  // How far a line may project from the close, in ATR(14) at that bar and as
  // a percent of that close, each 0 = off, each applied on its own: a line
  // beyond EITHER cut is out. A PER-BAR GATE in the calc's emit step (see
  // maxDistanceTol): the line stays live and is back the bar price returns
  // to it, but while it is far it neither draws nor reports to a rule.
  maxDistAtr: number;
  maxDistPct: number;
  // The merge pass, IN THE CALC: two majors that stay within this band of
  // each other over the whole stretch they both exist (checked where the
  // younger starts and at the current bar; straight lines make that the
  // whole stretch) are one line, and the better-ranked survives. The band
  // is the tighter of mergeAtr x ATR(14) and mergePct % of the close, each
  // 0 = off. Runs in the emit step, so a merged-away line neither draws nor
  // reports to a rule: the drawn set IS the emitted set.
  mergeAtr: number;
  mergePct: number;
  // Max lines per pivot: once this many kept lines run through one bar (an
  // anchor or a touch), later lines through it are dropped in the same
  // pass. 1 was "One line per pivot". 0 = off.
  maxPerPivot: number;
  // The MAJOR tier: on top of the last pairPivots pool entries, a new pivot
  // also pairs with the MAJOR pivots kept so far. A filter-passing pivot is
  // major when it is the extreme over majorLen bars on EACH side (so it is
  // known majorLen bars after it happened) and, with majorSizeAtr > 0, its
  // swing leg to the previous turn of the other kind is at least that many
  // ATR(14) at its bar. The tier keeps at most majorPivots of them, the
  // biggest swings winning; a newcomer must beat the weakest, which drops
  // out. Losing the tier never touches lines already seeded. majorPivots 0
  // = off.
  majorPivots: number;
  majorLen: number;
  majorSizeAtr: number;
}

/** KEY ORDER IS THE calcParams ORDER (mtfCoordinator builds HTF params from
 * Object.values, the template's calcParams are Object.values, indicatorMeta
 * indexes by slot). Append, never insert. */
export const TRENDLINES_DEFAULTS: TrendlinesConfig = {
  pivotLen: 5,
  touchMult: 0,
  minTouches: 2,
  minSpanBars: 20,
  maxProjBars: 250,
  maxLines: 3,
  minSwingAtr: 0,
  minSwingReach: 0,
  pairPivots: MAX_PAIR_PIVOTS,
  maxTouches: 0,
  maxSpanBars: 0,
  maxSlopeAtr: 0,
  minSlopeAtr: 0,
  maxTouchSpacing: 0,
  minTouchSpacing: 0,
  minCrossings: 0,
  maxCrossings: 0,
  pierceMult: 0.25,
  minBackBars: 0,
  maxDistAtr: 0,
  maxDistPct: 0,
  mergeAtr: 0.25,
  maxPerPivot: 0,
  mergePct: 0,
  majorPivots: MAJOR_PIVOTS,
  majorLen: MAJOR_LEN,
  majorSizeAtr: MAJOR_SIZE_ATR,
};

/** DEFAULT merge tolerance, in ATR(14): the value the mergeAtr slot starts
 * on. A quarter ATR only joins near-duplicates; 1 ATR (the earlier default)
 * swallowed distinct levels on a daily pane. Kept under half of
 * TL_NEAR_PRICE_ATR, or a line at the close could merge with one at the far
 * edge of that band. */
export const TL_DEDUPE_ATR = 0.25;

/** The distance "Only lines near price" used to draw at, in ATR(14): the
 * Max Distance a pane that chose that rule migrates onto (see
 * parseTrendlinesConfig). Merging above half of it could join a line at the
 * close with one at the far edge of the band, which is why TL_DEDUPE_ATR
 * stays under it. */
export const TL_NEAR_PRICE_ATR = 5;

/** Defaults for the render-only extendData flags. ONE source for the draw
 * path and indicatorMeta's `default`. */
export const TRENDLINES_EXTEND_DEFAULTS = {
  showPivots: false,
  showLinePivots: true,
  showCrossings: true,
  showStats: true,
  showPivotDepth: false,
} as const;

/** calcParams order: [pivotLen, touchMult, minTouches, minSpanBars,
 * maxProjBars, maxLines, minSwingAtr, minSwingReach, pairPivots, maxTouches,
 * maxSpanBars, maxSlopeAtr, minSlopeAtr, maxTouchSpacing, minTouchSpacing,
 * minCrossings, maxCrossings, pierceMult, minBackBars, maxDistAtr,
 * maxDistPct, mergeAtr, maxPerPivot, mergePct, majorPivots, majorLen,
 * majorSizeAtr]. Mirrored by backend parse_trendlines_config.
 *
 * `extendData` is read ONLY to migrate panes saved before slots 19 to 22
 * existed, and only while the slot in question is ABSENT (a present slot, 0
 * included, is what the user set since):
 *  - "Only lines near price" (`declutter: "near"`, or the checkbox-era
 *    `nearPrice: true` with no `declutter`) becomes Max Distance
 *    TL_NEAR_PRICE_ATR (slot 19).
 *  - the render-only merge tolerance (`dedupeAtr`, or the older `dedupe:
 *    false` meaning 0) becomes mergeAtr (slot 21).
 *  - `declutter: "pivot"` becomes maxPerPivot 1 (slot 22).
 * The settings modal writes every slot on its next save, so the old keys
 * retire on their own.
 *
 * touchMult, pierceMult and minSwingAtr take ZERO (no gap allowed; only an
 * extreme exactly on the line pierces; swing gate off),
 * so they validate on `>= 0`; every param with an off state at 0 (the
 * ceilings, the floors, the crossings range) does too. pivotLen, minSpanBars,
 * maxProjBars, maxLines, pairPivots keep the usual `> 0` rule and are floored
 * to at least 1. minTouches is floored to at least 2 (a line has two anchors).
 *
 * Number coercion: null, "" and [] coerce via Number() to 0, which passes the
 * `>= 0` rule; Python's float() raises for all three and returns the default.
 * That divergence is deliberate and tested on both sides. */
export function parseTrendlinesConfig(
  calcParams: unknown,
  extendData?: unknown,
): TrendlinesConfig {
  const p = Array.isArray(calcParams) ? calcParams : [];
  const d = TRENDLINES_DEFAULTS;
  const maxDistAtrDefault =
    p[19] === undefined && legacyNearPrice(extendData) ? TL_NEAR_PRICE_ATR : d.maxDistAtr;
  const mergeAtrDefault = p[21] === undefined ? (legacyMergeAtr(extendData) ?? d.mergeAtr) : d.mergeAtr;
  const maxPerPivotDefault =
    p[22] === undefined && legacyOnePerPivot(extendData) ? 1 : d.maxPerPivot;
  const numAt = (i: number, def: number, allowZero: boolean): number => {
    const v = Number(p[i]);
    return Number.isFinite(v) && (allowZero ? v >= 0 : v > 0) ? v : def;
  };
  // A SIGNED slot: any finite number, negative included. 0 stays the off
  // sentinel, which is why the Slope range cannot express "rise >= 0" exactly;
  // 0.01 is the practical spelling and the tip says so.
  const signedAt = (i: number, def: number): number => {
    const v = Number(p[i]);
    return Number.isFinite(v) ? v : def;
  };
  const intAt = (i: number, def: number): number => Math.max(1, Math.floor(numAt(i, def, false)));
  const zeroInt = (i: number, def: number): number => Math.max(0, Math.floor(numAt(i, def, true)));
  return {
    pivotLen: intAt(0, d.pivotLen),
    touchMult: numAt(1, d.touchMult, true),
    minTouches: Math.max(2, Math.floor(numAt(2, d.minTouches, false))),
    minSpanBars: intAt(3, d.minSpanBars),
    maxProjBars: intAt(4, d.maxProjBars),
    maxLines: Math.min(MAX_MAX_LINES, intAt(5, d.maxLines)),
    minSwingAtr: numAt(6, d.minSwingAtr, true),
    minSwingReach: zeroInt(7, d.minSwingReach),
    pairPivots: intAt(8, d.pairPivots),
    maxTouches: zeroInt(9, d.maxTouches),
    maxSpanBars: zeroInt(10, d.maxSpanBars),
    maxSlopeAtr: signedAt(11, d.maxSlopeAtr),
    minSlopeAtr: signedAt(12, d.minSlopeAtr),
    maxTouchSpacing: zeroInt(13, d.maxTouchSpacing),
    minTouchSpacing: zeroInt(14, d.minTouchSpacing),
    minCrossings: zeroInt(15, d.minCrossings),
    maxCrossings: zeroInt(16, d.maxCrossings),
    pierceMult: numAt(17, d.pierceMult, true),
    minBackBars: zeroInt(18, d.minBackBars),
    maxDistAtr: numAt(19, maxDistAtrDefault, true),
    maxDistPct: numAt(20, d.maxDistPct, true),
    mergeAtr: numAt(21, mergeAtrDefault, true),
    maxPerPivot: zeroInt(22, maxPerPivotDefault),
    mergePct: numAt(23, d.mergePct, true),
    majorPivots: zeroInt(24, d.majorPivots),
    majorLen: intAt(25, d.majorLen),
    majorSizeAtr: numAt(26, d.majorSizeAtr, true),
  };
}

/** The merge tolerance a pane stored while it was render-only: `dedupeAtr`
 * (a finite number >= 0), or 0 for the older "Merge similar lines" checkbox
 * saved unticked (`dedupe: false`). Undefined when neither was written. */
export function legacyMergeAtr(extendData: unknown): number | undefined {
  if (!extendData || typeof extendData !== "object") return undefined;
  const ext = extendData as { dedupe?: unknown; dedupeAtr?: unknown };
  if (ext.dedupe === false) return 0;
  const v = ext.dedupeAtr;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/** True when a pane's extendData says "One line per pivot" was chosen while
 * Declutter was a render-only select. */
export function legacyOnePerPivot(extendData: unknown): boolean {
  return (
    !!extendData &&
    typeof extendData === "object" &&
    (extendData as { declutter?: unknown }).declutter === "pivot"
  );
}

/** True when a pane's extendData says it was drawing "Only lines near price":
 * the retired `declutter: "near"`, or the older checkbox (`nearPrice: true`)
 * with no `declutter` written over it. */
export function legacyNearPrice(extendData: unknown): boolean {
  if (!extendData || typeof extendData !== "object") return false;
  const ext = extendData as { declutter?: unknown; nearPrice?: unknown };
  if (ext.declutter !== undefined) return ext.declutter === "near";
  return ext.nearPrice === true;
}

/** Bars before the first line can possibly exist: ATR(14) warm-up, plus the
 * two pivots that must confirm (pivotLen each), plus the span they must
 * cover. Every output shares it. minSwingReach is a left-window gate and is
 * deliberately left out (the floor is about the shape of the spec, not the
 * strictest reachable config), and so is majorLen: a major swing further back
 * than this is found once the view scrolls there (see stampTrendlinesFloors),
 * and the margin is paid on every recalc. */
export function trendlinesWarmup(cfg: TrendlinesConfig): number {
  return TL_ATR_LEN + 2 * cfg.pivotLen + cfg.minSpanBars;
}
