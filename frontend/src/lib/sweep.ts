// Sweep grid enumeration + chunked execution. One request per ~20 combos so
// no single call can hit a client/gateway timeout; progress and partial
// results come per chunk, cancel works between chunks, a failed chunk gets
// one retry. (Spec: docs/superpowers/specs/2026-07-09-strategy-panel-params-design.md)

import { runSweepChunk, type BacktestRequest, type SweepRow } from "../api";
import { formatPeriodDateRange } from "./backtestPeriods";
import type { SweepRunState } from "./signals";

// One sweep option of a discrete-list axis: `patch` is spread verbatim into
// every combo this option participates in (may write several keys at once,
// e.g. a period writes period:from + period:to).
export interface SweepOption {
  label: string;
  patch: Record<string, number | string>;
}

// Numeric range axis (the original kind). Targets:
// "param:<name>" | "risk:<side>.<stop|target>.<value|mult>" |
// "rule:<side>.<entry|exit>.<idx>.<left|right>.<length|value>" |
// "rule:<side>.<entry|exit>.<idx>.count"
export interface RangeAxis {
  kind: "range";
  target: string;
  // Synced-risk sweeps ("Same for long & short" on): the opposite side's
  // target, written with the same value into every combo so both legs move
  // together through the sweep. Attached by mirrorRiskAxes right before the
  // run; never persisted with the axis while editing.
  mirrorTarget?: string;
  label: string;
  from: number;
  to: number;
  step: number;
}

// Discrete-list axis. Targets: "op:<side>.<entry|exit>.<idx>" (operator per
// rule term) | "timeWindow" (intraday window; patch keys timeWindow:startMin/
// endMin/tz) | "period" (after materialization; patch keys period:from/to,
// unix seconds).
export interface ListAxis {
  kind: "list";
  target: string;
  label: string;
  options: SweepOption[];
}

// Walk-forward period axis while EDITING: just the window count. Materialized
// into a ListAxis (n equal contiguous windows over the resolved range) by
// materializePeriodAxes right before the run; enumerateCombos refuses it raw.
export interface PeriodAxis {
  kind: "period";
  target: string;
  label: string;
  n: number;
}

export type SweepAxis = RangeAxis | ListAxis | PeriodAxis;
export type SweepCombo = Record<string, number | string>;

export const SWEEP_MAX_COMBOS = 1000;
export const SWEEP_CHUNK_SIZE = 20;

/** Builds a `rule:` sweep-axis target path for a rule operand's numeric field
 * (`length` on an indicator, `value` on a const) — `ruleAxisTarget("long",
 * "entry", 0, "left.length")` → `"rule:long.entry.0.left.length"`. Also used
 * for an exit rule's own `count` field, which has no operand side: pass
 * `"count"` as the leaf. Must match the backend's rule-sweep target grammar —
 * keep in sync with the doc-comment on SweepAxis.target above. */
export function ruleAxisTarget(
  side: "long" | "short",
  group: "entry" | "exit",
  idx: number,
  leaf: "left.length" | "right.length" | "left.value" | "right.value" | "count",
): string {
  return `rule:${side}.${group}.${idx}.${leaf}`;
}

/** Builds an `op:` sweep-axis target for a rule's operator. `idx` is the rule's
 * position in the ENABLED-only list (same convention as ruleAxisTarget). */
export function opAxisTarget(side: "long" | "short", group: "entry" | "exit", idx: number): string {
  return `op:${side}.${group}.${idx}`;
}

/** When the SL/TP sync is on, risk axes are canonicalized to the long side at
 * toggle time (RiskSection) — this stamps each with the short-side mirror so
 * enumerateCombos sweeps both legs in lockstep. Non-risk axes pass through. */
export function mirrorRiskAxes(axes: SweepAxis[]): SweepAxis[] {
  return axes.map((a) =>
    a.kind === "range" && a.target.startsWith("risk:long.")
      ? { ...a, mirrorTarget: a.target.replace(/^risk:long\./, "risk:short.") }
      : a);
}

