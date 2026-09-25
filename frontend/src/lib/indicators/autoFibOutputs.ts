// The AUTO_FIB pane's config parsing, output names, warm-up and level price,
// split out of autoFib.ts as a leaf with no RUNTIME klinecharts import.
//
// Same split, same reason, as ./srLevelsOutputs: exprInstances.ts reads these
// from a node context, and autoFib.ts imports them back so the chart and the
// expression layer share one parser.
//
// Mirrors Python indicators/auto_fib.py (parse_auto_fib_config /
// fib_output_name / auto_fib_outputs / auto_fib_warmup / fib_level_price).
import { asFibConfig, defaultFibConfig, type FibConfig } from "../fibConfig";

/** ATR length the swing filter is measured in (backend AUTO_FIB_ATR_LEN). */
export const AUTO_FIB_ATR_LEN = 14;
/** Most past fibs a pane draws. MTF calc snaps this many plus the current. */
export const AUTO_FIB_MAX_PAST = 10;

export const AUTO_FIB_BASE_OUTPUTS = ["high", "low", "dir"] as const;

export interface AutoFibConfig {
  pivotLen: number; // fractal lookback each side; a pivot confirms this many bars late
  minSwingAtr: number; // 0 = off; else the leg must be >= this x ATR(14)
}

export const AUTO_FIB_DEFAULTS: AutoFibConfig = { pivotLen: 5, minSwingAtr: 0 };

/** calcParams order: [pivotLen, minSwingAtr]. Mirrored by backend
 * auto_fib.parse_auto_fib_config; keep in sync. */
export function parseAutoFibConfig(calcParams: unknown): AutoFibConfig {
  const p = Array.isArray(calcParams) ? calcParams : [];
  const len = Number(p[0]);
  const swing = Number(p[1]);
  return {
    pivotLen:
      Number.isFinite(len) && len > 0 ? Math.max(1, Math.floor(len)) : AUTO_FIB_DEFAULTS.pivotLen,
    minSwingAtr: Number.isFinite(swing) && swing >= 0 ? swing : AUTO_FIB_DEFAULTS.minSwingAtr,
  };
}

/** The pane's fib config: extendData.fib when present, else the drawing
 * tool's defaults extended right, so a fresh pane reaches the last bar. A null
 * fib counts as absent: Cancel nulls the key to remove an edit (a merge cannot
 * delete it), and the Python side reads any non-dict fib as the defaults too. */
export function autoFibFibConfig(extendData: unknown): FibConfig {
  const fib =
    extendData && typeof extendData === "object"
      ? (extendData as { fib?: unknown }).fib
      : undefined;
  return fib == null ? { ...defaultFibConfig(), extend: "right" } : asFibConfig(fib);
}

/** Rule-operand name for a level ratio, or null when it gets none.
 * toFixed rounds ties to the larger magnitude, which the backend matches with
 * ROUND_HALF_UP on the exact binary value. */
export function fibOutputName(value: number): string | null {
  if (!Number.isFinite(value) || Math.abs(value) >= 1e6) return null;
  let digits = Math.abs(value).toFixed(4);
  if (digits.includes(".")) digits = digits.replace(/0+$/, "").replace(/\.$/, "");
  return `f${value < 0 ? "m" : ""}${digits.replace(".", "_")}`;
}

export interface AutoFibLevelOutput {
  name: string;
  value: number;
}

/** One operand per ENABLED level, in level order; a duplicate name keeps the
 * first level that produced it. */
export function autoFibLevelOutputs(fib: FibConfig): AutoFibLevelOutput[] {
  const out: AutoFibLevelOutput[] = [];
  const seen = new Set<string>();
  for (const l of fib.levels) {
    if (!l.enabled) continue;
    const name = fibOutputName(l.value);
    if (name === null || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, value: l.value });
  }
  return out;
}

/** Every operand the pane exposes with its CURRENT levels. */
export function autoFibOutputs(extendData: unknown): string[] {
  return [
    ...AUTO_FIB_BASE_OUTPUTS,
    ...autoFibLevelOutputs(autoFibFibConfig(extendData)).map((l) => l.name),
  ];
}

/** Bars before the first pair can exist: ATR(14) warm-up plus one full pivot
 * window. Mirrors backend auto_fib_warmup. */
export function autoFibWarmup(cfg: AutoFibConfig): number {
  return AUTO_FIB_ATR_LEN + 2 * cfg.pivotLen;
}

/** Price of ratio r on the pair. Level 0 sits on the LATER anchor (the high
 * when dir is +1), level 1 on the earlier one; reverse swaps them, the same
 * convention as the fib drawing tool. Mirrors auto_fib.fib_level_price. */
export function fibLevelPrice(
  hi: number,
  lo: number,
  dir: number,
  reverse: boolean,
  r: number,
): number {
  const later = dir > 0 ? hi : lo;
  const earlier = dir > 0 ? lo : hi;
  const p0 = reverse ? earlier : later;
  const p1 = reverse ? later : earlier;
  return p0 + (p1 - p0) * r;
}
