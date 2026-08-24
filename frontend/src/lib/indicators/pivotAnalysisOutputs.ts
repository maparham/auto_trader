// The PIVOT_ANALYSIS pane's OUTPUT SHAPE and config parsing — split out of
// pivotAnalysis.ts as a leaf with no RUNTIME imports. Same split, same reason,
// as ./fvgOutputs / ./pivotBandsOutputs.
//
// Mirrors Python indicators/pivot_analysis.py (`parse_pivot_analysis_config` /
// `pivot_analysis_outputs` / `pivot_analysis_warmup`), which is what the
// backend validates a rule reference against.

/** The rule-operand names, in pane order — the SAME strings as the backend's
 * pivot_analysis_outputs. `pivotHigh` first — the chart click-to-insert token
 * emits outputs[0]. */
export const PIVOT_ANALYSIS_OUTPUTS = ["pivotHigh", "pivotLow", "deltaPct", "deltaT"] as const;

export type PivotAnalysisOutput = (typeof PIVOT_ANALYSIS_OUTPUTS)[number];

export interface PivotAnalysisRefConfig {
  nHigh: number; // pivot-high fractal strength; confirm lag = this many bars
  nLow: number; // pivot-low fractal strength; confirm lag = this many bars
}

export const PIVOT_ANALYSIS_REF_DEFAULTS: PivotAnalysisRefConfig = { nHigh: 50, nLow: 50 };

/** calcParams order: [highLength, lowLength, minPctHigh, minPctLow]. Only the
 * two lengths affect warm-up (the % filter changes WHICH pivots count, not
 * the confirm lag), so minPctHigh/minPctLow aren't read here. Mirrors
 * PIVOT_ANALYSIS_TEMPLATE.calc's own parsing (Math.max(1, Number(x) || 50),
 * no floor) — matched by backend parse_pivot_analysis_config, which floors
 * for Python's integer range(). */
export function parsePivotAnalysisRefConfig(calcParams: unknown): PivotAnalysisRefConfig {
  const p = Array.isArray(calcParams) ? calcParams : [];
  const d = PIVOT_ANALYSIS_REF_DEFAULTS;
  return {
    nHigh: Math.max(1, Number(p[0]) || d.nHigh),
    nLow: Math.max(1, Number(p[1]) || d.nLow),
  };
}

/** Bars before the first pivot can possibly exist on EITHER side: the larger
 * of the two confirm lags. deltaPct/deltaT need a SECOND same-side pivot, but
 * per the other specs' convention the floor tracks the first-possible-value
 * bar, not the strictest output. Every output shares it. */
export function pivotAnalysisWarmup(cfg: PivotAnalysisRefConfig): number {
  return Math.max(cfg.nHigh, cfg.nLow);
}