function axisValues(a: RangeAxis): number[] {
  // Endpoints and step may be negative (e.g. sweeping a slope threshold below
  // zero). Walk from→to in whichever direction they point, using the step's
  // magnitude, so a descending range (0 → -1) enumerates instead of returning [].
  const step = Math.abs(a.step);
  if (!(step > 0)) return [];
  const out: number[] = [];
  const dir = a.to >= a.from ? 1 : -1;
  const eps = step * 1e-9;
  // Epsilon guards float accumulation (from + step*n drift) at the inclusive end.
  for (let v = a.from; dir > 0 ? v <= a.to + eps : v >= a.to - eps; v += dir * step) {
    out.push(Number(v.toPrecision(12)));
  }
  return out;
}

export function comboCount(axes: SweepAxis[]): number {
  return axes.reduce((n, a) => {
    const len = a.kind === "range" ? axisValues(a).length
      : a.kind === "list" ? a.options.length
      : a.n;
    return len === 0 ? Infinity : n * len;
  }, axes.length ? 1 : 0);
}

export function enumerateCombos(axes: SweepAxis[]): SweepCombo[] {
  let combos: SweepCombo[] = [{}];
  for (const a of axes) {
    if (a.kind === "period") throw new Error("period axis must be materialized before enumerating");
    combos = a.kind === "list"
      ? a.options.flatMap((o) => combos.map((c) => ({ ...c, ...o.patch })))
      : axisValues(a).flatMap((v) =>
          combos.map((c) =>
            a.mirrorTarget ? { ...c, [a.target]: v, [a.mirrorTarget]: v } : { ...c, [a.target]: v }));
  }
  return axes.length ? combos : [];
}

/** Replace each period axis with a list axis of n equal, contiguous,
 * non-overlapping windows over [fromMs, toMs]. Patch values are unix SECONDS
 * (the backend's candle time unit). Called right before a run so the windows
 * always reflect the range as currently configured. */
export function materializePeriodAxes(axes: SweepAxis[], fromMs: number, toMs: number): SweepAxis[] {
  return axes.map((a) => {
    if (a.kind !== "period") return a;
    const n = Math.max(1, Math.round(a.n));
    const options: SweepOption[] = [];
    for (let i = 0; i < n; i++) {
      const wFrom = fromMs + ((toMs - fromMs) * i) / n;
      const wTo = fromMs + ((toMs - fromMs) * (i + 1)) / n;
      options.push({
        label: `W${i + 1}: ${formatPeriodDateRange(wFrom, wTo)}`,
        patch: { "period:from": Math.round(wFrom / 1000), "period:to": Math.round(wTo / 1000) },
      });
    }
    return { kind: "list", target: a.target, label: a.label, options };
  });
}

/** The list-axis option a result row's combo came from: the option whose every
 * patch entry matches the combo. Null for range/period axes or no match. */
export function axisOptionFor(axis: SweepAxis, combo: SweepCombo): SweepOption | null {
  if (axis.kind !== "list") return null;
  return axis.options.find((o) => Object.entries(o.patch).every(([k, v]) => combo[k] === v)) ?? null;
}

/** Display text for one axis of a combo: the option label for a list axis,
 * the raw value for a range axis. */
export function comboAxisText(axis: SweepAxis, combo: SweepCombo): string {
  if (axis.kind === "list") return axisOptionFor(axis, combo)?.label ?? "?";
  return String(combo[axis.target] ?? "?");
}

export async function runSweep(
  baseReq: BacktestRequest,
  axes: SweepAxis[],
  opts: {
    onRows: (rows: SweepRow[], done: number, total: number) => void;
    signal?: AbortSignal;
  },
): Promise<SweepRow[]> {
  const combos: SweepCombo[] = enumerateCombos(axes);
  const all: SweepRow[] = [];
  for (let i = 0; i < combos.length; i += SWEEP_CHUNK_SIZE) {
    if (opts.signal?.aborted) throw new Error("sweep aborted");
    const chunk = combos.slice(i, i + SWEEP_CHUNK_SIZE);
    // `i` combos are already done when this chunk starts; the backend logs the
    // chunk's position as `i+1..i+len of total`.
    const progress = { done: i, total: combos.length };
    let rows: SweepRow[];
    try {
      rows = await runSweepChunk(baseReq, chunk, progress);
    } catch {
      // A cancel that lands while the chunk is in flight must not burn a
      // retry's worth of backend compute.
      if (opts.signal?.aborted) throw new Error("sweep aborted");
      rows = await runSweepChunk(baseReq, chunk, progress);   // one retry, then throw
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
