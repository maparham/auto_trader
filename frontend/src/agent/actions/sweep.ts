// Sweep actions: sweep.start reuses the exact production path (publish axes,
// bump the run request; BacktestButton branches into runSweep when
// sweepAxesSignal is non-empty) and adapts sweepStateSignal into a promise +
// progress stream for the bridge.
//
// This module OWNS the axes lifecycle for agent-driven sweeps: it sets
// sweepAxesSignal on start and resets it to [] in the single finalize path, so
// a later backtest.run is never silently routed into the sweep branch (which
// would also break backtest.run's fresh-result identity check, since
// BacktestButton only pre-nulls the result on the non-sweep branch).
import { registerAction } from "../registry";
import {
  backtestRunningSignal, requestBacktestRun, requestSweepCancel,
  sweepAxesSignal, sweepStateSignal, type SweepRunState,
} from "../../lib/signals";
import type { SweepAxis } from "../../lib/sweep";

// How long to wait for the sweep to actually start before giving up (nothing is
// subscribed to the run request when no chart is focused).
const START_TIMEOUT_MS = 5000;

// After an abort, how long to wait for the runner to publish its cancelled state
// before settling anyway. requestSweepCancel aborts BacktestButton's controller
// on the next tick and its catch republishes a cancelled state, so this only
// fires when that path is itself torn down (see the null-state note below).
const ABORT_GRACE_MS = 2000;

export function registerSweepActions(): void {
  registerAction({
    name: "sweep.start",
    description:
      "Start a parameter sweep with the current backtest config on the focused chart. axes: [{param, values}] (lib/sweep SweepAxis). Long-running: ui_wait streams progress and resolves with the rows.",
    kind: "write",
    longRunning: true,
    params: {
      type: "object",
      properties: {
        axes: { type: "array", description: "SweepAxis[]: [{param, values: [...]}]" },
      },
      required: ["axes"],
    },
    handler: (args, ctx) =>
      new Promise((resolve, reject) => {
        // Guard FIRST, before touching the axes: a rejected call must not
        // clobber the axes of a sweep/backtest already in flight.
        if (backtestRunningSignal.value || sweepStateSignal.value?.running) {
          reject(new Error("a backtest or sweep is already running"));
          return;
        }

        let started = false;
        let settled = false;
        // A previous sweep's finished state is still on the signal; only a state
        // published after this call belongs to this run.
        const stateBefore = sweepStateSignal.value;
        let unsub: (() => void) | null = null;
        let startTimer: ReturnType<typeof setTimeout> | null = null;
        let abortTimer: ReturnType<typeof setTimeout> | null = null;
        // The abort asks the runner to stop; its catch normally publishes a
        // cancelled state, which settles us through the subscriber. The grace
        // timer is the backstop for when it can't (the run's whole poll loop was
        // torn down), so an aborted invocation never hangs.
        const onAbort = () => {
          requestSweepCancel(true);
          if (settled || abortTimer) return;
          abortTimer = setTimeout(() => {
            if (settled) return;
            finalize();
            reject(new Error("sweep cancelled"));
          }, ABORT_GRACE_MS);
        };
        const finalize = () => {
          settled = true;
          if (startTimer) { clearTimeout(startTimer); startTimer = null; }
          if (abortTimer) { clearTimeout(abortTimer); abortTimer = null; }
          unsub?.();
          unsub = null;
          ctx.signal.removeEventListener("abort", onAbort);
          // Hand the axes back to the panel/backtest path (ruling: sweep.start
          // owns the lifecycle) on resolve, reject and timeout alike.
          sweepAxesSignal.set([]);
        };

        unsub = sweepStateSignal.subscribe((st: SweepRunState | null) => {
          if (settled) return;
          // A null publish AFTER the run started is terminal, not noise: closing
          // the backtest settings panel unmounts the modal, whose cleanup runs
          // requestSweepCancel(false) + sweepStateSignal.set(null), and
          // BacktestButton's catch then deliberately skips republishing
          // (`aborted && sweepStateSignal.value === null`). Nothing else is ever
          // coming, so swallowing this would hang the invocation forever.
          if (!st) {
            if (!started) return;
            finalize();
            reject(new Error("sweep state was cleared (panel closed?)"));
            return;
          }
          if (st === stateBefore) return;
          if (st.running) {
            started = true;
            ctx.progress({ done: st.done, total: st.total, etaSeconds: st.etaSeconds ?? null });
            return;
          }
          // A terminal state before anything ran isn't ours (BacktestButton can
          // republish a re-attached run's state); wait for the real start.
          if (!started && !st.error) return;
          finalize();
          if (st.error) reject(new Error(st.error));
          else if (st.cancelled) reject(new Error("sweep cancelled"));
          else resolve({ rows: st.rows });
        });
        ctx.signal.addEventListener("abort", onAbort);

        sweepAxesSignal.set(args.axes as SweepAxis[]);
        requestBacktestRun();
        startTimer = setTimeout(() => {
          if (started || settled) return;
          finalize();
          reject(new Error("sweep did not start (is a chart with a symbol open and focused?)"));
        }, START_TIMEOUT_MS);
      }),
  });

  registerAction({
    name: "sweep.cancel",
    description: "Cancel the in-flight sweep (kills the server job)",
    kind: "write",
    params: { type: "object", properties: {} },
    handler: async () => { requestSweepCancel(true); return { requested: true }; },
  });

  registerAction({
    name: "sweep.rows",
    description: "Rows of the current/last sweep this session (empty when none)",
    kind: "read",
    params: { type: "object", properties: {} },
    handler: async () => sweepStateSignal.value?.rows ?? [],
  });
}
