// 1s poller feeding backtestProgressSignal while a backtest run is in flight.
// Simulate beats download: once the POST is running its progress entry exists,
// and any backfill rows still active belong to background work, not this run.
// Failures are swallowed — a missed poll just leaves the last value showing.
import { fetchActiveBackfills, fetchBacktestProgress } from "../api";
import { backtestProgressSignal } from "./signals";

const POLL_MS = 1000;

export function startBacktestProgressPoller(progressId: string): () => void {
  let stopped = false;
  const tick = async () => {
    const [sim, backfills] = await Promise.all([
      fetchBacktestProgress(progressId).catch(() => null),
      fetchActiveBackfills().catch(() => []),
    ]);
    if (stopped) return; // a late response must not overwrite the reset
    if (sim && sim.total > 0) {
      backtestProgressSignal.set({
        phase: "simulate", label: sim.stage,
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
  };
  const interval = setInterval(tick, POLL_MS);
  return () => {
    stopped = true;
    clearInterval(interval);
    backtestProgressSignal.set(null);
  };
}
