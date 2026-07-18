// Reload re-attach for detached sweep jobs. A sweep is submitted as one backend
// job that keeps running even if the modal closes (see runSweep's detach path).
// runSweep remembers the job id + target here; on the next modal mount, resumeSweep
// reconnects to a still-running (or just-finished) job and republishes its rows
// into sweepStateSignal, exactly as BacktestButton's live loop does.
//
// The memo is SESSION storage (per-tab, cleared on close): a job outlives a reload
// of the same tab, not a brand-new session. Access is guarded for the node test
// env, where sessionStorage is not defined (unlike fetch, it is not a Node global).

import { pollSweepJob, saveSweepArchive, type SweepTarget } from "../api";
import { pollToCompletion, sweepCatchState } from "./sweep";
import type { SweepAxis } from "./sweep";
import {
  sweepStateSignal,
  sweepCancelRequest,
  sweepCancelServer,
  sweepArchivedSignal,
} from "./signals";

const MEMO_KEY = "at.sweepJob";

// Enough to archive the sweep server-side if it finishes after a reload re-attach
// (the completing job's rows are the only other piece). Optional so an old memo
// (or a job we couldn't capture this for) still re-attaches, just unarchived.
interface SweepArchiveMeta {
  epic: string;
  timeframe: string;
  axes: SweepAxis[];
  windows: number[] | null;
}

interface SweepMemo {
  jobId: string;
  target: SweepTarget;
  archive?: SweepArchiveMeta;
}

/** Record the in-flight job so a reload can re-attach to it. `archive` carries the
 * metadata needed to archive the sweep if it completes on a re-attach; omit it and
 * that completion path simply won't archive. */
export function rememberSweepJob(
  jobId: string,
  target: SweepTarget,
  archive?: SweepArchiveMeta,
): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(MEMO_KEY, JSON.stringify({ jobId, target, archive }));
  } catch {
    /* quota / serialization: non-fatal, re-attach just won't be available */
  }
}

// Archive a sweep that completed on a re-attach (fire-and-forget). Mirrors the
// live-run archive in BacktestButton; only fires when the memo carried the
// metadata and the run produced rows, so it never invents values.
function archiveResumedSweep(archive: SweepArchiveMeta | undefined, rows: import("../api").SweepRow[]): void {
  if (!archive || rows.length === 0) return;
  saveSweepArchive({
    epic: archive.epic,
    timeframe: archive.timeframe,
    name: null,
    axes: archive.axes,
    rows,
    windows: archive.windows,
  })
    .then(() => sweepArchivedSignal.set(sweepArchivedSignal.value + 1))
    .catch((e) => console.warn("sweep archive failed", e));
}

/** Forget the remembered job (it ended, or the poll found it gone). */
export function clearSweepJob(): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.removeItem(MEMO_KEY);
  } catch {
    /* non-fatal */
  }
}

function readMemo(): SweepMemo | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(MEMO_KEY);
    if (!raw) return null;
    const memo = JSON.parse(raw) as SweepMemo;
    if (!memo || typeof memo.jobId !== "string") return null;
    return {
      jobId: memo.jobId,
      target: memo.target === "remote" ? "remote" : "local",
      archive: memo.archive,
    };
  } catch {
    return null; // malformed memo reads as "none remembered"
  }
}

// The controller for the currently-running re-attached poll, so the visible
// "Cancel sweep" button (and a takeover by a newly submitted sweep) can stop it.
// Null when no resumed poll is live.
let resumedCtl: AbortController | null = null;

// Stop a live resumed poll as a TAKEOVER/detach (never a server cancel): a new
// in-session sweep submission calls this so its own run cleanly owns the state.
// No-op when nothing is being resumed.
export function stopResumedSweep(): void {
  if (!resumedCtl) return;
  sweepCancelServer.value = false;
  resumedCtl.abort();
}

