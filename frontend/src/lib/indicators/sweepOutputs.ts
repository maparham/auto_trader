// The SWEEP pane's OUTPUT SHAPE, config parsing and warm-up: a leaf with no
// RUNTIME imports, so exprInstances.ts stays node-safe (same split, same
// reason, as ./spikeOutputs).
//
// Mirrors Python indicators/sweep.py (`parse_sweep_config` / `sweep_outputs`
// / `sweep_warmup`), which is what the backend validates a rule ref against.

/** Rule-operand names in pane order: the SAME strings as the backend's
 * SWEEP_OUTPUTS and the chart figure keys. Fixed names, so retuning a pane
 * keeps every rule that reads it valid. */
export const SWEEP_OUTPUTS = [
  "bearSweep",
  "bullSweep",
  "bearConfirmed",
  "bullConfirmed",
  "score",
  "sweptLevel",
  "barsSince",
  "bearReversal",
  "bullReversal",
] as const;

export type SweepOutput = (typeof SWEEP_OUTPUTS)[number];

export interface SweepConfig {
  pivotLeft: number;
  pivotRight: number;
  levelMaxAge: number; // bars a level stays live after its birth bar
  minWickPct: number; // swept-side wick, % of range, for full wick credit
  atrLen: number;
  minRangeAtr: number; // bar range in ATRs for full range credit
  volLen: number;
  volZ: number;
  minScore: number;
  confirmBars: number;
  usePrevDay: boolean;
  useVolume: boolean;
  usePrevBar: boolean;
  // Raw pane zone; computeSweep resolves "", "chart" or invalid to the chart zone.
  tz?: string;
}

export const SWEEP_DEFAULTS: SweepConfig = {
  pivotLeft: 5,
  pivotRight: 5,
  levelMaxAge: 150,
  minWickPct: 50,
  atrLen: 14,
  minRangeAtr: 1.5,
  volLen: 20,
  volZ: 2,
  minScore: 70,
  confirmBars: 3,
  usePrevDay: true,
  useVolume: false,
  usePrevBar: true,
};

/** calcParams order: [pivotLeft, pivotRight, levelMaxAge, minWickPct,
 * atrLen, minRangeAtr, volLen, volZ, minScore, confirmBars]. Lengths fall
 * back on anything non-finite or 0, positive reals on anything non-finite or
 * <= 0. extendData.usePrevBar: absent or anything but `false` means on.
 * Mirrored by backend sweep.parse_sweep_config; keep in sync. */
export function parseSweepConfig(calcParams: unknown, extendData?: unknown): SweepConfig {
  const p = Array.isArray(calcParams) ? calcParams : [];
  const ext = (extendData && typeof extendData === "object" ? extendData : {}) as Record<string, unknown>;
  const d = SWEEP_DEFAULTS;
  const lenAt = (i: number, def: number): number => {
    const v = Number(p[i]);
    return Math.max(1, Math.floor(Number.isFinite(v) && v !== 0 ? v : def));
  };
  const posAt = (i: number, def: number): number => {
    const v = Number(p[i]);
    return Number.isFinite(v) && v > 0 ? v : def;
  };
  return {
    pivotLeft: lenAt(0, d.pivotLeft),
    pivotRight: lenAt(1, d.pivotRight),
    levelMaxAge: lenAt(2, d.levelMaxAge),
    minWickPct: posAt(3, d.minWickPct),
    atrLen: lenAt(4, d.atrLen),
    minRangeAtr: posAt(5, d.minRangeAtr),
    volLen: lenAt(6, d.volLen),
    volZ: posAt(7, d.volZ),
    minScore: posAt(8, d.minScore),
    confirmBars: lenAt(9, d.confirmBars),
    usePrevDay: ext.usePrevDay !== false,
    useVolume: ext.useVolume === true,
    usePrevBar: ext.usePrevBar !== false,
    tz: typeof ext.tz === "string" ? ext.tz : undefined,
  };
}

/** ATR (read at i-1), the volume window (read before i), and a level's whole
 * life plus its pivot and confirm delay. Confirm outputs lag their flag by
 * confirmBars. Every output shares it. Mirrors backend sweep_warmup. */
export function sweepWarmup(cfg: SweepConfig): number {
  return Math.max(
    cfg.atrLen + 1,
    cfg.useVolume ? cfg.volLen + 1 : 0,
    cfg.levelMaxAge + cfg.pivotLeft + cfg.pivotRight + cfg.confirmBars,
  );
}
