// Fib retracement config + pure geometry. The config lives on the drawing's
// extendData.fib (persisted with the drawing); the geometry feeds the custom
// fibonacciLine overlay template. Level 0 sits at the SECOND anchor (point1) and
// level 1 at the first, matching both the old built-in and TV; `reverse` swaps them.

import { clipSegmentToRect, DRAW_CLIP_PAD } from "./indicators/shared";

export interface FibLevel {
  value: number;
  enabled: boolean;
  color: string;
  // Per-level width/dash OVERRIDES. Absent ⇒ the level uses the drawing's shared
  // styles.line; set (by the level's own picker) ⇒ this level wins.
  size?: number;
  style?: "solid" | "dashed";
}
export type FibExtend = "none" | "left" | "right" | "both";
export interface FibConfig {
  levels: FibLevel[];
  extend: FibExtend;
  reverse: boolean;
  trendLine: boolean;
  labels: boolean;
}

// TV's default palette: greys for the 0/1 bounds, distinct hues between, and the
// common extensions present but off until the user enables them.
const DEFAULT_LEVELS: ReadonlyArray<FibLevel> = [
  { value: 0, enabled: true, color: "#787b86" },
  { value: 0.236, enabled: true, color: "#f23645" },
  { value: 0.382, enabled: true, color: "#ff9800" },
  { value: 0.5, enabled: true, color: "#4caf50" },
  { value: 0.618, enabled: true, color: "#089981" },
  { value: 0.786, enabled: true, color: "#00bcd4" },
  { value: 1, enabled: true, color: "#787b86" },
  { value: 1.618, enabled: false, color: "#2962ff" },
  { value: 2.618, enabled: false, color: "#f23645" },
  { value: -0.236, enabled: false, color: "#e91e63" },
];

export function defaultFibConfig(): FibConfig {
  return {
    levels: DEFAULT_LEVELS.map((l) => ({ ...l })),
    extend: "none",
    reverse: false,
    trendLine: true,
    labels: true,
  };
}

// Narrow unknown extendData.fib to a full FibConfig (never throws; anything
// malformed falls back field-by-field to the defaults).
export function asFibConfig(v: unknown): FibConfig {
  const d = defaultFibConfig();
  if (!v || typeof v !== "object") return d;
  const o = v as Partial<FibConfig>;
  const levels = Array.isArray(o.levels)
    ? o.levels
        .filter(
          (l): l is FibLevel =>
            !!l &&
            typeof l === "object" &&
            typeof l.value === "number" &&
            Number.isFinite(l.value) &&
            typeof l.enabled === "boolean" &&
            typeof l.color === "string",
        )
        // Drop malformed per-level overrides rather than the whole level.
        .map((l) => ({
          ...l,
          size: typeof l.size === "number" && Number.isFinite(l.size) ? l.size : undefined,
          style: l.style === "solid" || l.style === "dashed" ? l.style : undefined,
        }))
    : d.levels;
  return {
    levels: levels.length ? levels : d.levels,
    extend: o.extend === "left" || o.extend === "right" || o.extend === "both" ? o.extend : "none",
    reverse: o.reverse === true,
    trendLine: o.trendLine !== false,
    labels: o.labels !== false,
  };
}

export interface FibSegment {
  level: number;
  y: number;
  x1: number;
  x2: number;
  color: string;
  label: string;
  // Present only when the level overrides the shared width/dash.
  size?: number;
  style?: "solid" | "dashed";
}

// One horizontal segment per ENABLED level. y/price interpolate between the two
// anchors (levels outside [0,1] extrapolate); the x-span is the anchors' x-range,
// widened to the pane edge(s) by `extend`. Label = "ratio (price)".
export function fibLevelSegments(args: {
  cfg: FibConfig;
  coordinates: ReadonlyArray<{ x: number; y: number }>;
  values: readonly [number, number];
  boundingWidth: number;
  precision: number;
}): FibSegment[] {
  const { cfg, coordinates, values, boundingWidth, precision } = args;
  if (coordinates.length < 2) return [];
  const [c0, c1] = coordinates;
  // Level 0 anchor / level 1 anchor (reverse swaps).
  const [zero, one] = cfg.reverse ? [c0, c1] : [c1, c0];
  const [vZero, vOne] = cfg.reverse ? [values[0], values[1]] : [values[1], values[0]];
  // Anchor x clamped near the pane: extend mixes a pane edge with a RAW
  // anchor x, so a fib panned far off-pane would otherwise span the whole
  // off-pane distance on every enabled (dashable) level, every frame —
  // klinecharts neither culls overlays nor clips its line figure.
  const clampX = (x: number): number =>
    Math.min(boundingWidth + DRAW_CLIP_PAD, Math.max(-DRAW_CLIP_PAD, x));
  const spanLeft = clampX(Math.min(c0.x, c1.x));
  const spanRight = clampX(Math.max(c0.x, c1.x));
  const x1 = cfg.extend === "left" || cfg.extend === "both" ? 0 : spanLeft;
  const x2 = cfg.extend === "right" || cfg.extend === "both" ? boundingWidth : spanRight;
  return cfg.levels
    .filter((l) => l.enabled)
    .map((l) => {
      const price = vZero + (vOne - vZero) * l.value;
      return {
        level: l.value,
        y: zero.y + (one.y - zero.y) * l.value,
        x1,
        x2,
        color: l.color,
        label: `${l.value} (${price.toFixed(precision)})`,
        size: l.size,
        style: l.style,
      };
    });
}

