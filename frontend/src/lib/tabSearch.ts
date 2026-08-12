// Matcher for the tab-bar "find open symbol" search: which open cells/tabs
// hold a symbol matching the query. Pure — UI state lives in TabBar/App.
import type { ChartCell, ChartTab } from "./persist";
import type { Instrument } from "./feed";

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

// Catalogue instruments matching the query — the search's fallback when no
// OPEN tab matches. Same case-insensitive epic/name `includes` semantics as
// the open-tab matcher above, so both stages of the search agree on what
// "matches" means.
export function catalogueMatches(
  all: Instrument[],
  query: string,
  limit = 8,
): Instrument[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [];
  const out: Instrument[] = [];
  for (const m of all) {
    if (m.epic.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)) {
      out.push(m);
      if (out.length >= limit) break;
    }
  }
  return out;
}
