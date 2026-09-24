// Focus (or open) a chart showing an epic: the one path for every opener that
// knows only an epic (alert navigation, the trade list, the trading dock's
// whole-book rows, the agent's market.select). App wires the deps to its tab
// state; pure otherwise, so the overlap cases are testable without React.
import type { ChartTab } from "./persist";
import type { Instrument } from "./feed";

export interface JumpResult {
  cellId: string;
  tabId: string;
  opened: boolean;
}

export interface EpicJumpDeps {
  /** Current tabs and active tab id. Must reflect this module's own writes
   * immediately (App writes its refs alongside state), or overlapping jumps
   * open the same epic twice. */
  tabs: () => ChartTab[];
  activeId: () => string;
  applyTabs: (fn: (ts: ChartTab[]) => ChartTab[]) => void;
  setActive: (id: string) => void;
  /** Append a new tab on `symbol` and make it active. */
  openTab: (symbol: Instrument) => ChartTab;
  /** epic -> Instrument (resolveInstrument, bound to the current broker). */
  resolve: (epic: string, precisionGuess: number) => Promise<Instrument>;
  isReplaying: (cellId: string) => boolean;
}

/** Focus a cell already showing `epic`, or null when none does. Search order:
 * the active tab first (its focused cell, then its other cells), then every
 * other tab, so a chart already on screen is reused before we touch tabs the
 * user can't see. */
export function focusOpenEpic(deps: EpicJumpDeps, epic: string): JumpResult | null {
  const tabs = deps.tabs();
  const active = tabs.find((t) => t.id === deps.activeId());
  const ordered = active ? [active, ...tabs.filter((t) => t.id !== active.id)] : tabs;
  for (const t of ordered) {
    const lead = t.cells.find((c) => c.id === t.activeCellId);
    const cells = lead ? [lead, ...t.cells.filter((c) => c.id !== lead.id)] : t.cells;
    const hit = cells.find((c) => c.symbol.epic === epic);
    if (hit) {
      // Focus that cell so the chrome (and the panel's "current chart" scope)
      // follow it, and bring its tab to the front.
      deps.applyTabs((ts) => ts.map((tt) => (tt.id === t.id ? { ...tt, activeCellId: hit.id } : tt)));
      deps.setActive(t.id);
      return { cellId: hit.id, tabId: t.id, opened: false };
    }
  }
  return null;
}

/** Trade-list same-tab mode's one reusable tab. `get` is read after the
 * catalogue wait; `opened` records a tab this jump created or re-pointed,
 * synchronously, so a jump queued right behind this one reuses it (a caller
 * recording from the returned promise would be a microtask too late). */
export interface ReuseSlot {
  get: () => string | null;
  opened: (tabId: string) => void;
}

/** An epic already open is focused at once, with no network. Otherwise the
 * epic resolves through the broker catalogue, so the new chart carries its
 * real name and type; `precisionGuess` only fills in when the row has none.
 * `reuse` (trade-list same-tab mode, see ReuseSlot): when the epic is open
 * nowhere and the slot's tab still exists, its active cell
 * SWITCHES SYMBOL to the epic instead of a new tab opening, unless that cell
 * is mid-replay (silently killing a session is worse than an extra tab). */
export async function jumpToEpic(
  deps: EpicJumpDeps,
  epic: string,
  precisionGuess = 2,
  reuse?: ReuseSlot,
): Promise<JumpResult> {
  const open = focusOpenEpic(deps, epic);
  if (open) return open;
  const symbol = await deps.resolve(epic, precisionGuess);
  // A concurrent jump may have opened it while the catalogue loaded.
  const raced = focusOpenEpic(deps, epic);
  if (raced) return raced;
  const reuseTabId = reuse?.get();
  if (reuseTabId) {
    const rt = deps.tabs().find((t) => t.id === reuseTabId);
    const cell = rt ? rt.cells.find((c) => c.id === rt.activeCellId) ?? rt.cells[0] : undefined;
    if (rt && cell && !deps.isReplaying(cell.id)) {
      deps.applyTabs((ts) =>
        ts.map((tt) =>
          tt.id !== rt.id
            ? tt
            : { ...tt, cells: tt.cells.map((c) => (c.id === cell.id ? { ...c, symbol } : c)) },
        ),
      );
      deps.setActive(rt.id);
      reuse?.opened(rt.id);
      return { cellId: cell.id, tabId: rt.id, opened: true };
    }
  }
  const t = deps.openTab(symbol);
  reuse?.opened(t.id);
  return { cellId: t.cells[0].id, tabId: t.id, opened: true };
}
