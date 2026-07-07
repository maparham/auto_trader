// Fib retracement config + pure geometry. The config lives on the drawing's
// extendData.fib (persisted with the drawing); the geometry feeds the custom
// fibonacciLine overlay template. Level 0 sits at the SECOND anchor (point1) and
// level 1 at the first, matching both the old built-in and TV; `reverse` swaps them.

export interface FibLevel {
  value: number;
  enabled: boolean;
  color: string;
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
    ? o.levels.filter(
        (l): l is FibLevel =>
          !!l &&
          typeof l === "object" &&
          typeof l.value === "number" &&
          Number.isFinite(l.value) &&
          typeof l.enabled === "boolean" &&
          typeof l.color === "string",
      )
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
  const spanLeft = Math.min(c0.x, c1.x);
  const spanRight = Math.max(c0.x, c1.x);
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
      };
    });
}
