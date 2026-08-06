// Catalog of indicators, wrappers, crosses, candle fields, and timeframes for
// the strategy expression editor. Mirrors the backend registry
// (backend/auto_trader/strategy/expr/registry.py, nodes.py) so completion,
// signatures, and highlighting stay in lockstep with what the backend accepts.

// Pattern predicates are DERIVED from the detector's name map rather than
// listed here, so the editor can never offer a name the detector doesn't know.
// This is the file's only import; candlePatterns.ts pulls klinecharts as
// TYPE-ONLY, so the catalog stays runtime-dependency-free.
import { PATTERN_PREDICATE_FNS } from "../indicators/candlePatterns";

export interface CatalogEntry {
  name: string;
  insert: string;
  signature: string;
  detail: string;
}

export const INDICATORS: CatalogEntry[] = [
  { name: "EMA", insert: "EMA(9)", signature: "EMA(length)", detail: "Exponential moving average" },
  { name: "SMA", insert: "SMA(20)", signature: "SMA(length)", detail: "Simple moving average" },
  { name: "RSI", insert: "RSI(14)", signature: "RSI(length)", detail: "Relative strength index" },
  { name: "ATR", insert: "ATR(14)", signature: "ATR(length)", detail: "Average true range" },
  { name: "VOLMA", insert: "VOLMA(20)", signature: "VOLMA(length)", detail: "Volume moving average" },
  { name: "VOL", insert: "VOL", signature: "VOL", detail: "Bar volume" },
  { name: "AVWAP", insert: "AVWAP(0)", signature: "AVWAP(anchor)", detail: "Anchored VWAP" },
];

export const WRAPPERS: CatalogEntry[] = [
  { name: "slope", insert: "slope(EMA(9), 3)", signature: "slope(x, n)", detail: "Rate of change, percent per hour" },
  { name: "highest", insert: "highest(candle.high, 20)", signature: "highest(x, n)", detail: "Highest over the last n bars" },
  { name: "lowest", insert: "lowest(candle.low, 20)", signature: "lowest(x, n)", detail: "Lowest over the last n bars" },
  { name: "avg", insert: "avg(candle.close, 20)", signature: "avg(x, n)", detail: "Average over the last n bars" },
];

export const CROSSES: CatalogEntry[] = [
  { name: "crossAbove", insert: "crossAbove(candle.close, EMA(9))", signature: "crossAbove(a, b)", detail: "a crosses above b" },
  { name: "crossBelow", insert: "crossBelow(candle.close, EMA(9))", signature: "crossBelow(a, b)", detail: "a crosses below b" },
];

export const CANDLE_FIELDS = [
  "open", "high", "low", "close", "volume", "body", "range", "wickTop", "wickBottom",
] as const;

// Mirrors backend strategy/expr/tfs.py TF_RESOLUTIONS (the pin aliases the
// backend accepts) — `seconds` is the nominal bar width, duplicated from
// feed.ts RESOLUTION_SECONDS so this catalog stays dependency-free for the
// parser's warm-up math.
export const TIMEFRAMES: Array<{ alias: string; resolution: string; seconds: number }> = [
  { alias: "5m", resolution: "MINUTE_5", seconds: 300 },
  { alias: "15m", resolution: "MINUTE_15", seconds: 900 },
  { alias: "30m", resolution: "MINUTE_30", seconds: 1800 },
  { alias: "1H", resolution: "HOUR", seconds: 3600 },
  { alias: "4H", resolution: "HOUR_4", seconds: 14400 },
  { alias: "D", resolution: "DAY", seconds: 86400 },
  { alias: "W", resolution: "WEEK", seconds: 604800 },
];

/** Nominal bar width for a pin alias (or canonical resolution); null if unknown. */
export function tfSeconds(tf: string): number | null {
  const hit = TIMEFRAMES.find((t) => t.alias === tf || t.resolution === tf);
  return hit ? hit.seconds : null;
}

// Arity + argument kind for indicators, matching registry.IndicatorSpec.
export interface IndicatorSpec {
  arity: number;
  argKind: "length" | "anchor";
}

export const INDICATOR_SPECS: Record<string, IndicatorSpec> = {
  EMA: { arity: 1, argKind: "length" },
  SMA: { arity: 1, argKind: "length" },
  RSI: { arity: 1, argKind: "length" },
  ATR: { arity: 1, argKind: "length" },
  VOLMA: { arity: 1, argKind: "length" },
  VOL: { arity: 0, argKind: "length" },
  AVWAP: { arity: 1, argKind: "anchor" },
};

export const WRAPPER_ARITY: Record<string, number> = {
  slope: 2,
  highest: 2,
  lowest: 2,
  avg: 2,
};

export const CROSS_FNS = ["crossAbove", "crossBelow"] as const;

export const CONDITIONS: CatalogEntry[] = [
  { name: "count", insert: "count(bearish(candle), 10)", signature: "count(cond, n)", detail: "Bars matching a condition in the last n bars" },
  { name: "bullish", insert: "bullish(candle)", signature: "bullish(candle)", detail: "Candle closed above its open" },
  { name: "bearish", insert: "bearish(candle)", signature: "bearish(candle)", detail: "Candle closed below its open" },
  { name: "barsSinceEntry", insert: "barsSinceEntry", signature: "barsSinceEntry", detail: "Bars since the trade opened (exit rules only)" },
];

// `Object.keys` (not `in`/index lookup) so inherited Object.prototype members
// — toString, valueOf, constructor — can never leak in as predicate names.
const PATTERN_NAMES: readonly string[] = Object.keys(PATTERN_PREDICATE_FNS);

const PATTERN_DETAIL: Record<string, string> = {
  bullPattern: "Any bullish candlestick pattern, regardless of chart display toggles",
  bearPattern: "Any bearish candlestick pattern, regardless of chart display toggles",
};

export const PATTERNS: CatalogEntry[] = PATTERN_NAMES.map((name) => ({
  name,
  insert: `${name}(candle)`,
  signature: `${name}(candle)`,
  detail: Object.hasOwn(PATTERN_DETAIL, name)
    ? PATTERN_DETAIL[name]
    : `${name} candlestick pattern`,
}));

export const PREDICATE_FNS: readonly string[] = ["bullish", "bearish", ...PATTERN_NAMES];

// 14 bars for the epsilon series (0.05 * SMA14 of true range) + 4 for the
// deepest lookback (ladderBottom needs i >= 4). Mirrored by the backend's
// warmup.py PATTERN_WARMUP. `bullish`/`bearish` are pure single-bar tests and
// keep a warm-up of 0, so this set holds only the pattern names.
export const PATTERN_WARMUP = 18;

export const PATTERN_FN_SET: ReadonlySet<string> = new Set(PATTERN_NAMES);

export const COUNT_FN = "count";
