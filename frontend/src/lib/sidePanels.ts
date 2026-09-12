// One-at-a-time rule for the right-docked side panels.
//
// The six surfaces that dock beside the chart (pattern results, imported trade
// list, alerts, order ticket, backtest config, live trading) are mutually
// exclusive: opening one closes whichever other one was open. Their open-state
// lives in three different places — plain signals (alerts/trade/trade-list/
// live), App-local state (backtest) and the pattern store — so instead of
// teaching each of them about the other five, every panel registers a closer
// here and calls claimSidePanel() on the way open.
//
// Leaf module on purpose: no imports, so signals.ts, patternPanelStore.ts and
// App.tsx can all reach it without opening an import cycle.

export type SidePanelId =
  | "patterns"
  | "tradeList"
  | "alerts"
  | "trade"
  | "backtest"
  | "live";

const closers = new Map<SidePanelId, () => void>();

/** Registers a panel's "close yourself" callback. Returns an unregister fn so a
 *  component-owned panel (backtest) can drop it on unmount. */
export function registerSidePanel(id: SidePanelId, close: () => void): () => void {
  closers.set(id, close);
  return () => {
    if (closers.get(id) === close) closers.delete(id);
  };
}

// True while a claim is running its closers. A closer can itself route through
// an open path (stageChartOrder clears the trade selection — which closes the
// trade panel — before opening it), so without this latch a nested claim would
// re-enter the loop and could close the panel that is mid-claim.
let claiming = false;

// Boot restores persisted open-state (backtest, live) before the user has
// touched anything. A claim during that window would run the other panel's
// closer, and those closers persist — a restore would silently wipe the saved
// state of a panel it never showed. Claims are inert until the app says boot
// is over.
let restoring = true;

/** The newcomer wins: close every other registered side panel. Call this
 *  immediately before flipping a panel's own state to open. */
export function claimSidePanel(id: SidePanelId): void {
  if (restoring || claiming) return;
  claiming = true;
  try {
    for (const [other, close] of closers) {
      if (other !== id) close();
    }
  } finally {
    claiming = false;
  }
}

/** Called once by App after it has resolved the persisted open-states, so that
 *  restore order can't trigger cross-panel closes. */
export function endSidePanelRestore(): void {
  restoring = false;
}

/** Tests only: back to a clean registry. */
export function resetSidePanelsForTest(): void {
  closers.clear();
  claiming = false;
  restoring = false;
}
