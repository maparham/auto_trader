// Walk-forward optimization config, payload builder, and persistence.

import {
  WFO_BASELINE_KINDS,
  cancelWfoJob,
  pollWfoJob,
  submitWfoJob,
  type BacktestRequest,
  type ExprBacktestRequest,
  type SweepTarget,
  type WfoAxis,
  type WalkForwardPayload,
  type WfoFoldRow,
  type WfoJobStatus,
  type WfoResult,
  type WfoSchedule,
  type WfoObjective,
} from "../api";
import { cancelWithRetry } from "./cancelRetry";
import { axisValues, enumerateCombos, type SweepAxis } from "./sweep";
import { wfoStateSignal, wfoCancelRequest, wfoCancelServer, type WfoRunState } from "./signals";

export const TRAIN_SPAN_PICKS = ["2w", "1m", "3m", "6m"] as const;

export interface WfoConfigState {
  trainSpans: string[];          // >=1 selected; first = primary, rest = matrix
  testSpan: string;              // default "1m"
  step: string | null;           // null = testSpan
  mode: "rolling" | "anchored";  // default "rolling"
  metric: string;                // default "sharpe"
  selection: "best" | "plateau"; // default "plateau"
  evalMode: "exact" | "fast";    // default "exact"
}

export const DEFAULT_WFO_CONFIG: WfoConfigState = {
  trainSpans: ["3m"],
  testSpan: "1m",
  step: null,
  mode: "rolling",
  metric: "sharpe",
  selection: "plateau",
  evalMode: "exact",
};

/**
 * Converts SweepAxis[] to WfoAxis[], filtering out period and timeWindow axes.
 * Returns the converted wfoAxes, the surviving usable SweepAxis[], and dropped labels.
 *
 * Conversions:
 * - RangeAxis -> {kind:"range", targets:[target, ...(mirrorTarget?[mirrorTarget]:[])], values: axisValues(a)}
 * - ListAxis -> {kind:"list", targets: Object.keys(options[0].patch)} — but DROP (into `dropped`, by label)
 *   any period axis (kind === "period") and any list axis whose option patches contain a key
 *   starting with "period:" or "timeWindow:" (backend 422s those in WFO combos).
 */
export function wfoAxesFromSweepAxes(axes: SweepAxis[]): {
  wfoAxes: WfoAxis[];
  usable: SweepAxis[];
  dropped: string[];
} {
  const wfoAxes: WfoAxis[] = [];
  const usable: SweepAxis[] = [];
  const dropped: string[] = [];

  for (const axis of axes) {
    // Drop period axes
    if (axis.kind === "period") {
      dropped.push(axis.label);
      continue;
    }

    // Handle list axes. Drop (into `dropped`, by label) BEFORE touching
    // options[0]:
    //  - session (timeWindow) axes — backend 422s them in WFO combos, and a
    //    timeWindow axis seeded from an empty mask has options: [] (would throw
    //    on options[0] below) and also round-trips through persisted axes.
    //  - any empty-options list axis (nothing to convert).
    //  - any list axis whose option patches carry a period:/timeWindow: key.
    if (axis.kind === "list") {
      const hasForbiddenKey = axis.options.some((opt) =>
        Object.keys(opt.patch).some((k) => k.startsWith("period:") || k.startsWith("timeWindow:"))
      );
      if (axis.target === "timeWindow" || axis.options.length === 0 || hasForbiddenKey) {
        dropped.push(axis.label);
        continue;
      }

      // Convert list axis: targets are the keys from the first option's patch
      const targets = Object.keys(axis.options[0].patch);
      wfoAxes.push({ kind: "list", targets });
      usable.push(axis);
      continue;
    }

    // Handle range axes
    if (axis.kind === "range") {
      const targets = [axis.target];
      if (axis.mirrorTarget) {
        targets.push(axis.mirrorTarget);
      }
      const values = axisValues(axis);
      wfoAxes.push({ kind: "range", targets, values });
      usable.push(axis);
    }
  }

  return { wfoAxes, usable, dropped };
}

/**
 * Builds a complete WalkForwardPayload from sweep axes and WFO config.
 *
 * Throws Error("add at least one parameter axis") when usable axes produce 0 combos,
 * and Error("select a training span") when cfg.trainSpans is empty.
 */
