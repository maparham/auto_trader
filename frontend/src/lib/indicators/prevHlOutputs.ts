// The PREV_HL pane's rule/alert shape: output names, the config fields that
// change values, and the warm-up floor. A leaf with no runtime imports
// (prevHl.ts is the chart module). Mirrors Python indicators/prev_hl.py.
// lineHidden is display only and never read here: a hidden line is still a
// valid operand, it is just not drawn.
import type { PrevHlAgg, PrevHlRollingUnit } from "./prevHl"; // erased at build

export const PREV_HL_OUTPUTS = [
  "rollingHigh", "rollingLow", "dayHigh", "dayLow", "weekHigh", "weekLow", "anchorHigh", "anchorLow",
] as const;

export interface PrevHlRefConfig {
  lengths: { rolling: number; day: number; week: number };
  aggs: { rolling: PrevHlAgg; day: PrevHlAgg; week: PrevHlAgg };
  rollingUnit: PrevHlRollingUnit;
  gapMode: "trading" | "wallclock";
  anchorTs: number;
}

const AGGS: readonly string[] = ["extreme", "avg", "median"];
const UNITS: readonly string[] = ["bars", "minute", "hour", "day", "week"];

/** computePrevHl's fallbacks: length floor 1, agg "extreme", unit "hour",
 * gap mode "trading", anchor `Number || 0`. A non-numeric stored length is
 * `Math.floor(NaN)` on the chart (computePrevHl's `n`), which makes every
 * window computation it feeds into degenerate to no window at all; `0` here
 * is that same "no valid window" state (a real length always floors to >= 1,
 * so 0 is never ambiguous with one). Mirrors parse_prev_hl_config. */
export function parsePrevHlRefConfig(extendData: unknown): PrevHlRefConfig {
  const ext = (extendData && typeof extendData === "object" ? extendData : {}) as {
    lengths?: Record<string, unknown>; aggs?: Record<string, unknown>;
    rollingUnit?: unknown; gapMode?: unknown; anchorTs?: unknown;
  };
  const len = (k: string): number => {
    const v = Number(ext.lengths?.[k] ?? 1);
    return Number.isFinite(v) ? Math.max(1, Math.floor(v)) : 0;
  };
  const agg = (k: string): PrevHlAgg => {
    const v = ext.aggs?.[k];
    return (typeof v === "string" && AGGS.includes(v) ? v : "extreme") as PrevHlAgg;
  };
  return {
    lengths: { rolling: len("rolling"), day: len("day"), week: len("week") },
    aggs: { rolling: agg("rolling"), day: agg("day"), week: agg("week") },
    rollingUnit: (typeof ext.rollingUnit === "string" && UNITS.includes(ext.rollingUnit) ? ext.rollingUnit : "hour") as PrevHlRollingUnit,
    gapMode: ext.gapMode === "wallclock" ? "wallclock" : "trading",
    anchorTs: Math.trunc(Number(ext.anchorTs) || 0),
  };
}

/** A FLOOR, as for pivot bands: a bars-unit rolling window of n excludes the
 * current bar, so its first value is at index n and it needs n + 1 bars
 * (none when the length is 0, which never draws); time-unit rolling, day, week
 * and anchor depend on bar spacing and calendar gaps, so 0. Mirrors
 * prev_hl_warmup. */
export function prevHlWarmup(cfg: PrevHlRefConfig, output: string): number {
  if (!(PREV_HL_OUTPUTS as readonly string[]).includes(output)) return 0;
  const n = cfg.lengths.rolling;
  return output.startsWith("rolling") && cfg.rollingUnit === "bars" && n > 0 ? n + 1 : 0;
}
