// Matcher for the tab-bar "find open symbol" search: which open cells/tabs
// hold a symbol matching the query. Pure — UI state lives in TabBar/App.
import type { ChartCell, ChartTab } from "./persist";

function cellMatches(cell: ChartCell, q: string): boolean {
  return (
    cell.symbol.epic.toLowerCase().includes(q) ||
    (cell.symbol.name ?? "").toLowerCase().includes(q)
  );
}

// Ids of the tab's cells whose symbol epic or name contains the query
// (case-insensitive). Empty/whitespace query matches nothing.
export function matchingCellIds(tab: ChartTab, query: string): string[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [];
  return tab.cells.filter((c) => cellMatches(c, q)).map((c) => c.id);
}

// Ids of tabs containing at least one matching cell.
export function matchingTabIds(tabs: ChartTab[], query: string): Set<string> {
  return new Set(
    tabs.filter((t) => matchingCellIds(t, query).length > 0).map((t) => t.id),
  );
}