export function buildWalkForwardPayload(
  axes: SweepAxis[],
  cfg: WfoConfigState,
): { payload: WalkForwardPayload; comboTotal: number; dropped: string[] } {
  const { wfoAxes, usable, dropped } = wfoAxesFromSweepAxes(axes);

  // Check for training span
  if (cfg.trainSpans.length === 0) {
    throw new Error("select a training span");
  }

  // Enumerate combos from usable axes
  const combos = enumerateCombos(usable);

  // Check for at least one parameter axis
  if (combos.length === 0) {
    throw new Error("add at least one parameter axis");
  }

  const schedule: WfoSchedule = {
    mode: cfg.mode,
    trainSpan: cfg.trainSpans[0],
    testSpan: cfg.testSpan,
    step: cfg.step ?? undefined,
  };

  const objective: WfoObjective = {
    metric: cfg.metric,
    selection: cfg.selection,
  };

  const matrixTrainSpans = cfg.trainSpans.slice(1);

  const payload: WalkForwardPayload = {
    combos,
    axes: wfoAxes,
    schedule,
    objective,
    matrixTrainSpans: matrixTrainSpans.length > 0 ? matrixTrainSpans : undefined,
    evalMode: cfg.evalMode,
    // Always on (product decision): every fold is scored against the null and
    // hold baselines so Excess % is there without a per-run opt-in. One payload
    // object feeds both the expr and the structured walk-forward submissions;
    // the structured route accepts and ignores the field.
    baselines: WFO_BASELINE_KINDS,
  };

  return { payload, comboTotal: combos.length, dropped };
}

// ── Run pipeline (submit / poll / cancel / resume) ─────────────────────────
// The whole grid + test schedule is submitted as one backend job; runWalkForward
// then polls it every WFO_POLL_MS, streaming winner rows out through onState as
// they land and cancelling the job on abort. Mirrors runSweep/pollToCompletion.

export const WFO_POLL_MS = 700;

const MEMO_KEY = "at.wfoJob";

/** Record the in-flight WFO job so a reload can re-attach to it. SESSION storage
 * (per-tab); access is guarded for the node test env, where sessionStorage is not
 * a global (mirrors lib/sweepResume). */
export function rememberWfoJob(jobId: string, target: SweepTarget): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(MEMO_KEY, JSON.stringify({ jobId, target }));
  } catch {
    /* quota / serialization: non-fatal, re-attach just won't be available */
  }
}

export function readWfoMemo(): { jobId: string; target: SweepTarget } | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(MEMO_KEY);
    if (!raw) return null;
    const memo = JSON.parse(raw) as { jobId?: unknown; target?: unknown };
    if (!memo || typeof memo.jobId !== "string") return null;
    return { jobId: memo.jobId, target: memo.target === "remote" ? "remote" : "local" };
  } catch {
    return null; // malformed memo reads as "none remembered"
  }
}

/** Forget the remembered job (it ended, or the poll found it gone). */
export function clearWfoJob(): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.removeItem(MEMO_KEY);
  } catch {
    /* non-fatal */
  }
}

/** A cancellable sleep: resolves after `ms`, or immediately if `signal` aborts
 * (clearing the timer so no pending timeout leaks). (Copied from lib/sweep.) */
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

/** Build a WfoRunState off a poll status. `startedAt` is absent on re-attached
 * runs (started before this page load), which show only the ETA. */
function buildWfoState(
  status: WfoJobStatus,
  foldRows: WfoFoldRow[],
  jobId: string,
  startedAt?: number,
): WfoRunState {
  return {
    phase: status.phase,
    done: status.done,
    total: status.total,
    running: status.running,
    cancelled: status.cancelled,
    error: status.error ?? undefined,
    etaSeconds: status.etaSeconds,
    foldRows,
    result: status.result,
    jobId,
    startedAt,
  };
}

