// The maths and geometry behind the pattern-overlay ("ghost") tool: copy a run
// of candles, paste it anywhere on any chart, and read how closely the real
// candles under it follow the copied shape.
//
// Pure — no klinecharts, no React, no DOM — so every number here is testable on
// its own; customOverlays.ts only wires figures to it.
//
// The score is deliberately THE SAME metric the server-side pattern search
// ranks by (backend/auto_trader/core/pattern_scan.py): flatten a window of bars
// bar-major into o,h,l,c,o,h,l,c… , z-normalize with ONE mean and ONE sd over
// all 4M values, and take the RMS difference per component. 0 is an identical
// shape, 2 an exact inversion. Price level and volatility drop out by
// construction, which is what lets a pattern copied at 15000 be scored against
// candles at 21000. Keeping the metric identical is the point: a ghost and the
// "Find similar" list must never disagree about what a good match is.
import type { PatternBar } from "./patternSearch";

/** Matches the search's MAX_BARS, so copy and search share one mental model. */
export const MAX_GHOST_BARS = 64;
/** Two bars is the shortest thing with a shape at all. */
export const MIN_GHOST_BARS = 2;

// Below this a window has no movement and no defined normalization (the backend
// calls the same constant _FLAT_EPS).
const FLAT_EPS = 1e-12;

export interface GhostBar {
  open: number;
  high: number;
  low: number;
  close: number;
}

/** A copied pattern, as it travels on the clipboard and is persisted on the
 *  pasted overlay's extendData. `bars` are RATIOS to the first bar's open, not
 *  raw prices: dividing by a constant is affine, so every z-normalized score is
 *  bit-for-bit what the raw prices would have given, while the payload stays
 *  small, price-level agnostic and readable. */
export interface GhostPattern {
  bars: GhostBar[];
  epic: string;
  resolution: string;
  /** Source range in unix SECONDS (PatternBar.ts units), for the label. */
  fromTs: number;
  toTs: number;
  /** True when the selection was longer than the cap and only its newest bars
   *  were kept — the same disclosure the search panel makes. */
  truncated?: boolean;
}

const RATIO_DP = 8;
function round(v: number): number {
  const f = 10 ** RATIO_DP;
  return Math.round(v * f) / f;
}

/** Take a dragged selection to a clipboard pattern, or null when there is not
 *  enough to copy. Over the cap the NEWEST bars win, matching the search. */
export function capturePattern(
  selected: PatternBar[],
  meta: { epic: string; resolution: string },
): GhostPattern | null {
  const kept = selected.slice(-MAX_GHOST_BARS);
  if (kept.length < MIN_GHOST_BARS) return null;
  const base = kept[0].o;
  if (!Number.isFinite(base) || base <= 0) return null;
  const bars = kept.map((b) => ({
    open: round(b.o / base),
    high: round(b.h / base),
    low: round(b.l / base),
    close: round(b.c / base),
  }));
  if (bars.some((b) => !Number.isFinite(b.open + b.high + b.low + b.close))) return null;
  return {
    bars,
    epic: meta.epic,
    resolution: meta.resolution,
    fromTs: kept[0].ts,
    toTs: kept[kept.length - 1].ts,
    truncated: selected.length > kept.length || undefined,
  };
}

/** Flatten bar-major and z-normalize, or null when the window never moves.
 *  ONE mean and sd over all 4M values, never per-series: that is what keeps
 *  body height, wick length and the gap to the previous bar in proportion to
 *  each other (see the backend's zflat for the same note). */
export function zflat(win: GhostBar[]): number[] | null {
  const flat: number[] = [];
  for (const b of win) flat.push(b.open, b.high, b.low, b.close);
  if (flat.length === 0) return null;
  const mean = flat.reduce((a, b) => a + b, 0) / flat.length;
  let sq = 0;
  for (const v of flat) sq += (v - mean) ** 2;
  const sd = Math.sqrt(sq / flat.length);
  if (!(sd > FLAT_EPS)) return null;
  return flat.map((v) => (v - mean) / sd);
}

/** Per-component RMS distance between two equal-length windows: 0 identical,
 *  2 inverted. Null when the lengths disagree or either window is flat. */
export function distance(a: GhostBar[], b: GhostBar[]): number | null {
  if (a.length === 0 || a.length !== b.length) return null;
  const za = zflat(a);
  const zb = zflat(b);
  if (!za || !zb) return null;
  let sum = 0;
  for (let i = 0; i < za.length; i++) sum += (za[i] - zb[i]) ** 2;
  return Math.sqrt(sum / za.length);
}

