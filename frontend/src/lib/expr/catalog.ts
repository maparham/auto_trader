// Catalog of indicators, wrappers, crosses, candle fields, and timeframes for
// the strategy expression editor. Mirrors the backend registry
// (backend/auto_trader/strategy/expr/registry.py, nodes.py) so completion,
// signatures, and highlighting stay in lockstep with what the backend accepts.

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

export const TIMEFRAMES: Array<{ alias: string; resolution: string }> = [
  { alias: "5m", resolution: "MINUTE_5" },
  { alias: "15m", resolution: "MINUTE_15" },
  { alias: "30m", resolution: "MINUTE_30" },
  { alias: "1H", resolution: "HOUR" },
  { alias: "4H", resolution: "HOUR_4" },
  { alias: "D", resolution: "DAY" },
  { alias: "W", resolution: "WEEK" },
];

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
