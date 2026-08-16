// The FVG pane's OUTPUT SHAPE and config parsing — split out of fvg.ts as a leaf
// with no RUNTIME imports.
//
// Why its own module: fvg.ts is the chart-side module (draw/calc, klinecharts
// types, the ATR/MTF helpers), far more than a pure caller needs — and importing
// it from exprInstances.ts pulls klinecharts into a node context that has no
// `window`. Keeping the output names, the config parser and the warm-up here as
// a leaf is what lets exprInstances.ts stay a pure, node-testable bridge. fvg.ts
// re-exports every name below, so its own importers are unaffected. Same split,
// same reason, as ./slopeOutputs.
//
// Mirrors Python indicators/fvg.py (`parse_fvg_config` / `fvg_outputs` /
// `fvg_warmup`), which is what the backend validates a rule reference against.

export const FVG_ATR_LEN = 14;

/** The rule-operand names, in pane order — the SAME strings as the backend's
 * fvg_outputs and the chart figure keys, so an operand a user inserts from the
 * legend and the series the backend computes can never drift apart. */
export const FVG_OUTPUTS = ["bull_top", "bull_bottom", "bear_top", "bear_bottom"] as const;

export type FvgOutput = (typeof FVG_OUTPUTS)[number];

export interface FvgConfig {
  minSize: number; // minimum gap height as a multiple of ATR(14); 0 = no filter
  maxBars: number; // a gap expires this many bars after it confirmed
  maxGaps: number; // newest gaps kept live PER SIDE
}

export const FVG_DEFAULTS: FvgConfig = {
  minSize: 0.25,
  maxBars: 500,
  maxGaps: 10,
};

/** calcParams order: [minSize, maxBars, maxGaps]. Mirrored by backend
 * fvg.parse_fvg_config — keep in sync.
 *
 * minSize takes ZERO (the documented "filter off" value), so it validates on
 * `>= 0` while the two count params keep the usual `> 0` rule. Getting this
 * wrong silently restores the default filter, so both runtimes test it. */
export function parseFvgConfig(calcParams: unknown): FvgConfig {
  const p = Array.isArray(calcParams) ? calcParams : [];
  const d = FVG_DEFAULTS;
  const numAt = (i: number, def: number, allowZero: boolean): number => {
    const v = Number(p[i]);
    return Number.isFinite(v) && (allowZero ? v >= 0 : v > 0) ? v : def;
  };
  return {
    minSize: numAt(0, d.minSize, true),
    maxBars: Math.max(1, Math.floor(numAt(1, d.maxBars, false))),
    maxGaps: Math.max(1, Math.floor(numAt(2, d.maxGaps, false))),
  };
}

/** Bars before the first gap can possibly exist: ATR(14) warm-up plus the two
 * bars the 3-candle pattern spans. Gaps keep forming after that, so this is the
 * floor — the same convention as the other specs. Every output shares it. */
export function fvgWarmup(): number {
  return FVG_ATR_LEN + 2;
}
