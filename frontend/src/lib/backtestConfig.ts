// Shared rule-strategy schema: the same shape the backend's OperandDTO/RuleDTO/
// RuleGroupDTO mirror, plus the seriesName contract both sides derive from so
// serialization and validation can never disagree (see the backend endpoint's
// D4 check in app.py).

export type IndicatorKind = "EMA" | "SMA" | "AVWAP" | "RSI" | "VOL" | "VOLMA";
export type PriceField = "close" | "open" | "high" | "low";
export type Operator = "crossesAbove" | "crossesBelow" | "gt" | "lt" | "gte" | "lte";
export type Combine = "AND" | "OR";

export type Operand =
  | { kind: "indicator"; indicator: IndicatorKind; length?: number }
  | { kind: "price"; field: PriceField }
  | { kind: "const"; value: number };

export interface Rule {
  left: Operand;
  op: Operator;
  right: Operand;
}

export interface RuleGroup {
  combine: Combine;
  rules: Rule[];
}

export type RangeMode = "bars" | "lastDay" | "lastWeek" | "lastMonth" | "custom";
// How far back to load candles before the trading window so indicators are
// already warm at the window's first bar (D6 in the plan) — "full" = all
// available history (default), "bars" = a user-typed count, "minimal" = just
// enough for the longest indicator in the config.
export type HistoryDepth = "full" | "bars" | "minimal";

export interface RangeConfig {
  mode: RangeMode;
  bars?: number;
  fromMs?: number;
  toMs?: number;
  history?: HistoryDepth;
  historyBars?: number;
}

export interface Costs {
  quantity: number;
  commissionPerSide: number;
  slippage: number;
  startingCash: number;
}

export interface BacktestConfig {
  range: RangeConfig;
  longEntry: RuleGroup;
  longExit: RuleGroup;
  shortEntry: RuleGroup;
  shortExit: RuleGroup;
  // Per-side master switches. A disabled side never trades even if its rule
  // groups are populated (the user keeps the rules while the side is parked).
  // Read defensively (`!== false`) so a preset saved before these existed —
  // where the field is undefined — still trades that side rather than silently
  // disabling it.
  longEnabled: boolean;
  shortEnabled: boolean;
  costs: Costs;
}

/** The payload key an operand's series lives under, or null if it has no
 * series (price/const are read straight off the candle). AVWAP/VOL have no
 * length; EMA/SMA/RSI/VOLMA are keyed by `${indicator}_${length}`. */
export function seriesName(op: Operand): string | null {
  if (op.kind !== "indicator") return null;
  if (op.indicator === "AVWAP" || op.indicator === "VOL") return op.indicator;
  return `${op.indicator}_${op.length}`;
}

/** Every indicator operand referenced by any of the four rule groups, deduped by
 * series name, so the caller computes each series once regardless of how many
 * rules use it. */
export function collectSeriesOperands(cfg: BacktestConfig): Operand[] {
  const seen = new Map<string, Operand>();
  for (const group of [cfg.longEntry, cfg.longExit, cfg.shortEntry, cfg.shortExit]) {
    for (const rule of group.rules) {
      for (const op of [rule.left, rule.right]) {
        const name = seriesName(op);
        if (name !== null && !seen.has(name)) seen.set(name, op);
      }
    }
  }
  return [...seen.values()];
}

/** The longest indicator length referenced anywhere in the config — the number
 * of bars of warm-up the slowest indicator needs before it produces a value. */
export function longestIndicatorLength(cfg: BacktestConfig): number {
  return Math.max(
    1,
    ...collectSeriesOperands(cfg).map((op) => (op.kind === "indicator" ? op.length ?? 1 : 1)),
  );
}

export function defaultBacktestConfig(): BacktestConfig {
  const cross = (op: Operator): RuleGroup => ({
    combine: "AND",
    rules: [
      {
        left: { kind: "indicator", indicator: "EMA", length: 9 },
        op,
        right: { kind: "indicator", indicator: "EMA", length: 21 },
      },
    ],
  });
  return {
    range: { mode: "bars", bars: 500, history: "full" },
    longEntry: cross("crossesAbove"),
    longExit: cross("crossesBelow"),
    shortEntry: cross("crossesBelow"),
    shortExit: cross("crossesAbove"),
    longEnabled: true,
    shortEnabled: true,
    costs: { quantity: 1, commissionPerSide: 0, slippage: 0, startingCash: 10_000 },
  };
}
