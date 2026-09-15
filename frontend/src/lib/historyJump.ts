// One in-flight "jump to a point behind the loaded history" per app, published
// so the target chart cell can show a passive "Loading history…" pill while the
// candle backfill runs. Leaf module (imports only the Signal class + a type):
// it is written from three places that must not import each other — the pattern
// jump (useRangeNavigation), the backtest pager wrapper (ChartCore) and the
// trade-list jump (App).
import { Signal } from "./signals";
import type { FillProgress } from "./feed";

export interface HistoryJumpState {
  cellId: string;
  /** Backend gap-fill progress, when a partial response reported it. */
  progress: FillProgress | null;
}

// null = no jump in flight. Last begin wins: a click on the next result down
// the list supersedes the previous jump's entry outright, mirroring how the
// pendingRangeRef / epoch tokens preempt the underlying cover walks.
export const historyJumpSignal = new Signal<HistoryJumpState | null>(null);

export interface HistoryJumpHandle {
  /** Publish fill progress. Keeps the furthest `done` seen: the cover runs
   * parallel lanes against one series and laggard lanes report less done. */
  update: (p: FillProgress) => void;
  /** Clear the pill — unless a newer jump has taken the signal over. */
  end: () => void;
}

export function beginHistoryJump(cellId: string): HistoryJumpHandle {
  let mine: HistoryJumpState = { cellId, progress: null };
  historyJumpSignal.set(mine);
  const owns = () => historyJumpSignal.value === mine;
  return {
    update: (p) => {
      if (!owns()) return;
      if (mine.progress && mine.progress.done >= p.done) return;
      mine = { cellId, progress: p };
      historyJumpSignal.set(mine);
    },
    end: () => {
      if (owns()) historyJumpSignal.set(null);
    },
  };
}
