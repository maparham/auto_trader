// The SR_LEVELS pane's OUTPUT SHAPE and config parsing — split out of
// srLevels.ts as a leaf with no RUNTIME imports.
//
// Why its own module: srLevels.ts is the chart-side module (calc, draw,
// klinecharts types, the MTF stash), far more than a pure caller needs — and
// importing it from exprInstances.ts pulls klinecharts into a node context
// that has no `window`. Keeping the output names, the config parser and the
// warm-up here as a leaf is what lets exprInstances.ts stay a pure,
// node-testable bridge. Same split, same reason, as ./trendlinesOutputs — and
// like it, srLevels.ts imports the parser back rather than keeping a second
// copy, so the chart and the expression layer read one set of params.
//
// Mirrors Python indicators/sr_levels.py (`parse_sr_config` / `sr_outputs` /
// `sr_warmup`), which is what the backend validates a rule reference against.

/** ATR length the cluster tolerance is measured in — fixed, not a param
 * (backend SR_ATR_LEN). */
export const SR_ATR_LEN = 14;

/** The rule-operand names, in pane order — the SAME strings as the backend's
 * sr_outputs and the chart figure keys, so an operand a user inserts from the
 * legend and the series the backend computes can never drift apart.
 *
 * Fixed names, not lengths: the params reshape the SAME two series rather than
 * selecting different ones, so retuning a pane keeps every rule that reads it
 * valid (unlike SLOPE, whose outputs ARE its MA lengths). */
export const SR_LEVELS_OUTPUTS = ["support", "resistance"] as const;

export type SrLevelsOutput = (typeof SR_LEVELS_OUTPUTS)[number];

export interface SrLevelsConfig {
  pivotLen: number; // fractal lookback each side (N); confirm lag = N bars
  atrMult: number; // cluster tolerance = ATR(14) × this
  minTouches: number; // pivots needed before a level counts as major
  maxLevels: number; // strongest levels kept live
  maxBars: number; // a level goes stale maxBars after its last touch
}

export const SR_LEVELS_DEFAULTS: SrLevelsConfig = {
  pivotLen: 15,
  atrMult: 0.5,
  minTouches: 2,
  maxLevels: 8,
  maxBars: 500,
};

/** calcParams order: [pivotLen, atrMult, minTouches, maxLevels, maxBars].
 * Mirrored by backend sr_levels.parse_sr_config — keep in sync. */
export function parseSrConfig(calcParams: unknown): SrLevelsConfig {
  const p = Array.isArray(calcParams) ? calcParams : [];
  const d = SR_LEVELS_DEFAULTS;
  const numAt = (i: number, def: number): number => {
    const v = Number(p[i]);
    return Number.isFinite(v) && v > 0 ? v : def;
  };
  return {
    pivotLen: Math.max(1, Math.floor(numAt(0, d.pivotLen))),
    atrMult: numAt(1, d.atrMult),
    minTouches: Math.max(1, Math.floor(numAt(2, d.minTouches))),
    maxLevels: Math.max(1, Math.floor(numAt(3, d.maxLevels))),
    maxBars: Math.max(1, Math.floor(numAt(4, d.maxBars))),
  };
}

/** Bars before the first level can possibly exist: ATR(14)'s warm-up plus one
 * full pivot window (the extreme's own lookback plus the confirm lag), since a
 * pivot confirming before ATR is warm is skipped outright. Levels keep
 * accumulating touches after that, so this is the floor — the same convention
 * as the other specs. Mirrors backend sr_warmup; deliberately NOT
 * mtfCoordinator's srWarmup, whose `+ maxBars` is HTF fetch depth for DRAWING
 * levels, not the bars an operand needs to be honest. */
export function srLevelsWarmup(cfg: SrLevelsConfig): number {
  return SR_ATR_LEN + 2 * cfg.pivotLen;
}
