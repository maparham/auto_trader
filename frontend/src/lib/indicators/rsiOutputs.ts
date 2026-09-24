// The RSI pane's divergence CONFIG and rule-operand shape, a leaf with no
// runtime imports so exprInstances.ts can read it without pulling klinecharts
// (rsi.ts is the chart-side module). Same split as ./spikeOutputs.
//
// Mirrors Python indicators/rsi.py (`parse_rsi_config` / `rsi_outputs` /
// `rsi_warmup`), which is what the backend validates a rule reference against.

// Divergence tuning, carried on extendData.divergence (set by the settings modal).
// Defaults mirror TradingView's "Divergence Indicator": pivot strength 5 each side,
// pivots 5–60 bars apart. Regular bull/bear on; hidden variants off; whole feature
// OFF until `on` is set.
export interface RsiDivergenceConfig {
  on: boolean;
  lookbackLeft: number; // pivot strength to the LEFT (bars before the pivot)
  lookbackRight: number; // pivot strength to the RIGHT (bars after; also the lag)
  rangeMin: number; // min bars between the two pivots
  rangeMax: number; // max bars between the two pivots
  pivotDepth: number; // how many earlier same-side pivots to try (1 = only the latest)
  bullish: boolean; // regular: price lower low + RSI higher low
  bearish: boolean; // regular: price higher high + RSI lower high
  hiddenBullish: boolean; // price higher low + RSI lower low
  hiddenBearish: boolean; // price lower high + RSI higher high
  showForming: boolean; // also mark the latest still-forming divergence
  formingLookbackRight: number; // right-side bars for a tentative (forming) pivot
  formingScanBack: boolean; // if the latest tail swing isn't diverging, scan older ones
}

export const RSI_DIVERGENCE_DEFAULTS: RsiDivergenceConfig = {
  on: false,
  lookbackLeft: 5,
  lookbackRight: 5,
  rangeMin: 5,
  rangeMax: 60,
  pivotDepth: 3,
  bullish: true,
  bearish: true,
  hiddenBullish: false,
  hiddenBearish: false,
  showForming: false,
  formingLookbackRight: 2,
  formingScanBack: false,
};

/** Rule operands, value line first. The divergence outputs are 0/1 events that
 * fire on the bar a divergence is CONFIRMED (right pivot + lookbackRight), each
 * kind detected whatever the pane's display toggles say. */
export const RSI_OUTPUTS = ["value", "bullDiv", "bearDiv", "hBullDiv", "hBearDiv"] as const;

export interface RsiRefConfig {
  length: number;
  lookbackLeft: number;
  lookbackRight: number;
  rangeMax: number;
}

/** The settings the warm-up reads, with detectDivergences' clamps. Mirrors
 * backend rsi.parse_rsi_config — keep in sync. */
export function parseRsiRefConfig(calcParams: unknown, extendData: unknown): RsiRefConfig {
  const p = Array.isArray(calcParams) ? calcParams : [];
  const ext = (extendData ?? {}) as { divergence?: Partial<RsiDivergenceConfig> };
  const d = { ...RSI_DIVERGENCE_DEFAULTS, ...(ext.divergence ?? {}) };
  const floorOr = (v: unknown, def: number) => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n !== 0 ? n : def;
  };
  const lo = Math.max(1, floorOr(d.rangeMin, 1));
  return {
    length: p.length ? Math.max(1, floorOr(p[0], 14)) : 14,
    lookbackLeft: Math.max(1, floorOr(d.lookbackLeft, 1)),
    lookbackRight: Math.max(1, floorOr(d.lookbackRight, 1)),
    rangeMax: Math.max(lo, floorOr(d.rangeMax, lo)),
  };
}

/** value: the RSI length. Divergences: length + rangeMax + both pivot windows.
 * 0 for an output the pane does not expose. Mirrors backend rsi_warmup. */
export function rsiWarmup(cfg: RsiRefConfig, output: string): number {
  if (output === "value") return cfg.length;
  if ((RSI_OUTPUTS as readonly string[]).includes(output))
    return cfg.length + cfg.rangeMax + cfg.lookbackLeft + cfg.lookbackRight;
  return 0;
}
