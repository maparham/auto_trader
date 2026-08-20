// Backtest workflow actions. backtest.run drives the SAME signal path as the
// panel's Run button (requestBacktestRun -> BacktestButton.run), so all the
// browser-side assembly (window resolution, candle fetch, warm-up widening,
// baselines) is reused untouched; this module only adapts start/finish/error
// signals into a promise + progress stream for the bridge.
import { ActionError, registerAction } from "../registry";
import { maskedSessionNow } from "../../lib/maskedReplay";
import {
  backtestMessagesSignal, backtestProgressSignal, backtestResultSignal,
  backtestRunningSignal, requestBacktestCancel, requestBacktestRun,
} from "../../lib/signals";
import { loadBacktestLastUsed, saveBacktestLastUsed } from "../../lib/persist";
import { defaultBacktestConfig, type BacktestConfig } from "../../lib/backtestConfig";

// How long to wait for a run to actually start before giving up (no chart
// focused means nothing is subscribed to the run request).
const START_TIMEOUT_MS = 5000;

// After the run flips `running` off, how long to keep waiting for the outcome
// (error message or fresh result) to be published, and how often to re-check.
const FINISH_GRACE_MS = 100;
const FINISH_POLL_MS = 15;

function currentConfig(): BacktestConfig {
  return loadBacktestLastUsed() ?? defaultBacktestConfig();
}

