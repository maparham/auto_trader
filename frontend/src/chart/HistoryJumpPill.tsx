import { useSyncExternalStore } from "react";
import { historyJumpSignal } from "../lib/historyJump";

// Passive "Loading history…" pill shown on the chart cell a jump-to-point is
// backfilling candles for (backtest trade row, trade-list row, pattern match).
// Subscribes itself so the surrounding cell tree doesn't re-render per progress
// tick; the CSS fade-in delay keeps an already-covered jump from flashing it.
export default function HistoryJumpPill({ cellId }: { cellId: string }) {
  const jump = useSyncExternalStore(
    (notify) => historyJumpSignal.subscribe(notify),
    () => historyJumpSignal.value,
  );
  if (!jump || jump.cellId !== cellId) return null;
  const p = jump.progress;
  return (
    <div className="chart-history-jump" role="status">
      Loading history…{p && p.total > 0 ? ` ${p.done}/${p.total}` : ""}
    </div>
  );
}