// Continue polling a still-running re-attached job to completion, republishing each
// batch into sweepStateSignal. Wired to the shared cancel signals exactly as
// BacktestButton's live loop is, so the "Cancel sweep" button works for a resumed
// job: an explicit Cancel (sweepCancelServer true) kills the server job, a detach
// (false) just stops this poll. A FOREIGN cancel (another tab) surfaces as a
// "sweep aborted" rejection, which sweepCatchState maps to a neutral cancelled
// state, never an error.
async function continueResume(jobId: string, target: SweepTarget, archive?: SweepArchiveMeta): Promise<void> {
  const ctl = new AbortController();
  resumedCtl = ctl;
  const unsub = sweepCancelRequest.subscribe(() => ctl.abort());
  const landed: import("../api").SweepRow[] = [];
  try {
    const rows = await pollToCompletion(jobId, target, {
      signal: ctl.signal,
      shouldCancelServer: () => sweepCancelServer.value,
      onRows: (chunk, done, total, etaSeconds) => {
        // After an abort (detach / takeover) the state may already be cleared or
        // owned by a new run: a late-resolving poll must not publish stale rows.
        // No startedAt: the run began before this page load, so there is no
        // client start time — the progress bar shows only the ETA.
        if (ctl.signal.aborted) return;
        landed.push(...chunk);
        sweepStateSignal.set({ rows: landed, done, total, running: true, etaSeconds });
      },
    });
    sweepStateSignal.set({ rows, done: rows.length, total: rows.length, running: false });
    archiveResumedSweep(archive, rows);
    clearSweepJob();
  } catch (e) {
    // A detach abort (modal close / takeover: this LOCAL signal aborted with
    // server=false) must neither publish (the closer already tore the state
    // down, and a takeover's fresh run now owns it: publishing would resurrect
    // a ghost or stomp the new run) nor clear the memo (the server job keeps
    // running for a reload to re-attach). Every other terminal end publishes
    // and clears: an explicit Cancel or a FOREIGN backend cancel ("sweep
    // aborted" without a local abort) as neutral cancelled, a real poll
    // failure as the error state.
    const detached = ctl.signal.aborted && sweepCancelServer.value === false;
    if (!detached) {
      const aborted = ctl.signal.aborted || (e instanceof Error && e.message === "sweep aborted");
      sweepStateSignal.set(sweepCatchState(sweepStateSignal.value, aborted, e));
      // Keep the memo when the poll gave up on a sustained transport outage (not
      // an abort, not a backend-reported failure): the server job likely keeps
      // running, so a reload can re-attach. Every other terminal end clears it.
      const backendReported =
        e instanceof Error && (e as Error & { backendReported?: boolean }).backendReported === true;
      const transportExhausted = !aborted && !backendReported;
      if (!transportExhausted) clearSweepJob();
    }
  } finally {
    unsub();
    if (resumedCtl === ctl) resumedCtl = null;
  }
}

/** Re-attach to a remembered sweep job. Returns false (making no api calls) when
 * nothing is remembered or the job is gone; true once a live/finished job's state
 * has been published to sweepStateSignal. Call only when sweepStateSignal.value is
 * null (no run already owns the state); the modal mount guards on that. */
export async function resumeSweep(): Promise<boolean> {
  const memo = readMemo();
  if (!memo) return false;
  const { jobId, target, archive } = memo;

  let status: import("../api").SweepJobStatus;
  try {
    status = await pollSweepJob(jobId, 0, target);
  } catch {
    clearSweepJob(); // 404 / gone / network error: forget it, nothing to re-attach
    return false;
  }

  if (!status.running) {
    // Finished while we were away: publish the terminal state and forget the job.
    clearSweepJob();
    if (status.cancelled) {
      sweepStateSignal.set({ rows: status.rows, done: status.done, total: status.total, running: false, cancelled: true });
    } else if (status.error) {
      sweepStateSignal.set({ rows: status.rows, done: status.done, total: status.total, running: false, error: status.error });
    } else {
      // Clean completion while we were away: archive it (the live-run path in
      // BacktestButton never got to, since the tab reloaded before it finished).
      sweepStateSignal.set({ rows: status.rows, done: status.done, total: status.total, running: false });
      archiveResumedSweep(archive, status.rows);
    }
    return true;
  }

  // Still running: show what's landed so far, then keep polling to completion.
  // (continueResume re-fetches from cursor 0, so it doesn't double-count these.)
  sweepStateSignal.set({ rows: status.rows, done: status.done, total: status.total, running: true, etaSeconds: status.etaSeconds });
  void continueResume(jobId, target, archive);
  return true;
}