// Poll a submitted job every WFO_POLL_MS, streaming state through onState and
// resolving the result when the job ends. Shared by runWalkForward (after submit)
// and resumeWfo (re-attach on reload). Tolerates up to 5 CONSECUTIVE poll failures
// (a transient proxy 502 must not tear the run down), exactly like sweep's
// pollToCompletion. On abort it stops polling and throws "walk-forward aborted",
// killing the SERVER job only when shouldCancelServer() is true. A backend-reported
// cancel resolves to null; a backend-reported error throws (tagged backendReported).
async function pollWfoToCompletion(
  jobId: string,
  target: SweepTarget,
  opts: {
    onState: (st: WfoRunState) => void;
    signal?: AbortSignal;
    shouldCancelServer?: () => boolean;
    startedAt?: number;
  },
): Promise<WfoResult | null> {
  const shouldCancelServer = opts.shouldCancelServer ?? (() => true);
  const foldRows: WfoFoldRow[] = [];
  let consecutiveFailures = 0;
  for (;;) {
    await sleep(WFO_POLL_MS, opts.signal);
    if (opts.signal?.aborted) {
      if (shouldCancelServer()) void cancelWithRetry(() => cancelWfoJob(jobId, target));
      throw new Error("walk-forward aborted");
    }
    let status: WfoJobStatus;
    try {
      status = await pollWfoJob(jobId, foldRows.length, target);
    } catch (e) {
      if (++consecutiveFailures >= 5) throw e;
      continue;
    }
    consecutiveFailures = 0;
    foldRows.push(...status.foldRows);
    opts.onState(buildWfoState(status, foldRows, jobId, opts.startedAt));
    if (!status.running) {
      if (status.cancelled) return null;
      if (status.error) {
        const err = new Error(status.error);
        (err as Error & { backendReported?: boolean }).backendReported = true;
        throw err;
      }
      return status.result;
    }
  }
}

/** Submit a walk-forward job and drive it to completion, streaming each poll's
 * state through opts.onState (the caller publishes to wfoStateSignal). Returns the
 * WfoResult on a clean finish, null on a backend cancel. Throws "walk-forward
 * aborted" on a client abort (killing the server job only when shouldCancelServer()
 * is true), or the backend error on a reported failure. */
export async function runWalkForward(
  baseReq: BacktestRequest | ExprBacktestRequest,
  wf: WalkForwardPayload,
  opts: {
    signal?: AbortSignal;
    target?: SweepTarget;
    shouldCancelServer?: () => boolean;
    expr?: boolean;
    onState: (st: WfoRunState) => void;
  },
): Promise<WfoResult | null> {
  const target: SweepTarget = opts.target ?? "local";
  if (opts.signal?.aborted) throw new Error("walk-forward aborted");

  const { jobId } = await submitWfoJob(baseReq, wf, target, opts.expr ?? false);
  rememberWfoJob(jobId, target);
  const startedAt = Date.now();
  const shouldCancelServer = opts.shouldCancelServer ?? (() => true);

  try {
    const result = await pollWfoToCompletion(jobId, target, {
      onState: opts.onState,
      signal: opts.signal,
      shouldCancelServer,
      startedAt,
    });
    clearWfoJob();
    return result;
  } catch (e) {
    // Keep the re-attach memo only when the job could still be picked up by a
    // reload (mirrors runSweep):
    //  - detach abort (modal closed, shouldCancelServer false): job keeps running -> KEEP.
    //  - transport-exhausted rejection (5 consecutive poll failures): job likely
    //    still running with no consumer -> KEEP so a reload re-attaches.
    //  - client/backend cancel, backend-reported error, clean finish -> CLEAR.
    const aborted = e instanceof Error && e.message === "walk-forward aborted";
    const detached = aborted && !!opts.signal?.aborted && !shouldCancelServer();
    const backendReported =
      e instanceof Error && (e as Error & { backendReported?: boolean }).backendReported === true;
    const transportExhausted = !aborted && !backendReported;
    if (!detached && !transportExhausted) clearWfoJob();
    throw e;
  }
}

// Maps a caught runWalkForward rejection + the AbortController's signal back
// onto the next wfoStateSignal value (mirrors sweepCatchState in lib/sweep). A
// user Cancel and a real failure both reject the same promise, so the signal —
// not the error's message/identity — is the source of truth for which
// happened: Cancel must never render as an error.
export function wfoCatchState(
  prev: WfoRunState | null,
  aborted: boolean,
  err: unknown,
): WfoRunState {
  const base: WfoRunState = {
    phase: prev?.phase ?? "grid",
    done: prev?.done ?? 0,
    total: prev?.total ?? 0,
    running: false,
    etaSeconds: null,
    foldRows: prev?.foldRows ?? [],
    result: prev?.result ?? null,
    jobId: prev?.jobId,
    startedAt: prev?.startedAt,
  };
  if (aborted) return { ...base, cancelled: true };
  return {
    ...base,
    error: err instanceof Error ? err.message : "walk-forward failed",
  };
}

