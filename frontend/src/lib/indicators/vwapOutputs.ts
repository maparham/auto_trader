// The VWAP / AVWAP panes' rule and alert shape, a leaf with no runtime imports
// (vwap.ts is the chart module). The values come from vwap.ts vwapFrom on the
// chart and from Python indicators/vwap.py vwap_from on the backend; the
// parity fixtures pin the two. Plain VWAP accumulates from the first bar it is
// given and its template passes only slopeColor to vwapFrom, so its settings
// are fixed: hlc3, stdev bands, band 1 on (and only `vwap` is drawn).
import type { PriceSource } from "../mtf"; // erased at build

export const VWAP_OUTPUTS = ["vwap"] as const;

/** Copy of vwap.ts AVWAP_DEFAULT_BANDS (vwapParity.test.ts asserts they match). */
export const VWAP_DEFAULT_BANDS: ReadonlyArray<{ on: boolean; mult: number }> = [
  { on: true, mult: 1 },
  { on: false, mult: 2 },
  { on: false, mult: 3 },
];

export interface VwapRefConfig {
  source: PriceSource;
  bandMode: "stdev" | "percentage";
  bands: Array<{ on: boolean; mult: number }>;
  anchorMs: number; // 0 for plain VWAP: accumulate from the first bar
}

/** Plain VWAP: what VWAP_TEMPLATE.calc hands vwapFrom, ignoring whatever
 * `extendData` says (the template passes only slopeColor, display only).
 * Takes the argument so a test can prove the ignoring, not just assert it.
 * Mirrors parse_vwap_config, which takes and ignores the same two arguments. */
export function parseVwapRefConfig(extendData?: unknown): VwapRefConfig {
  void extendData;
  return { source: "hlc3", bandMode: "stdev", bands: VWAP_DEFAULT_BANDS.map((b) => ({ ...b })), anchorMs: 0 };
}

/** VWAP is blank until cumulative volume is positive: a volume condition, not
 * a bar count, so the warm-up floor is 0. Mirrors vwap_warmup. */
export function vwapWarmup(output: string): number {
  void output;
  return 0;
}
