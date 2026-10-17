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

const SOURCES: readonly string[] = ["close", "open", "high", "low", "hl2", "hlc3", "ohlc4", "hlcc4"];

/** Mirrors Python's `_num`: null, a boolean, or anything that doesn't coerce
 * to a finite number is "not a usable mult", not a real 0 or 1. Plain
 * `Number(v)` disagrees here (`Number(null) === 0`, `Number(true) === 1`),
 * which is exactly the parity bug Ruling F3 pins down. */
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || typeof v === "boolean") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** An AVWAP pane as AVWAP_TEMPLATE.calc reads it: anchor (epoch ms) in
 * calcParams[0] (`Number || 0`; <= 0 means unplaced), source / bandMode /
 * bands on extendData. lineHidden and slopeColor are display only.
 * Mirrors parse_avwap_config. */
export function parseAvwapRefConfig(calcParams: unknown, extendData: unknown): VwapRefConfig {
  const p = Array.isArray(calcParams) ? calcParams : [];
  const ext = (extendData && typeof extendData === "object" ? extendData : {}) as {
    source?: unknown; bandMode?: unknown; bands?: unknown;
  };
  const source = (typeof ext.source === "string" && SOURCES.includes(ext.source) ? ext.source : "hlc3") as PriceSource;
  const bandMode = ext.bandMode === "percentage" ? "percentage" : "stdev";
  // vwapFrom loops b = 0..2 over `ext.bands ?? defaults` and skips
  // `!bands[b]?.on`: any length is accepted, a missing index is off, `on` is
  // truthy. Defaults only when bands is absent or not an array. An off band
  // (or one whose mult is null, a boolean, or otherwise not a finite number)
  // is stored canonically as off with its default mult, so avwapOutputs
  // always agrees with the Python side's avwap_outputs and avwap_pane_series
  // can never be asked for an output this function didn't also list.
  const raw = Array.isArray(ext.bands) ? (ext.bands as unknown[]) : null;
  const bands = VWAP_DEFAULT_BANDS.map((d, i) => {
    if (!raw) return { ...d };
    const b = raw[i] as { on?: unknown; mult?: unknown } | null | undefined;
    const mult = numOrNull(b?.mult);
    return b?.on && mult !== null ? { on: true, mult } : { on: false, mult: d.mult };
  });
  return { source, bandMode, bands, anchorMs: Math.trunc(Number(p[0]) || 0) };
}

/** `vwap` plus up<k>/dn<k> for every enabled band. Mirrors avwap_outputs. */
export function avwapOutputs(cfg: VwapRefConfig): string[] {
  const out = ["vwap"];
  cfg.bands.forEach((b, i) => {
    if (b.on) out.push(`up${i + 1}`, `dn${i + 1}`);
  });
  return out;
}
