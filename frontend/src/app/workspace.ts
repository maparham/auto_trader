// The workspace App boots into: the default instrument and period, fresh tab and
// cell ids, the effective per-tab sync flags, and resolveStartup's precedence
// for which saved workspace this device shows on launch.
import { PERIODS, type Instrument, type Period } from "../lib/feed";
import {
  primaryCellScope,
  getPersistBroker,
  loadLayouts,
  loadLayout,
  loadDefaultLayoutId,
  loadActiveLayoutId,
  hasExplicitScratchSelection,
  loadScratch,
  type ChartTab,
  type Workspace,
} from "../lib/persist";

export const DEFAULT_SYMBOL: Instrument = {
  epic: "US100",
  name: "US Tech 100",
  status: null,
  pricePrecision: 2,
};
export const DEFAULT_PERIOD: Period =
  PERIODS.find((p) => p.resolution === "HOUR") ?? PERIODS[0];

// Which chart tab is active is remembered PER BROWSER TAB (sessionStorage, so it
// survives a reload but isn't shared with sibling tabs) — see the activeId state.
export const ACTIVE_TAB_SESSION_KEY = "auto-trader.activeTabId";

// The first instrument a brand-new broker workspace opens on (each broker is an
// isolated instance with a FRESH START — no carry-over). Epics are broker-specific,
// so a per-broker default; pricePrecision is just a render seed (the chart fetches
// real market meta on mount). A synchronous map (not a network call) so the empty
// workspace renders instantly — see resolveStartup / the broker-switch handler.
const DEFAULT_SYMBOL_BY_BROKER: Record<string, Instrument> = {
  capital: DEFAULT_SYMBOL,
  "ig-demo": { epic: "CS.D.EURUSD.CFD.IP", name: "EUR/USD", status: null, pricePrecision: 5 },
  "ig-live": { epic: "CS.D.EURUSD.CFD.IP", name: "EUR/USD", status: null, pricePrecision: 5 },
};
export function defaultInstrument(broker: string): Instrument {
  return DEFAULT_SYMBOL_BY_BROKER[broker] ?? DEFAULT_SYMBOL;
}

let tabSeq = 0;
export function newTabId(): string {
  tabSeq += 1;
  return `tab-${Date.now().toString(36)}-${tabSeq}`;
}
let cellSeq = 0;
export function newCellId(): string {
  cellSeq += 1;
  return `cell-${Date.now().toString(36)}-${cellSeq}`;
}

// Effective per-tab sync flags. The "lock charts" master override doesn't mutate
// the four underlying toggles — it derives over them — so unlocking restores their
// prior state for free. Locked = interval/crosshair/date-range forced on (full
// mirror) and symbol forced off (each cell keeps its own instrument). Every place
// that consumes a sync flag reads through these instead of the raw field.
export const effectiveSyncSymbol = (t: ChartTab) => !t.locked && !!t.syncSymbol;
export const effectiveSyncInterval = (t: ChartTab) => !!t.locked || !!t.syncInterval;
export const effectiveSyncCrosshair = (t: ChartTab) => !!t.locked || !!t.syncCrosshair;
export const effectiveSyncTime = (t: ChartTab) => !!t.locked || !!t.syncTime;

// Build a one-cell tab. The first cell reuses the tab's primary scope (`tab.<id>`)
// so it lines up with the pre-cells / migrated key namespace.
export function makeTab(symbol: Instrument, period: Period): ChartTab {
  const id = newTabId();
  const cid = newCellId();
  return {
    id,
    layout: "1",
    activeCellId: cid,
    cells: [{ id: cid, symbol, period, scope: primaryCellScope(id) }],
  };
}

// A fresh single-tab workspace on `broker`'s default instrument — what a brand-new
// broker (no saved workspace) lands on, so the user sees a usable chart instead of a
// blank screen. Synchronous (no network) for an instant switch.
export function defaultWorkspace(broker: string): Workspace {
  const t = makeTab(defaultInstrument(broker), DEFAULT_PERIOD);
  return { tabs: [t], activeTabId: t.id };
}

// Resolve which workspace this device shows on launch. Precedence:
//   1. this device's last-open layout (activeLayoutId), if it still exists
//   2. the synced default layout, if set
//   3. the unsaved scratch workspace, if the user had one
//   4. a BRAND-NEW broker (no layouts, no scratch) -> a fresh default-symbol tab
//   5. otherwise blank (has layouts but none selected — pick one from the manager)
// Returns the workspace plus the active layout id (null = scratch/blank). Reads the
// ACTIVE broker's keys (persistBroker), so each broker resolves its own workspace.
export function resolveStartup(): { ws: Workspace; activeLayoutId: string | null } {
  const blank: Workspace = { tabs: [], activeTabId: "" };
  const layouts = loadLayouts();
  const known = new Set(layouts.map((l) => l.id));

  const activeId = loadActiveLayoutId();
  if (activeId && known.has(activeId)) {
    return { ws: loadLayout(activeId) ?? blank, activeLayoutId: activeId };
  }
  // THIS TAB explicitly chose scratch (session tombstone): the synced default
  // layout must not override that choice — skip rule 2 and fall through to the
  // scratch rules. Without this gate a scratch tab would be yanked onto the
  // default layout on every reload or sibling defaultLayoutId push.
  if (!hasExplicitScratchSelection()) {
    const defId = loadDefaultLayoutId();
    if (defId && known.has(defId)) {
      return { ws: loadLayout(defId) ?? blank, activeLayoutId: defId };
    }
  }
  const scratch = loadScratch();
  if (scratch && scratch.tabs.length > 0) {
    return { ws: scratch, activeLayoutId: null };
  }
  // Nothing saved for this broker at all → seed a default-symbol workspace so a
  // first-time broker lands on a usable chart (not a blank screen). If the broker
  // HAS layouts but none is selected, keep blank — the user picks one.
  if (layouts.length === 0) {
    return { ws: defaultWorkspace(getPersistBroker()), activeLayoutId: null };
  }
  return { ws: blank, activeLayoutId: null };
}