/** Distance mapped onto 0..1, where 1 is an identical shape. */
function toSimilarity(d: number): number {
  return Math.min(1, Math.max(0, 1 - d / 2));
}

/** The running score: entry k is how closely the real bars have tracked the
 *  ghost UP TO and including bar k. Each prefix is normalized on its own, so
 *  entry k is exactly what a k-bar search would have reported.
 *
 *  Entry 0 is always null: one candle is not a sequence, and a 4-value
 *  normalization of it swings wildly on a single wick. Bars with no candle
 *  under them (the ghost hangs past the newest data) are null too. */
export function prefixSimilarity(ghost: GhostBar[], actual: GhostBar[]): (number | null)[] {
  return ghost.map((_, i) => {
    if (i < 1 || i >= actual.length) return null;
    const d = distance(ghost.slice(0, i + 1), actual.slice(0, i + 1));
    return d == null ? null : toSimilarity(d);
  });
}

/** The real candles a ghost sits over: `count` bars from its anchor rightwards,
 *  or fewer (even none) when the anchor is past the newest bar.
 *
 *  The anchor is resolved by TIMESTAMP first and dataIndex only as a fallback,
 *  which is the order klinecharts itself paints in. A dragged point carries
 *  both, and prepending older bars (a scroll-back page) renumbers every index
 *  while leaving timestamps alone — resolving by index there would score the
 *  ghost against candles N bars from the ones it is drawn on. Index-only points
 *  are real too (a ghost anchored past the newest bar), hence the fallback; a
 *  freshly pasted point is the mirror case, timestamp and no index. */
export function windowUnder(
  list: ReadonlyArray<{ timestamp: number; open: number; high: number; low: number; close: number }>,
  anchor: { dataIndex?: number | null; timestamp?: number | null },
  count: number,
): GhostBar[] {
  let start = anchor.timestamp != null ? list.findIndex((k) => k.timestamp === anchor.timestamp) : -1;
  if (start < 0 && typeof anchor.dataIndex === "number" && anchor.dataIndex >= 0) {
    start = Math.round(anchor.dataIndex);
  }
  if (start < 0) return [];
  return list
    .slice(start, start + count)
    .map((k) => ({ open: k.open, high: k.high, low: k.low, close: k.close }));
}

/** The whole ghost's score against the window under it, or null. */
export function overallSimilarity(ghost: GhostBar[], actual: GhostBar[]): number | null {
  const n = Math.min(ghost.length, actual.length);
  if (n < MIN_GHOST_BARS) return null;
  const d = distance(ghost.slice(0, n), actual.slice(0, n));
  return d == null ? null : toSimilarity(d);
}

/** The affine placement of a ghost in price space: the mean and sd its values
 *  are stretched onto. Frozen on extendData when the user pins a ghost, so
 *  pinning keeps the SIZE it was drawn at and not just its position. */
export interface GhostFit {
  mean: number;
  sd: number;
}

export function windowMoments(win: GhostBar[]): GhostFit | null {
  const flat: number[] = [];
  for (const b of win) flat.push(b.open, b.high, b.low, b.close);
  if (flat.length === 0) return null;
  const mean = flat.reduce((a, b) => a + b, 0) / flat.length;
  let sq = 0;
  for (const v of flat) sq += (v - mean) ** 2;
  const sd = Math.sqrt(sq / flat.length);
  return sd > FLAT_EPS ? { mean, sd } : null;
}

function mapBetween(bars: GhostBar[], from: GhostFit, to: GhostFit): GhostBar[] {
  const map = (v: number) => ((v - from.mean) / from.sd) * to.sd + to.mean;
  return bars.map((b) => ({
    open: map(b.open),
    high: map(b.high),
    low: map(b.low),
    close: map(b.close),
  }));
}

/** Stretch a shape onto a fit: z-normalize it, then give it that mean and sd. */
export function mapToFit(bars: GhostBar[], fit: GhostFit): GhostBar[] {
  const own = windowMoments(bars);
  return own ? mapBetween(bars, own, fit) : bars;
}

/** Re-express the ghost in the window's own price space: same mean and sd as
 *  the candles it sits over. This is what makes the drawn overlay agree with
 *  the score, which ignores level and scale entirely — without it a ghost can
 *  read 95% while floating visibly above the candles.
 *
 *  `actual` may be shorter than the ghost (the ghost hangs past the newest
 *  bar); the fit then comes from the bars that do exist. */
