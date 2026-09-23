// Horizontally scrollable strip mirroring the desktop's saved layout: one chip
// per desktop chart cell, grouped by tab (divider between tabs). Read-only —
// tapping a chip shows that cell's chart (exact scope, so its drawings and
// indicators) without ever writing the desktop workspace.
//
// A leading magnifier is the mobile twin of the desktop tab-bar "find open
// symbol" search: typing filters the chips to matching cells (same matcher as
// desktop), Enter or a tap opens one, and a query with no open match offers
// the full symbol search instead.
import { useState, useSyncExternalStore } from "react";
import {
  mirroredWorkspace,
  flattenCells,
  mobileWorkspaceVersion,
  type FlatCell,
} from "./mobileWorkspace";
import { mobileChartScope, mobilePeriod, setMobileSymbol } from "./mobileChartState";
import { matchingCellIds } from "../lib/tabSearch";
import { requestSymbolSearch } from "../lib/signals";

export default function MobileChartStrip() {
  useSyncExternalStore(
    (fn) => mobileWorkspaceVersion.subscribe(fn),
    () => mobileWorkspaceVersion.value,
  );
  const scope = useSyncExternalStore(
    (fn) => mobileChartScope.subscribe(fn),
    () => mobileChartScope.value,
  );
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");

  const mirror = mirroredWorkspace();
  if (!mirror) return null;
  const all = flattenCells(mirror.ws);
  if (!all.length) return null;

  const closeSearch = () => {
    setSearchOpen(false);
    setQuery("");
  };
  const open = (f: FlatCell) => {
    setMobileSymbol(f.cell.symbol, undefined, f.cell.scope);
    mobilePeriod.set(f.cell.period);
    closeSearch();
  };

  // Cell ids are only unique within a tab, so hits are keyed by tab index too.
  const filtering = searchOpen && query.trim() !== "";
  const hits = new Set(
    mirror.ws.tabs.flatMap((t, ti) => matchingCellIds(t, query).map((id) => `${ti}:${id}`)),
  );
  const cells = filtering ? all.filter((f) => hits.has(`${f.tabIndex}:${f.cell.id}`)) : all;

  return (
    <div className="m-chart-strip" role="tablist" aria-label={`Layout: ${mirror.name}`}>
      {all.length > 1 && (
        searchOpen ? (
          <span className="m-chart-strip-search">
            <input
              type="search"
              className="m-chart-strip-input"
              placeholder="Find chart"
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && filtering && cells.length) open(cells[0]);
                else if (e.key === "Escape") closeSearch();
              }}
            />
            <button className="m-chart-strip-icon" aria-label="Close search" onClick={closeSearch}>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none"
                   stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          </span>
        ) : (
          <button
            className="m-chart-strip-icon"
            aria-label="Find open chart"
            onClick={() => setSearchOpen(true)}
          >
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none"
                 stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
          </button>
        )
      )}
      {filtering && cells.length === 0 && (
        <span className="m-chart-strip-empty">
          No open chart
          <button
            className="m-chart-strip-chip"
            onClick={() => {
              closeSearch();
              requestSymbolSearch();
            }}
          >
            Search all symbols
          </button>
        </span>
      )}
      {cells.map((f, i) => {
        const active = scope?.scope === f.cell.scope && scope?.epic === f.cell.symbol.epic;
        const newTab = i > 0 && cells[i - 1].tabIndex !== f.tabIndex;
        return (
          <span key={f.cell.scope + f.cell.symbol.epic} className="m-chart-strip-group">
            {newTab && <span className="m-chart-strip-divider" aria-hidden />}
            <button
              className={"m-chart-strip-chip" + (active ? " active" : "")}
              onClick={() => open(f)}
            >
              {f.cell.symbol.epic} {f.cell.period.label}
            </button>
          </span>
        );
      })}
    </div>
  );
}
