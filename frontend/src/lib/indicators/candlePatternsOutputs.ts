// The CANDLE_PATTERNS pane's rule/alert shape. candlePatterns.ts is already
// runtime-free (type-only klinecharts imports), so this leaf reads its defs
// and the chart's own gating (computeCandlePatterns) directly. Mirrors Python
// indicators/candle_patterns_pane.py.
//
// One 0/1 output per pattern id plus bullPattern / bearPattern. Outputs follow
// the pane's toggles (extendData.disabled, keyed by TOGGLE id), and the
// aggregates count only enabled patterns: what the alert watches is what the
// chart marks.
import { CANDLE_PATTERN_DEFS, computeCandlePatterns, type CandlePatternsExtend, type PatternBar } from "./candlePatterns";

export const CANDLE_PATTERN_AGGREGATES = ["bullPattern", "bearPattern"] as const;

/** Same floor as the rule predicates (lib/expr/catalog.ts PATTERN_WARMUP):
 * 14 bars for the epsilon series plus the deepest lookback (4). */
export const CANDLE_PATTERNS_WARMUP = 18;

function disabledOf(extendData: unknown): Record<string, unknown> {
  const ext = (extendData && typeof extendData === "object" ? extendData : {}) as { disabled?: unknown };
  return ext.disabled && typeof ext.disabled === "object" ? (ext.disabled as Record<string, unknown>) : {};
}

export function candlePatternsOutputs(extendData: unknown): string[] {
  const disabled = disabledOf(extendData);
  return [...CANDLE_PATTERN_DEFS.filter((d) => !disabled[d.toggle]).map((d) => d.id), ...CANDLE_PATTERN_AGGREGATES];
}

export function candlePatternsWarmup(extendData: unknown, output: string): number {
  return candlePatternsOutputs(extendData).includes(output) ? CANDLE_PATTERNS_WARMUP : 0;
}

/** 1 on the bars where `output` hits under the pane's toggles, else 0. */
export function candlePatternSeries(bars: readonly PatternBar[], extendData: unknown, output: string): number[] {
  const ext: CandlePatternsExtend = { disabled: disabledOf(extendData) as Record<string, boolean> };
  const points = computeCandlePatterns(bars, ext);
  const pick = (idx: number): boolean => {
    const d = CANDLE_PATTERN_DEFS[idx];
    if (output === "bullPattern") return d.polarity === "bull";
    if (output === "bearPattern") return d.polarity === "bear";
    return d.id === output;
  };
  return points.map((p) => ((p.hits ?? []).some(pick) ? 1 : 0));
}
