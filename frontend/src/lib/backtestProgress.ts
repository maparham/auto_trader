// 1s poller feeding backtestProgressSignal while a backtest run is in flight.
// Simulate beats download: once the POST is running its progress entry exists,
// and any backfill rows still active belong to background work, not this run.
// Failures are swallowed — a missed poll just leaves the last value showing.
//
// Ticks are chained (the next poll is scheduled only after the previous one
// settles), so polls never overlap and a slow response can never land after a
// newer one to rewind the bar.
import { fetchActiveBackfills, fetchBacktestProgress } from "../api";
import { backtestProgressSignal } from "./signals";

const POLL_MS = 1000;

// The simulate phase covers several full engine passes (main run, then
// optional cost-sensitivity and baseline re-runs), each restarting its counter
// at 0%. Naming the pass keeps the bar's resets legible instead of looking
// like one "Simulating" bar jumping backwards. Keys are the backend's stage
// names (routers/backtest.py, routers/expr.py); unknown stages fall back to
// "Simulating" (Object.hasOwn so Object.prototype keys can't leak through).
const STAGE_LABELS: Record<string, string> = {
  simulate: "Simulating",
  "cost-sensitivity": "Running cost sensitivity",
  baselines: "Running baselines",
};
const stageLabel = (stage: string): string =>
  Object.hasOwn(STAGE_LABELS, stage) ? STAGE_LABELS[stage] : "Simulating";

export function startBacktestProgressPoller(progressId: string): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const tick = async () => {
    const [sim, backfills] = await Promise.all([
      fetchBacktestProgress(progressId).catch(() => null),
      fetchActiveBackfills().catch(() => []),
    ]);
    if (stopped) return; // a late response must not overwrite the reset
    if (sim && sim.total > 0) {
      backtestProgressSignal.set({
        phase: "simulate", label: stageLabel(sim.stage),
        pct: Math.floor((sim.done / sim.total) * 100), etaS: null,
      });
    } else if (backfills.length > 0) {
      const b = backfills[0];
      backtestProgressSignal.set({
        phase: "download", label: b.label,
        pct: b.totalChunks > 0 ? Math.floor((b.doneChunks / b.totalChunks) * 100) : null,
        etaS: b.etaS,
      });
    }
    timer = setTimeout(tick, POLL_MS);
  };
  timer = setTimeout(tick, POLL_MS);
  return () => {
    stopped = true;
    clearTimeout(timer);
    backtestProgressSignal.set(null);
  };
}