export function fitToWindow(ghost: GhostBar[], actual: GhostBar[]): GhostBar[] | null {
  const n = Math.min(ghost.length, actual.length);
  // One bar is not a scale: its four values put the whole ghost's height at the
  // mercy of a single wick, which reads as the ghost pulsing while it is
  // dragged over the live edge.
  if (n < MIN_GHOST_BARS) return null;
  // Normalize by the COVERED part of the ghost, not the whole of it: the bars
  // sitting on candles are the ones that have to line up with them, even when
  // the tail hangs past the newest bar.
  const g = windowMoments(ghost.slice(0, n));
  const a = windowMoments(actual.slice(0, n));
  return g && a ? mapBetween(ghost, g, a) : null;
}

/** Where a ghost is actually drawn, in prices. One place, so what the overlay
 *  paints and what a pin freezes cannot drift apart:
 *
 *   1. pinned — the fit the user placed it at, exactly as frozen (a ghost
 *      pinned before fits were stored keeps its old placement: the shape hung
 *      off its anchor price, which is where its owner last saw it);
 *   2. the candles under it, matched mean and sd (this is the default, and it
 *      is what makes the drawing agree with the score);
 *   3. off the end of the data — no window to fit, so it keeps the chart's own
 *      scale (from `reference`, the newest loaded bars) centred on the price it
 *      was dropped at, rather than jumping to a raw multiple of that price;
 *   4. nothing loaded at all — the stored ratios off the anchor price. */
export function ghostPrices(
  bars: GhostBar[],
  opts: {
    actual: GhostBar[];
    reference: GhostBar[];
    anchorPrice: number;
    pinned?: boolean;
    pinnedFit?: GhostFit | null;
  },
): GhostBar[] {
  if (opts.pinnedFit) return mapToFit(bars, opts.pinnedFit);
  if (opts.pinned) return anchorToPrice(bars, opts.anchorPrice);
  const fitted = fitToWindow(bars, opts.actual);
  if (fitted) return fitted;
  const ref = windowMoments(opts.reference);
  if (ref && opts.anchorPrice > 0) return mapToFit(bars, { mean: opts.anchorPrice, sd: ref.sd });
  return anchorToPrice(bars, opts.anchorPrice);
}

/** Pinned placement: put the stored ratios back on real prices with the first
 *  bar's open at `anchorPrice`. Used once the user has dragged the ghost
 *  vertically and taken placement into their own hands. */
export function anchorToPrice(bars: GhostBar[], anchorPrice: number): GhostBar[] {
  const base = bars[0]?.open || 1;
  const k = anchorPrice / base;
  return bars.map((b) => ({
    open: b.open * k,
    high: b.high * k,
    low: b.low * k,
    close: b.close * k,
  }));
}

export interface GhostCandle {
  /** Bar centre. */
  x: number;
  w: number;
  bodyTop: number;
  bodyH: number;
  wickTop: number;
  wickH: number;
  /** The close in pixels — what the close-line shape joins up. */
  closeY: number;
  up: boolean;
}

// A doji whose body rounds to zero pixels would vanish; the chart's own candles
// keep a hairline for the same reason.
const MIN_BODY_PX = 1;
// Share of the bar slot the body occupies, matching klinecharts' candle look.
const BODY_SHARE = 0.7;

/** Lay the (already price-mapped) ghost bars out in pixels: one bar per slot,
 *  rightwards from the anchor. */
export function ghostGeometry(
  bars: GhostBar[],
  opts: {
    anchorX: number;
    barSpace: number;
    priceToY: (price: number) => number;
    /** Body width in pixels; defaults to a share of the slot. The chart passes
     *  klinecharts' own gapBar so ghost bodies match the candles beneath. */
    bodyWidth?: number;
  },
): GhostCandle[] {
  const { anchorX, barSpace, priceToY } = opts;
  const w = Math.max(1, opts.bodyWidth ?? barSpace * BODY_SHARE);
  return bars.map((b, i) => {
    const top = priceToY(Math.max(b.open, b.close));
    const bottom = priceToY(Math.min(b.open, b.close));
    const wickTop = priceToY(b.high);
    return {
      x: anchorX + i * barSpace,
      w,
      bodyTop: top,
      bodyH: Math.max(MIN_BODY_PX, bottom - top),
      wickTop,
      wickH: priceToY(b.low) - wickTop,
      closeY: priceToY(b.close),
      up: b.close >= b.open,
    };
  });
}

/** The running score as the strip prints it. */
export function formatSimilarity(sim: number | null): string {
  if (sim == null) return "-";
  return `${Math.round(sim * 100)}%`;
}

// Strip tints: a close match reads green, a poor one red, with two steps
// between so the eye can follow where the match starts to go.
const TINT_STRONG = "rgba(38, 166, 154, 0.85)";
const TINT_GOOD = "rgba(38, 166, 154, 0.45)";
const TINT_WEAK = "rgba(239, 83, 80, 0.45)";
const TINT_POOR = "rgba(239, 83, 80, 0.85)";
const TINT_NONE = "rgba(120, 130, 145, 0.35)";

