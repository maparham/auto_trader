// Sweep grid enumeration + job-driven execution. The whole grid is submitted as
// one backend job; runSweep then polls for completed rows every 700ms, streams
// them out as they land, and cancels the job on abort.
// (Spec: docs/superpowers/specs/2026-07-09-strategy-panel-params-design.md)

import {
  cancelSweepJob,
  pollSweepJob,
  submitSweepJob,
  type BacktestRequest,
  type SweepJobStatus,
  type SweepRow,
  type SweepTarget,
} from "../api";
import { formatPeriodDateRange } from "./backtestPeriods";
import { clearSweepJob, rememberSweepJob } from "./sweepResume";
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

// Above this combo count we warn (a big grid is slow, not forbidden). Not a cap:
// the runner enumerates and submits any size the user confirms past the warning.
export const SWEEP_WARN_COMBOS = 1000;

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

export function axisValues(a: RangeAxis): number[] {
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

/** Sub-window robustness bounds over the resolved range: ascending epoch
 * SECONDS, N+1 boundaries for N equal contiguous windows. Auto N picks the
 * largest calendar-ish unit (month/week/day) that yields at least 3 windows,
 * clamped to 3..30; an explicit override is clamped to 2..50. Sent with every
 * sweep chunk so the backend slices each combo's run identically. */
export function robustWindowBounds(fromMs: number, toMs: number, overrideN?: number): number[] {
  const DAY = 86_400_000;
  const rangeDays = (toMs - fromMs) / DAY;
  let n: number;
  if (overrideN !== undefined && Number.isFinite(overrideN)) {
    n = Math.max(2, Math.min(50, Math.round(overrideN)));
  } else {
    const unitDays = [30, 7, 1].find((u) => rangeDays / u >= 3) ?? 1;
    n = Math.max(3, Math.min(30, Math.round(rangeDays / unitDays)));
  }
  const bounds: number[] = [];
  for (let i = 0; i <= n; i++) {
    bounds.push(Math.round((fromMs + ((toMs - fromMs) * i) / n) / 1000));
  }
  return bounds;
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

/** Label + value for one axis of a combo, for results rows. A rule VALUE
 * axis's label carries an "x" placeholder for the swept slot ("EMA 9 > x",
 * from sweepLabels); with the row's value known, substitute it ("EMA 9 > 0")
 * instead of appending ("EMA 9 > x 0"). Every other axis appends. */
export function comboAxisLabel(axis: SweepAxis, combo: SweepCombo): string {
  const text = comboAxisText(axis, combo);
  if (/^rule:.+\.(left|right)\.value$/.test(axis.target)) {
    const substituted = axis.label.replace(/\bx\b/, text);
    if (substituted !== axis.label) return substituted;
  }
  return `${axis.label} ${text}`;
}

/** Column header for a per-axis results column: the axis label with the swept-
 * value placeholder removed. A rule VALUE axis's label carries an "x" slot for
 * the swept number ("EMA 9 > x"); in a per-axis column that number lives in the
 * cell, so the header drops the "x" ("EMA 9 >"). Every other axis kind keeps its
 * label verbatim (the value simply reads under it). */
export function axisColumnLabel(axis: SweepAxis): string {
  if (/^rule:.+\.(left|right)\.value$/.test(axis.target)) {
    return axis.label.replace(/\s*\bx\b\s*/, " ").trim() || axis.label;
  }
  return axis.label;
}

// The most recently submitted sweep job (id + where it runs), so a later
// re-attach hook (Task 7) can reconnect to a run in flight. Set right after
// submit; null before the first sweep of the session.
let lastJob: { jobId: string; target: SweepTarget } | null = null;
export function getLastSweepJob(): { jobId: string; target: SweepTarget } | null {
  return lastJob;
}

// How often runSweep polls the job for newly completed rows.
const SWEEP_POLL_MS = 700;

/** A cancellable sleep: resolves after `ms`, or immediately if `signal` aborts
 * (clearing the timer so no pending timeout leaks on the abort path). */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// Poll a submitted job every SWEEP_POLL_MS, streaming newly-completed rows out
// through onRows and resolving the full set when the job ends. Shared by runSweep
// (right after submit) and resumeSweep (re-attach on reload). On abort it always
// stops polling and throws "sweep aborted"; it kills the SERVER job only when
// shouldCancelServer() is true: a detached modal-close leaves the job running so
// a later reload can re-attach (default true preserves the plain-cancel behavior).
export async function pollToCompletion(
  jobId: string,
  target: SweepTarget,
  opts: {
    onRows: (rows: SweepRow[], done: number, total: number) => void;
    signal?: AbortSignal;
    shouldCancelServer?: () => boolean;
  },
): Promise<SweepRow[]> {
  const shouldCancelServer = opts.shouldCancelServer ?? (() => true);
  const all: SweepRow[] = [];
  // A single transient poll rejection (e.g. a proxy 502 during a Fly hiccup)
  // must NOT tear the run down: the server job keeps running. Tolerate up to 5
  // CONSECUTIVE failures, sleeping the normal interval between attempts and
  // resetting the counter on any success; only a sustained outage propagates.
  let consecutiveFailures = 0;
  for (;;) {
    await sleep(SWEEP_POLL_MS, opts.signal);
    if (opts.signal?.aborted) {
      if (shouldCancelServer()) cancelSweepJob(jobId, target).catch(() => {});
      throw new Error("sweep aborted");
    }
    let status: SweepJobStatus;
    try {
      status = await pollSweepJob(jobId, all.length, target);
    } catch (e) {
      // Abort during a retry gap behaves exactly like abort during polling:
      // the top-of-loop sleep resolves instantly on an aborted signal, and the
      // abort check above then throws "sweep aborted" on the next iteration.
      if (++consecutiveFailures >= 5) throw e;
      continue;
    }
    consecutiveFailures = 0;
    all.push(...status.rows);
    if (status.rows.length) opts.onRows(status.rows, all.length, status.total);
    if (!status.running) {
      if (status.cancelled) throw new Error("sweep aborted");
      if (status.error) {
        // Tag a backend-reported failure so the callers' catch paths can tell it
        // apart from a transport-exhausted rejection: the former is terminal (the
        // server job failed), the latter leaves the job running for a re-attach.
        const e = new Error(status.error);
        (e as Error & { backendReported?: boolean }).backendReported = true;
        throw e;
      }
      return all;
    }
  }
}

export async function runSweep(
  baseReq: BacktestRequest,
  axes: SweepAxis[],
  opts: {
    onRows: (rows: SweepRow[], done: number, total: number) => void;
    signal?: AbortSignal;
    // Sub-window robustness bounds (epoch seconds, ascending); forwarded to the
    // job so every combo's run slices the same windows.
    windows?: number[];
    // Where the sweep runs; defaults to the local backend.
    target?: SweepTarget;
    // Whether an abort should kill the server job (Cancel) or leave it running
    // for a reload to re-attach (modal close / detach). Defaults to true.
    shouldCancelServer?: () => boolean;
    // An explicit combo set to submit instead of enumerating the full grid
    // (random search samples a subset of the grid up front). When present it is
    // submitted verbatim; the axes still ride along for results labelling.
    combosOverride?: SweepCombo[];
  },
): Promise<SweepRow[]> {
  const target: SweepTarget = opts.target ?? "local";
  if (opts.signal?.aborted) throw new Error("sweep aborted");

  const combos: SweepCombo[] = opts.combosOverride ?? enumerateCombos(axes);
  const { jobId } = await submitSweepJob(baseReq, combos, opts.windows, target);
  lastJob = { jobId, target };
  const shouldCancelServer = opts.shouldCancelServer ?? (() => true);
  // Remember the job so a reload can re-attach to it (see sweepResume). The
  // archive metadata rides along so a sweep that completes on a re-attach gets
  // archived just like a live-run completion (BacktestButton archives that path).
  rememberSweepJob(jobId, target, {
    epic: baseReq.epic,
    timeframe: baseReq.resolution,
    axes,
    windows: opts.windows ?? null,
  });

  try {
    const rows = await pollToCompletion(jobId, target, {
      onRows: opts.onRows,
      signal: opts.signal,
      shouldCancelServer,
    });
    clearSweepJob();
    return rows;
  } catch (e) {
    // Keep the re-attach memo only when the job could still be picked up by a
    // reload; clear it on every terminal end.
    //  - detach abort (modal closed, shouldCancelServer false): job keeps
    //    running server-side -> KEEP.
    //  - transport-exhausted rejection (5 consecutive poll failures, NOT an
    //    abort and NOT backend-reported): job likely still running with no
    //    consumer -> KEEP so a reload re-attaches.
    //  - clean finish (returned above), explicit/backend cancel ("sweep
    //    aborted"), backend-reported error -> CLEAR.
    const aborted = e instanceof Error && e.message === "sweep aborted";
    const detached = aborted && !!opts.signal?.aborted && !shouldCancelServer();
    const backendReported =
      e instanceof Error && (e as Error & { backendReported?: boolean }).backendReported === true;
    const transportExhausted = !aborted && !backendReported;
    if (!detached && !transportExhausted) clearSweepJob();
    throw e;
  }
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