// --- Fib channel ------------------------------------------------------------
// Three anchors: point0→point1 is the BASE line (level 0), point2 sets the
// parallel line through it (level 1). Every level is the base line shifted
// vertically by `ratio × gap`, where gap is the vertical distance from the base
// line to point2. Unlike the retracement's horizontal levels these are SLOPED,
// so each segment carries both endpoints and the x-clip has to recompute y.

export interface FibChannelSegment {
  level: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  label: string;
  // Per-level width/dash overrides, same meaning as FibSegment's.
  size?: number;
  style?: "solid" | "dashed";
}

// y on the infinite line through a/b at x. A VERTICAL base (a.x === b.x) has no
// single y per x — fibChannelSegments rejects that case before calling here, so
// the dx === 0 branch is only a total-function guard, never a render path.
function lineYAt(a: { x: number; y: number }, b: { x: number; y: number }, x: number): number {
  const dx = b.x - a.x;
  if (dx === 0) return a.y;
  return a.y + ((b.y - a.y) * (x - a.x)) / dx;
}

// Clipping matters twice over for a sloped level. Extending to a pane edge and
// pulling in an off-pane anchor are the same operation — pick the x, take the
// line's y there — and clamping x ALONE (which the retracement can do, its
// levels being horizontal) both shears the channel and leaves y unbounded: a
// near-vertical base has a slope in the thousands, so a padded x still lands y
// in the millions. So build each level's full segment and hand it to the shared
// Liang-Barsky clip against the padded pane box, exactly as the line overlays do.

// One sloped segment per ENABLED level. Labels are the ratio ALONE: price varies
// along a sloped line, so the retracement's "ratio (price)" would be a lie at
// every x but one (and plain wrong on a log axis).
export function fibChannelSegments(args: {
  cfg: FibConfig;
  coordinates: ReadonlyArray<{ x: number; y: number }>;
  boundingWidth: number;
  boundingHeight: number;
}): FibChannelSegment[] {
  const { cfg, coordinates, boundingWidth, boundingHeight } = args;
  if (coordinates.length < 3) return [];
  const [c0, c1, c2] = coordinates;
  // A vertical base is not a channel: every level would be the same undefined
  // line, and extended it would paint HORIZONTALLY across the pane — the exact
  // opposite of what the user drew. Two clicks on one candle (or any zoom-out
  // where bars go sub-pixel) reaches this, so draw nothing instead. It matches
  // OverlayManager's own degenerate-drawing rule (anchors collapsed onto one x).
  if (c0.x === c1.x) return [];
  // Vertical gap from the base line to the third anchor, measured at its own x.
  const gap = c2.y - lineYAt(c0, c1, c2.x);
  // reverse swaps which LINE is level 0: base ⇄ parallel. (The retracement's
  // reverse swaps which ANCHOR is level 0 — same checkbox, same config object,
  // but the channel's level 0 rides the base line by default, as TV's does.)
  const zeroOffset = cfg.reverse ? gap : 0;
  const oneOffset = cfg.reverse ? 0 : gap;
  const x1 =
    cfg.extend === "left" || cfg.extend === "both" ? 0 : Math.min(c0.x, c1.x);
  const x2 =
    cfg.extend === "right" || cfg.extend === "both" ? boundingWidth : Math.max(c0.x, c1.x);
  const out: FibChannelSegment[] = [];
  for (const l of cfg.levels) {
    if (!l.enabled) continue;
    const offset = zeroOffset + (oneOffset - zeroOffset) * l.value;
    const clipped = clipSegmentToRect(
      x1,
      lineYAt(c0, c1, x1) + offset,
      x2,
      lineYAt(c0, c1, x2) + offset,
      -DRAW_CLIP_PAD,
      -DRAW_CLIP_PAD,
      boundingWidth + DRAW_CLIP_PAD,
      boundingHeight + DRAW_CLIP_PAD,
    );
    if (!clipped) continue; // the level never enters the padded pane
    out.push({
      level: l.value,
      x1: clipped[0],
      y1: clipped[1],
      x2: clipped[2],
      y2: clipped[3],
      color: l.color,
      label: String(l.value),
      size: l.size,
      style: l.style,
    });
  }
  return out;
}