/** Cell colour for a running score (null = no score yet). */
export function similarityTint(sim: number | null): string {
  if (sim == null) return TINT_NONE;
  if (sim >= 0.85) return TINT_STRONG;
  if (sim >= 0.7) return TINT_GOOD;
  if (sim >= 0.5) return TINT_WEAK;
  return TINT_POOR;
}

/** The two label lines drawn above the ghost: what it scores, and where it came
 *  from. The provenance line only names the market when it is not the one the
 *  ghost is currently sitting on — a pattern pasted back on its own chart does
 *  not need telling. */
export function ghostLabelLines(
  ghost: GhostPattern,
  sim: number | null,
  ctx: { epic: string; sameTimeframe: boolean; compared: number },
): [string, string] {
  const head = sim == null ? "no match yet" : `match ${formatSimilarity(sim)}`;
  const total = ghost.bars.length;
  // A ghost hanging past the newest bar is scored on the bars it actually
  // covers, so say so rather than letting "match 87%" read as a verdict on the
  // whole pattern (the search panel discloses its own truncation the same way).
  const parts = [
    ctx.compared > 0 && ctx.compared < total ? `${ctx.compared} of ${total} bars` : `${total} bars`,
  ];
  if (!ctx.sameTimeframe) parts.push(ghost.resolution);
  if (ghost.epic && ghost.epic !== ctx.epic) parts.push(ghost.epic);
  return [head, parts.join(" \u00b7 ")];
}

/** Where the readout goes: the per-candle strip and the two label lines, kept
 *  inside the pane. A ghost dropped low on the chart has no room underneath —
 *  the strip flips above the shape rather than being clipped away by the pane
 *  edge, which is how it silently vanished before. */
export function readoutLayout(g: {
  /** Highest and lowest ghost pixel (y grows downwards). */
  top: number;
  bottom: number;
  /** Pane height. */
  height: number;
  stripH: number;
  gap: number;
  /** Height of the two stacked label lines. */
  labelH: number;
}): { stripY: number; labelY: number; stripAbove: boolean } {
  const { top, bottom, height, stripH, gap, labelH } = g;
  const EDGE = 2;
  const below = bottom + gap;
  const above = top - gap - stripH;
  const stripAbove = below + stripH > height - EDGE && above >= EDGE;
  let stripY = stripAbove ? above : below;
  stripY = Math.min(Math.max(EDGE, stripY), Math.max(EDGE, height - stripH - EDGE));
  // The labels sit above whichever of the two is uppermost, and drop below the
  // ghost when there is no headroom at all.
  const ceiling = stripAbove ? stripY : top;
  let labelY = ceiling - gap - labelH;
  if (labelY < EDGE) labelY = Math.min((stripAbove ? bottom : stripY + stripH) + gap, height - labelH - EDGE);
  return { stripY, labelY, stripAbove };
}

// --- how a ghost is PAINTED -------------------------------------------------
// None of this touches the score: the shape is z-normalized before it is
// compared, so opacity, colour and even drawing a close line instead of candles
// leave the match untouched. It is purely about reading the ghost against the
// real bars it sits on top of.

export interface GhostStyle {
  /** Ghost candles, or a single line through the copied closes. */
  shape: "candles" | "line";
  /** 0.15..1 — how strongly the ghost sits over the candles beneath it. */
  opacity: number;
  /** The chart's up/down colours, or one flat hex for the whole ghost. */
  color: "direction" | string;
  /** The per-candle strip and the headline percentage. */
  score: boolean;
}

export const GHOST_STYLE_DEFAULT: GhostStyle = {
  shape: "candles",
  opacity: 0.5,
  color: "direction",
  score: true,
};

const MIN_GHOST_OPACITY = 0.15;

/** Read a stored (or missing, or half-written) ghost style back as a whole one.
 *  Ghosts pasted before this existed have no style at all and land on the
 *  defaults, which are what they were already drawn with. */
export function asGhostStyle(raw: unknown): GhostStyle {
  const r = (raw ?? {}) as Partial<GhostStyle>;
  const opacity =
    typeof r.opacity === "number" && Number.isFinite(r.opacity)
      ? Math.min(1, Math.max(MIN_GHOST_OPACITY, r.opacity))
      : GHOST_STYLE_DEFAULT.opacity;
  return {
    shape: r.shape === "line" ? "line" : "candles",
    opacity,
    color: typeof r.color === "string" && r.color !== "" ? r.color : "direction",
    score: r.score !== false,
  };
}
