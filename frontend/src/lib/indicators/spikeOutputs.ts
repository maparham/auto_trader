// The SPIKE pane's OUTPUT SHAPE and config parsing — split out of spike.ts as
// a leaf with no RUNTIME imports.
//
// Why its own module: spike.ts is the chart-side module (calc, klinecharts
// types), more than a pure caller needs — and importing it from
// exprInstances.ts pulls klinecharts into a node context that has no `window`.
// Keeping the output names, the config parser and the warm-up here as a leaf
// is what lets exprInstances.ts stay a pure, node-testable bridge. Same split,
// same reason, as ./srLevelsOutputs.
//
// Mirrors Python indicators/spike.py (`parse_spike_config` / `spike_outputs` /
// `spike_warmup`), which is what the backend validates a rule reference
// against.

/** The rule-operand names, in pane order — the SAME strings as the backend's
 * spike_outputs and the chart figure keys, so an operand a user inserts from
 * the legend and the series the backend computes can never drift apart.
 *
 * Fixed names, not lengths: the params reshape the SAME series rather than
 * selecting different ones, so retuning a pane keeps every rule that reads it
 * valid (unlike SLOPE, whose outputs ARE its MA lengths).
 *
 * `retracePct` is the CURRENT bar's dip, (spikeHigh - low) / height — large on
 * the spike bar itself (its low sits near the base); gate entries on
 * `consolOk` and `maxRetracePct` (deepest dip since the consolidation
 * latched), not on `retracePct` alone. */
export const SPIKE_OUTPUTS = [
  "spikeHigh",
  "spikeLow",
  "barsSinceSpike",
  "consolOk",
  "retracePct",
  "maxRetracePct",
] as const;

export type SpikeOutput = (typeof SPIKE_OUTPUTS)[number];

export interface SpikeConfig {
  spikeBars: number; // max spike-leg length: rise measured over this window
  minSpikePct: number; // min rise % from window low to current high
  flatBars: number; // consecutive in-band bars that latch consolOk
  maxFlatRangePct: number; // flat band depth, % of spike height
  // Pattern lifetime: barsSinceSpike reaching this expires the pattern back to
  // IDLE (same-bar re-arm allowed). Without it, an armed pattern that neither
  // breaks spikeLow nor makes a new high can sit for hundreds of bars, and —
  // because a higher high merely EXTENDS it — a later genuine spike inherits
  // the stale anchors instead of arming fresh.
  maxPatternBars: number;
  // Post-latch hard floor: a dip deeper than this percent of the spike's
  // height (from the high) invalidates the pattern — a retrace that deep no
  // longer reads as a high-probability continuation. Distinct from
  // maxFlatRangePct, which polices only the PRE-latch consolidation: tight
  // flag, deeper allowed dip.
  maxRetracePct: number;
}

export const SPIKE_DEFAULTS: SpikeConfig = {
  spikeBars: 5,
  minSpikePct: 2,
  flatBars: 5,
  maxFlatRangePct: 15,
  maxPatternBars: 60,
  maxRetracePct: 70,
};

/** calcParams order: [spikeBars, minSpikePct, flatBars, maxFlatRangePct,
 * maxPatternBars, maxRetracePct]. Lengths fall back on anything non-finite or falsy, percents
 * on anything non-finite or <= 0. Mirrored by backend
 * spike.parse_spike_config — keep in sync. */
export function parseSpikeConfig(calcParams: unknown): SpikeConfig {
  const p = Array.isArray(calcParams) ? calcParams : [];
  const d = SPIKE_DEFAULTS;
  const lenAt = (i: number, def: number): number => {
    const v = Number(p[i]);
    return Math.max(1, Math.floor(Number.isFinite(v) && v !== 0 ? v : def));
  };
  const pctAt = (i: number, def: number): number => {
    const v = Number(p[i]);
    return Number.isFinite(v) && v > 0 ? v : def;
  };
  return {
    spikeBars: lenAt(0, d.spikeBars),
    minSpikePct: pctAt(1, d.minSpikePct),
    flatBars: lenAt(2, d.flatBars),
    maxFlatRangePct: pctAt(3, d.maxFlatRangePct),
    maxPatternBars: lenAt(4, d.maxPatternBars),
    maxRetracePct: pctAt(5, d.maxRetracePct),
  };
}

/** Trailing spike window plus the pattern lifetime: the state at a bar can
 * depend on a pattern that armed up to maxPatternBars earlier, which itself
 * read its trailing spikeBars window. Chained void/re-arm phase offsets can in
 * principle reach further back, so this is the conservative convention, not a
 * hard guarantee — same caveat as the other specs. Every output shares it.
 * Mirrors backend spike_warmup. */
export function spikeWarmup(cfg: SpikeConfig): number {
  return cfg.spikeBars + cfg.maxPatternBars;
}
