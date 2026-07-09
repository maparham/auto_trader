// Sweep grid enumeration + chunked execution. One request per ~20 combos so
// no single call can hit a client/gateway timeout; progress and partial
// results come per chunk, cancel works between chunks, a failed chunk gets
// one retry. (Spec: docs/superpowers/specs/2026-07-09-strategy-panel-params-design.md)

import { runSweepChunk, type BacktestRequest, type SweepRow } from "../api";
import type { SweepRunState } from "./signals";

export interface SweepAxis {
  target: string;   // "param:<name>" | "risk:<side>.<stop|target>.<value|mult>"
  label: string;
  from: number;
  to: number;
  step: number;
}

export const SWEEP_MAX_COMBOS = 200;
export const SWEEP_CHUNK_SIZE = 20;

function axisValues(a: SweepAxis): number[] {
  if (!(a.step > 0) || a.to < a.from) return [];
  const out: number[] = [];
  // Epsilon guards float accumulation (1 + 0.1*n drift) at the inclusive end.
  for (let v = a.from; v <= a.to + a.step * 1e-9; v += a.step) {
    out.push(Number(v.toPrecision(12)));
  }
  return out;
}

export function comboCount(axes: SweepAxis[]): number {
  return axes.reduce((n, a) => {
    const len = axisValues(a).length;
    return len === 0 ? Infinity : n * len;
  }, axes.length ? 1 : 0);
}

export function enumerateCombos(axes: SweepAxis[]): Array<Record<string, number>> {
  let combos: Array<Record<string, number>> = [{}];
  for (const a of axes) {
    combos = axisValues(a).flatMap((v) =>
      combos.map((c) => ({ ...c, [a.target]: v })));
  }
  return axes.length ? combos : [];
}

export async function runSweep(
  baseReq: BacktestRequest,
  axes: SweepAxis[],
  opts: {
    onRows: (rows: SweepRow[], done: number, total: number) => void;
    signal?: AbortSignal;
  },
): Promise<SweepRow[]> {
  const combos = enumerateCombos(axes);
  const all: SweepRow[] = [];
  for (let i = 0; i < combos.length; i += SWEEP_CHUNK_SIZE) {
    if (opts.signal?.aborted) throw new Error("sweep aborted");
    const chunk = combos.slice(i, i + SWEEP_CHUNK_SIZE);
    let rows: SweepRow[];
    try {
      rows = await runSweepChunk(baseReq, chunk);
    } catch {
      // A cancel that lands while the chunk is in flight must not burn a
      // retry's worth of backend compute.
      if (opts.signal?.aborted) throw new Error("sweep aborted");
      rows = await runSweepChunk(baseReq, chunk);   // one retry, then throw
    }
    if (opts.signal?.aborted) throw new Error("sweep aborted");
    all.push(...rows);
    opts.onRows(rows, all.length, combos.length);
  }
  return all;
}

// Maps a caught runSweep rejection + the AbortController's signal back onto the
// next sweepStateSignal value. A user Cancel and a real failure both reject the
// same promise, so the signal (not the error's message/identity) is the source
// of truth for which happened — Cancel must never render as an error (see
// BacktestSettingsModal's red bt-param-error box). Checked before treating the
// rejection as a failure, so a cancel that races a chunk error still reads as
// a cancel.
export function sweepCatchState(
  prev: SweepRunState | null,
  aborted: boolean,
  err: unknown,
): SweepRunState {
  const rows = prev?.rows ?? [];
  const done = prev?.done ?? 0;
  const total = prev?.total ?? 0;
  if (aborted) {
    return { rows, done, total, running: false, cancelled: true };
  }
  return {
    rows,
    done,
    total,
    running: false,
    error: err instanceof Error ? err.message : "sweep failed",
  };
}
