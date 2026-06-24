// Per-tab crosshair broadcaster (TradingView's "link" crosshair). The cell under
// the cursor publishes the hovered bar timestamp (or null on leave); sibling cells
// in the SAME tab paint a vertical time guide at that timestamp on their overlay
// canvas. Keyed by tab id so other tabs are unaffected. Mirrors the module-
// singleton idiom of mtfCoordinator — pure pub/sub, no React.
//
// Why a custom guide (not a real crosshair): klinecharts v9 exposes no public API
// to set the crosshair position programmatically (executeAction only fires the
// subscription callbacks, it doesn't draw), so each sibling draws the line itself
// using the same overlay canvas it already uses for the "+" affordance crosshair.

export interface CrosshairMsg {
  sourceCellId: string;
  timestamp: number | null; // null = cursor left the source chart
}

type Listener = (m: CrosshairMsg) => void;

class ChartSync {
  private byTab = new Map<string, Set<Listener>>();

  subscribe(tabId: string, fn: Listener): () => void {
    let set = this.byTab.get(tabId);
    if (!set) {
      set = new Set();
      this.byTab.set(tabId, set);
    }
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (set!.size === 0) this.byTab.delete(tabId);
    };
  }

  publish(tabId: string, msg: CrosshairMsg): void {
    const set = this.byTab.get(tabId);
    if (!set) return;
    for (const fn of set) fn(msg);
  }
}

export const chartSync = new ChartSync();
