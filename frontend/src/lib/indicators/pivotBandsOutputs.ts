// The PIVOT_BANDS pane's OUTPUT SHAPE and config parsing — split out of
// pivotBands.ts as a leaf with no RUNTIME imports.
//
// Why its own module: pivotBands.ts is the chart-side module (calc,
// klinecharts types, the MTF helpers), far more than a pure caller needs — and
// importing it from exprInstances.ts pulls klinecharts into a node context
// that has no `window`. Keeping the output names, the config parser and the
// warm-up here as a leaf is what lets exprInstances.ts stay a pure,
// node-testable bridge. Same split, same reason, as ./fvgOutputs.
//
// Mirrors Python indicators/pivot_bands.py (`parse_pivot_bands_config` /
// `pivot_bands_outputs` / `pivot_bands_warmup`), which is what the backend
// validates a rule reference against.

export type PivotBandsRefMode = "last" | "avg";

/** The rule-operand names, in pane order — the SAME strings as the backend's
 * pivot_bands_outputs and the chart figure keys, so an operand a user inserts
 * from the legend and the series the backend computes can never drift apart.
 *
 * barsSinceHigh/barsSinceLow count the bars since the most recent confirmed
 * pivot on that side, measured from the PIVOT BAR (so they never read below N,
 * the confirm lag — see pivotBarsSince.ts). They are the two curves of the
 * optional "Bars since pivot" companion pane, but they are NOT gated on that
 * pane's toggle: a display checkbox must never invalidate a saved rule. */
export const PIVOT_BANDS_OUTPUTS = [
  "pivotHigh",
  "pivotLow",
  "barsSinceHigh",
  "barsSinceLow",
] as const;

export type PivotBandsOutput = (typeof PIVOT_BANDS_OUTPUTS)[number];

export interface PivotBandsRefConfig {
  n: number; // fractal strength; confirm lag = this many bars
  k: number; // avg window (mode === "avg")
  mode: PivotBandsRefMode;
}

export const PIVOT_BANDS_REF_DEFAULTS: PivotBandsRefConfig = { n: 5, k: 3, mode: "last" };

/** calcParams order: [N (strength), K (avg window)]; mode on
 * extendData.mode. Mirrors PIVOT_BANDS_TEMPLATE.calc's own parsing
 * (Math.max(1, Number(x) || default), no floor) — matched by backend
 * parse_pivot_bands_config, which floors for Python's integer range(). */
export function parsePivotBandsRefConfig(
  calcParams: unknown,
  extendData: unknown,
): PivotBandsRefConfig {
  const p = Array.isArray(calcParams) ? calcParams : [];
  const d = PIVOT_BANDS_REF_DEFAULTS;
  const mode: PivotBandsRefMode =
    extendData && typeof extendData === "object" && (extendData as { mode?: unknown }).mode === "avg"
      ? "avg"
      : "last";
  return {
    n: Math.max(1, Number(p[0]) || d.n),
    k: Math.max(1, Number(p[1]) || d.k),
    mode,
  };
}

/** Bars before the first pivot can possibly exist: the confirm lag N. Values
 * keep stepping after that, so this is the floor — the same convention as the
 * other specs. Every output shares it (barsSince* first exist on that same
 * confirmation bar, where they read exactly N). */
export function pivotBandsWarmup(cfg: PivotBandsRefConfig): number {
  return cfg.n;
}