// The controller for a currently-running re-attached poll, so the visible "Cancel"
// button (and a takeover by a newly submitted run) can stop it. Null when idle.
let resumedCtl: AbortController | null = null;

// Stop a live resumed poll as a TAKEOVER/detach (never a server cancel): a new
// in-session WFO submission calls this so its own run cleanly owns the state.
export function stopResumedWfo(): void {
  if (!resumedCtl) return;
  wfoCancelServer.value = false;
  resumedCtl.abort();
}

// Continue polling a still-running re-attached job to completion, republishing each
// state into wfoStateSignal. Wired to the shared cancel signals so the "Cancel"
// button works for a resumed job (mirrors continueResume in lib/sweepResume).
async function continueResumeWfo(jobId: string, target: SweepTarget): Promise<void> {
  const ctl = new AbortController();
  resumedCtl = ctl;
  const unsub = wfoCancelRequest.subscribe(() => ctl.abort());
  try {
    const result = await pollWfoToCompletion(jobId, target, {
      signal: ctl.signal,
      shouldCancelServer: () => wfoCancelServer.value,
      onState: (st) => {
        // After an abort (detach / takeover) the state may already be cleared or
        // owned by a new run: a late-resolving poll must not publish stale state.
        if (ctl.signal.aborted) return;
        wfoStateSignal.set(st);
      },
    });
    // Clean finish or backend cancel: pollWfoToCompletion's terminal onState
    // already published the final running:false state; just forget the job.
    void result;
    clearWfoJob();
  } catch (e) {
    // A detach abort (modal close / takeover, server=false) must neither publish
    // (the closer tore the state down) nor clear the memo (the job keeps running
    // for a reload). Every other terminal end publishes and clears; a transport
    // outage keeps the memo so a reload can re-attach.
    const detached = ctl.signal.aborted && wfoCancelServer.value === false;
    if (!detached) {
      const aborted = ctl.signal.aborted || (e instanceof Error && e.message === "walk-forward aborted");
      const prev = wfoStateSignal.value;
      wfoStateSignal.set({
        phase: prev?.phase ?? "grid",
        done: prev?.done ?? 0,
        total: prev?.total ?? 0,
        running: false,
        cancelled: aborted || undefined,
        error: aborted ? undefined : e instanceof Error ? e.message : "walk-forward failed",
        etaSeconds: null,
        foldRows: prev?.foldRows ?? [],
        result: prev?.result ?? null,
        jobId,
      });
      const backendReported =
        e instanceof Error && (e as Error & { backendReported?: boolean }).backendReported === true;
      const transportExhausted = !aborted && !backendReported;
      if (!transportExhausted) clearWfoJob();
    }
  } finally {
    unsub();
    if (resumedCtl === ctl) resumedCtl = null;
  }
}

/** Re-attach to a remembered WFO job on reload. Returns false (making no api call
 * beyond the probe) when nothing is remembered or the job is gone; true once a
 * live/finished job's state has been published to wfoStateSignal. Call only when
 * wfoStateSignal.value is null (no run already owns the state). */
export async function resumeWfo(): Promise<boolean> {
  const memo = readWfoMemo();
  if (!memo) return false;
  const { jobId, target } = memo;

  let status: WfoJobStatus;
  try {
    status = await pollWfoJob(jobId, 0, target);
  } catch {
    clearWfoJob(); // 404 / gone / network error: forget it, nothing to re-attach
    return false;
  }

  if (!status.running) {
    // Finished (or cancelled/errored) while we were away: publish it and forget.
    clearWfoJob();
    wfoStateSignal.set(buildWfoState(status, status.foldRows, jobId));
    return true;
  }

  // Still running: show what's landed so far, then keep polling to completion.
  wfoStateSignal.set(buildWfoState(status, status.foldRows, jobId));
  void continueResumeWfo(jobId, target);
  return true;
}