export function registerBacktestActions(): void {
  registerAction({
    name: "backtest.config.get",
    description: "The current (last-used) backtest configuration",
    kind: "read",
    params: { type: "object", properties: {} },
    handler: async () => currentConfig(),
  });

  registerAction({
    name: "backtest.config.set",
    description:
      "Shallow-merge a patch into the backtest configuration (same shape as backtest.config.get: mode, codedStrategy, range, costs, longRisk, ...). Returns the merged config.",
    kind: "write",
    params: {
      type: "object",
      properties: { patch: { type: "object", description: "Partial BacktestConfig" } },
      required: ["patch"],
    },
    handler: async (args) => {
      const merged = { ...currentConfig(), ...(args.patch as Partial<BacktestConfig>) };
      saveBacktestLastUsed(merged as BacktestConfig);
      return merged;
    },
  });

  registerAction({
    name: "backtest.run",
    description:
      "Run a backtest with the current configuration on the focused chart. Long-running: returns a handle; ui_wait streams progress and resolves with the result.",
    kind: "write",
    longRunning: true,
    params: { type: "object", properties: {} },
    handler: (_args, ctx) =>
      new Promise((resolve, reject) => {
        let started = false;
        let settled = false;
        // Only an error published WHILE this run is in flight belongs to it:
        // backtestMessagesSignal keeps the previous run's error until
        // BacktestButton clears it, so reading the signal at finish time would
        // reject a healthy run with a stale message.
        let runError: string | null = null;
        // Same staleness trap on the result side: backtestResultSignal keeps the
        // previous run's result (and rehydrate republishes a stored one), so a
        // cancelled run would otherwise resolve with an older result. A real run
        // always publishes a fresh object (runAndRender returns the JSON
        // round-tripped copy read back out of storage), so identity is a sound
        // "did anything new arrive?" discriminator.
        const resultBefore = backtestResultSignal.value;
        const unsubs: Array<() => void> = [];
        let startTimer: ReturnType<typeof setTimeout> | null = null;
        let finishTimer: ReturnType<typeof setTimeout> | null = null;
        const cleanup = () => {
          if (startTimer) { clearTimeout(startTimer); startTimer = null; }
          if (finishTimer) { clearTimeout(finishTimer); finishTimer = null; }
          unsubs.forEach((u) => u());
          unsubs.length = 0;
        };

        // BacktestButton flips `running` off imperatively but publishes its error
        // through a React passive effect, which on a heavy commit can land
        // several macrotasks later. So don't decide on a single deferred tick:
        // poll (subscriptions still live) until the error or the new result
        // shows up, and only fall back to the generic "no result" message once
        // the grace window is spent. Never resolves off a stale result, never
        // rejects with a pre-run error: both are discriminated before we get here
        // (runError is only set for errors published during the run, and the
        // result must be a different object than the pre-run snapshot).
        // Anchored when `running` flips off (NOT at handler entry): the window
        // is a grace period on the finish, and a run of any length must get the
        // full 100ms.
        let finishDeadline = 0;
        const decide = () => {
          const result = backtestResultSignal.value;
          const fresh = result && result !== resultBefore;
          if (!runError && !fresh && Date.now() < finishDeadline) {
            finishTimer = setTimeout(decide, FINISH_POLL_MS);
            return;
          }
          cleanup();
          if (runError) reject(new Error(runError));
          else if (fresh) resolve(result);
          else reject(new Error("run finished without a result (cancelled?)"));
        };

        unsubs.push(backtestProgressSignal.subscribe((p) => { if (p) ctx.progress(p); }));
        unsubs.push(backtestMessagesSignal.subscribe((m) => {
          if (started && m.error) runError = m.error;
        }));
        unsubs.push(backtestRunningSignal.subscribe((running) => {
          if (running) { started = true; return; }
          if (!started || settled) return; // ignore the initial false
          settled = true;
          // First check on the next macrotask (the common case: everything is
          // already published), then poll within the grace window, which starts
          // HERE so a long run still gets the full window.
          finishDeadline = Date.now() + FINISH_GRACE_MS;
          finishTimer = setTimeout(decide, 0);
        }));
        const onAbort = () => { requestBacktestCancel(); };
        unsubs.push(() => ctx.signal.removeEventListener("abort", onAbort));
        ctx.signal.addEventListener("abort", onAbort);

        if (backtestRunningSignal.value) {
          cleanup();
          reject(new Error("a backtest is already running"));
          return;
        }
        requestBacktestRun();
        // Guard: if nothing picks up the request (no chart focused), fail
        // instead of hanging forever.
        startTimer = setTimeout(() => {
          if (!started && !settled) {
            settled = true;
            cleanup();
            reject(new Error("run did not start (is a chart with a symbol open and focused?)"));
          }
        }, START_TIMEOUT_MS);
      }),
  });

  registerAction({
    name: "backtest.cancel",
    description: "Cancel the in-flight single backtest run",
    kind: "write",
    params: { type: "object", properties: {} },
    handler: async () => { requestBacktestCancel(); return { requested: true }; },
  });

  registerAction({
    name: "backtest.result",
    description:
      "The currently displayed backtest result (metrics, trades, analysis; no candles). Null when none. Refused while a BLIND chart replay session is running, because every trade carries its real entry and exit timestamps.",
    kind: "read",
    params: { type: "object", properties: {} },
    // The one place the reveal leaks. On screen the trade table renders these
    // timestamps through the masked formatter, but this hands back the stored
    // result verbatim — real epochs, which is precisely the date a blind session
    // exists to hide, delivered to an agent whose output the user then reads.
    //
    // Refused rather than masked: replacing the epochs with "Day 3 09:30" would
    // change the field's TYPE for every agent that does arithmetic on it, and a
    // partial answer (metrics only) invites the reader to assume the omission
    // was incidental. Exiting the session is one action away and gives the
    // caller everything.
    //
    // Gated on MASKED, not on replaying: an unmasked session has the real dates
    // on the axis already, so there is nothing here to withhold.
    handler: async () => {
      if (maskedSessionNow()) {
        throw new ActionError(
          "BLOCKED_BY_REPLAY",
          "a blind chart replay session is running: its trades carry the real dates the session hides. Exit the session to read the result.",
        );
      }
      return backtestResultSignal.value;
    },
  });

  registerAction({
    name: "backtest.progress",
    description: "Live progress of the in-flight run (null when idle)",
    kind: "read",
    params: { type: "object", properties: {} },
    handler: async () => backtestProgressSignal.value,
  });
}
