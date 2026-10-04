// Horizontally scrollable strip mirroring the desktop's saved layout: one chip
// per desktop chart cell, grouped by tab (divider between tabs). Tapping a chip
// shows that cell's chart (exact scope, so its drawings and indicators) without
// ever writing the desktop workspace.
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
  lastCellByTab,
  type FlatCell,
} from "./mobileWorkspace";
import { mobileChartScope, mobilePeriod, setMobileSymbol } from "./mobileChartState";
import { matchingCellIds } from "../lib/tabSearch";
import { requestSymbolSearch } from "../lib/signals";
import { startPullDrag, startSwipePull } from "./usePullPanel";

export default function MobileChartStrip({
  overviewOpen = false,
  onPull,
  onPullEnd,
}: {
  overviewOpen?: boolean;
  onPull?(dy: number): void;
  onPullEnd?(dy: number): void;
}) {
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

  const bar = (
    <button
      className="m-chart-strip-pull"
      aria-label="Show all tabs"
      aria-expanded={overviewOpen}
      onPointerDown={(e) => startPullDrag(e, onPull, onPullEnd)}
      onClick={(e) => {
        if (e.detail === 0) onPullEnd?.(0);
      }}
    >
      <span className="m-chart-strip-pull-i">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none"
             stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d={overviewOpen ? "M6 15l6-6 6 6" : "M6 9l6 6 6-6"} />
        </svg>
      </span>
    </button>
  );

  const mirror = mirroredWorkspace();
  // A downward swipe anywhere on the row opens the overview too; the handle
  // and the search field run their own pointer handling.
  const onRowPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.target instanceof Element && e.target.closest(".m-chart-strip-pull, input")) return;
    startSwipePull(e, onPull, onPullEnd);
  };
  // The handle and search sit at the strip's right end, so they never cost a row.
  const bare = (
    <div className="m-chart-strip" onPointerDown={onRowPointerDown}>
      <span className="m-chart-strip-lead">{bar}</span>
    </div>
  );
  if (!mirror) return bare;
  const all = flattenCells(mirror.ws);
  if (!all.length) return bare;

  const closeSearch = () => {
    setSearchOpen(false);
    setQuery("");
  };
  const open = (f: FlatCell) => {
    setMobileSymbol(f.cell.symbol, undefined, f.cell.scope);
    mobilePeriod.set(f.cell.period);
    lastCellByTab.set(mirror.ws.tabs[f.tabIndex].id, mirror.ws.tabs[f.tabIndex].cells.indexOf(f.cell));
    closeSearch();
  };

  // Cell ids are only unique within a tab, so hits are keyed by tab index too.
  const filtering = searchOpen && query.trim() !== "";
  const hits = new Set(
    mirror.ws.tabs.flatMap((t, ti) => matchingCellIds(t, query).map((id) => `${ti}:${id}`)),
  );
  const cells = filtering ? all.filter((f) => hits.has(`${f.tabIndex}:${f.cell.id}`)) : all;

  return (
    <>
      <div className="m-chart-strip" role="tablist" aria-label={`Layout: ${mirror.name}`} onPointerDown={onRowPointerDown}>
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
        <span className="m-chart-strip-lead">
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
          {bar}
        </span>
      </div>
    </>
  );
}
