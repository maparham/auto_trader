// TradingView-style multi-chart layout: renders the active tab's cells in a CSS
// grid (1 / 2-horizontal / 2-vertical / 3 / 4-quad). Each cell is an independent
// <ChartCore> with its own symbol/period/scope, keyed on cell.id so switching
// layouts remounts only the cells that actually change. The focused cell gets a
// thin accent ring (no drop-shadow, per project style).

import { useEffect, useRef, useState, type CSSProperties } from "react";
import ChartCore from "./ChartCore";
import ContextMenu from "./ContextMenu";
import type { Chart } from "klinecharts";
import type { ChartController } from "./lib/chartController";
import type { ChartCell, LayoutKind } from "./lib/persist";
import type { Period } from "./lib/feed";
import type { BidAsk, BidAskStyle, Clock, CrosshairStyle, DateFormat, PriceSide, Theme } from "./theme";

// Grid shape (column x row counts) per layout kind. Templates are derived from
// per-tab size fractions (equal split when none saved).
const SHAPE: Record<LayoutKind, { cols: number; rows: number }> = {
  "1": { cols: 1, rows: 1 },
  "2h": { cols: 2, rows: 1 },
  "2v": { cols: 1, rows: 2 },
  "3": { cols: 3, rows: 1 },
  "4": { cols: 2, rows: 2 },
};

// Saved fractions if they match this layout's shape, else an equal split.
function fracs(saved: number[] | undefined, count: number): number[] {
  if (saved && saved.length === count && saved.every((f) => f > 0)) return saved;
  return Array(count).fill(1 / count);
}
const template = (f: number[]) => f.map((v) => `${v}fr`).join(" ");

interface Props {
  tabId: string;
  cells: ChartCell[];
  layout: LayoutKind;
  focusedCellId: string;
  // Active data broker id ("capital") — every cell's feed is fetched against it.
  brokerId: string;
  theme: Theme;
  // IANA timezone for the chart time axis ("" = browser local).
  timezone: string;
  // Time-axis timestamp format (clock + date format).
  clock: Clock;
  dateFormat: DateFormat;
  // Prefix day-granularity timestamps with the weekday. Global.
  showWeekday: boolean;
  // Which side of the spread candles render from (bid/mid/ask). Global.
  priceSide: PriceSide;
  // Live bid & ask display: off / labels / lines. Global.
  bidAsk: BidAsk;
  // Colors / line opacity / line style for the bid & ask display. Global.
  bidAskStyle: BidAskStyle;
  // Crosshair guide-line appearance (style/color/opacity). Global.
  crosshair: CrosshairStyle;
  // Per-tab crosshair-link toggle (drives the cross-cell vertical time guide).
  syncCrosshair: boolean;
  // Per-tab date-range link: scroll/zoom in one cell matches the time window on the others.
  syncTime: boolean;
  // "Lock charts" master mode: full mirroring with pixel-exact (barSpace) date range.
  locked: boolean;
  onReady: (cellId: string, chart: Chart, controller: ChartController) => void;
  onFocus: (cellId: string) => void;
  onPeriod: (cellId: string, p: Period) => void;
  // Per-cell maximize: the id of the cell expanded to fill the grid, or null.
  maximizedCellId: string | null;
  // Toggle maximize for a cell (maximize if none/other, restore if it's this one).
  onToggleMaximizeCell: (cellId: string) => void;
  // Detach a cell to a new tab ("tab" = in-app, "window" = new browser tab).
  onDetachCell: (cellId: string, target: "move" | "tab" | "window") => void;
  // Close a cell (removes it from the layout; App confirms + downgrades the kind).
  onCloseCell: (cellId: string) => void;
  // Swap two adjacent cells' positions (border ↔/↕ buttons).
  onSwapCells: (idA: string, idB: string) => void;
  // Per-tab cell-size fractions (see ChartTab.sizes). Undefined = equal split.
  sizes?: { cols: number[]; rows: number[] };
  // Commit new fractions after a border drag.
  onSizes: (sizes: { cols: number[]; rows: number[] }) => void;
  // A tab chip is being dragged over the app (merge gesture): show a two-half
  // drop overlay. canMerge=false renders a "would exceed" notice instead of
  // droppable halves. Absent/null = no drag in flight.
  tabDrag?: { canMerge: boolean } | null;
  onMergeDrop?: (position: "before" | "after") => void;
}

export default function ChartGrid({
  tabId,
  cells,
  layout,
  focusedCellId,
  brokerId,
  theme,
  timezone,
  clock,
  dateFormat,
  showWeekday,
  priceSide,
  bidAsk,
  bidAskStyle,
  crosshair,
  syncCrosshair,
  syncTime,
  locked,
  onReady,
  onFocus,
  onPeriod,
  maximizedCellId,
  onToggleMaximizeCell,
  onDetachCell,
  onCloseCell,
  onSwapCells,
  sizes,
  onSizes,
  tabDrag,
  onMergeDrop,
}: Props) {
  // Right-click menu on a detach handle: which cell + where to anchor it.
  const [detachMenu, setDetachMenu] = useState<{ x: number; y: number; cellId: string } | null>(null);
  // Which overlay half the chip drag is over (highlight), or null.
  const [mergeHover, setMergeHover] = useState<"before" | "after" | null>(null);
  // A new drag session (or none at all) must never inherit the previous
  // session's highlighted half — e.g. TabBar strands its own drag state when
  // a chip merges away mid-gesture (see TabBar.tsx), so App can drop tabDrag
  // to null without this component ever seeing a drop/dragleave to clear it.
  useEffect(() => {
    if (!tabDrag) setMergeHover(null);
  }, [tabDrag]);
  // The corner controls (detach/maximize) sit INSIDE the chart area, just left
  // of the price axis (TV-style) — anchored to the cell edge they'd cover the
  // axis labels. The axis width is dynamic (price magnitude / decimals), so
  // measure it from the cell's chart while the pointer is over the cell (the
  // buttons only reveal on hover anyway) and offset the buttons by it. Entry
  // alone isn't enough: a symbol switch or precision change can widen the axis
  // WITHOUT the pointer ever leaving the cell, so mousemove re-measures too
  // (throttled; setState only fires on an actual width change).
  const chartsRef = useRef(new Map<string, Chart>());
  const [axisW, setAxisW] = useState<Record<string, number>>({});
  const lastMeasure = useRef(0);
  const measureAxis = (cellId: string) => {
    const w = chartsRef.current.get(cellId)?.getSize("candle_pane", 'yAxis')?.width;
    if (w && w !== axisW[cellId]) setAxisW((m) => ({ ...m, [cellId]: w }));
  };
  // Drop measurements/chart handles for cells no longer in this tab (detach /
  // layout trim) — ChartGrid only remounts on tab switch, so within a tab
  // these maps would otherwise retain dead Chart instances.
  useEffect(() => {
    const live = new Set(cells.map((c) => c.id));
    for (const id of chartsRef.current.keys()) if (!live.has(id)) chartsRef.current.delete(id);
    setAxisW((m) => {
      const stale = Object.keys(m).filter((id) => !live.has(id));
      if (stale.length === 0) return m;
      const next = { ...m };
      for (const id of stale) delete next[id];
      return next;
    });
  }, [cells]);
  // Fallback before the first measurement (chart not ready yet) — empirical
  // typical axis width, not guaranteed to clear every symbol on first paint;
  // the first hover corrects it.
  const buttonRight = (cellId: string, slot: 0 | 1 | 2) => (axisW[cellId] ?? 56) + 6 + slot * 28;
  // Clamp to a cell that's actually in this render's set: the parent clears
  // maximizedCellId via an effect that commits one render after a layout
  // trim or tab switch can drop the id, so treat a dangling id as unmaximized
  // right here rather than blanking the whole grid for a frame.
  const validMaximizedCellId = cells.some((c) => c.id === maximizedCellId) ? maximizedCellId : null;
  const shape = SHAPE[layout] ?? SHAPE["1"];
  // Live fractions during a border drag (uncommitted); null when not dragging.
  // Committing to the tab on every mousemove would spam the layout autosave
  // (localStorage + backend mirror), so the drag renders from local state and
  // onSizes fires once on release.
  const [dragSizes, setDragSizes] = useState<{ cols: number[]; rows: number[] } | null>(null);
  const eff = dragSizes ?? sizes;
  const colFracs = fracs(eff?.cols, shape.cols);
  const rowFracs = fracs(eff?.rows, shape.rows);
  // When a cell is maximized, collapse the grid to a single area; the maximized
  // cell fills it and siblings are display:none'd below.
  const grid = validMaximizedCellId
    ? { columns: "1fr", rows: "1fr" }
    : { columns: template(colFracs), rows: template(rowFracs) };
  return (
    <div
      className="chart-grid"
      style={{
        display: "grid",
        gridTemplateColumns: grid.columns,
        gridTemplateRows: grid.rows,
        width: "100%",
        height: "100%",
      }}
    >
      {cells.map((cell) => {
        const isMax = cell.id === validMaximizedCellId;
        const hidden = validMaximizedCellId !== null && !isMax;
        return (
        <div
          key={cell.id}
          className={`chart-cell${
            cell.id === focusedCellId && cells.length > 1 ? " focused" : ""
          }${isMax ? " maximized" : ""}`}
          style={{ display: hidden ? "none" : undefined }}
          onMouseEnter={() => measureAxis(cell.id)}
          onMouseMove={(e) => {
            if (e.timeStamp - lastMeasure.current < 200) return;
            lastMeasure.current = e.timeStamp;
            measureAxis(cell.id);
          }}
        >
          {cells.length > 1 && (
            <button
              type="button"
              className="chart-cell-maximize chart-cell-detach"
              style={{ right: buttonRight(cell.id, 1) }}
              title="Detach in new tab (⌘-click: open copy in browser tab, right-click: options)"
              aria-label="Detach in new tab"
              onClick={(e) => {
                e.stopPropagation();
                // Ctrl/Cmd-click matches the browser's own "open link in new
                // tab" gesture → open a copy in a new BROWSER tab instead.
                onDetachCell(cell.id, e.metaKey || e.ctrlKey ? "window" : "move");
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setDetachMenu({ x: e.clientX, y: e.clientY, cellId: cell.id });
              }}
            >
              {/* open-in-new: box with an arrow pointing out the top-right */}
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M7 3H3v10h10V9" />
                <path d="M9 3h4v4" />
                <path d="M13 3L7.5 8.5" />
              </svg>
            </button>
          )}
          {cells.length > 1 && (
            <button
              type="button"
              className="chart-cell-maximize"
              style={{ right: buttonRight(cell.id, 0) }}
              title={isMax ? "Restore" : "Maximize"}
              aria-label={isMax ? "Restore" : "Maximize"}
              onClick={(e) => {
                e.stopPropagation();
                // The button lives outside ChartCore's own focus-on-pointerdown
                // subtree, so focus this cell explicitly — otherwise maximizing
                // a non-focused cell leaves the Toolbar/alerts bound to whatever
                // was focused before, even though it's now hidden.
                onFocus(cell.id);
                onToggleMaximizeCell(cell.id);
              }}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                {isMax ? (
                  // restore: inward arrows
                  <>
                    <path d="M9 3v4h4" />
                    <path d="M7 13V9H3" />
                    <path d="M13 3l-4 4" />
                    <path d="M3 13l4-4" />
                  </>
                ) : (
                  // maximize: outward expand arrows
                  <>
                    <path d="M6 2H2v4" />
                    <path d="M10 14h4v-4" />
                    <path d="M2 2l5 5" />
                    <path d="M14 14l-5-5" />
                  </>
                )}
              </svg>
            </button>
          )}
          {cells.length > 1 && (
            <button
              type="button"
              className="chart-cell-maximize chart-cell-close"
              style={{ right: buttonRight(cell.id, 2) }}
              title="Close chart"
              aria-label="Close chart"
              onClick={(e) => {
                e.stopPropagation();
                onCloseCell(cell.id);
              }}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <path d="M4 4l8 8" />
                <path d="M12 4l-8 8" />
              </svg>
            </button>
          )}
          <ChartCore
            cellId={cell.id}
            tabId={tabId}
            scope={cell.scope}
            symbol={cell.symbol}
            brokerId={brokerId}
            period={cell.period}
            theme={theme}
            timezone={timezone}
            clock={clock}
            dateFormat={dateFormat}
            showWeekday={showWeekday}
            priceSide={priceSide}
            bidAsk={bidAsk}
            bidAskStyle={bidAskStyle}
            crosshair={crosshair}
            // Crosshair link only matters with >1 cell, and not while a cell is
            // maximized (siblings are hidden — no visible receiver to sync).
            syncCrosshair={syncCrosshair && cells.length > 1 && !validMaximizedCellId}
            // Date-range link only matters with >1 cell.
            syncTime={syncTime && cells.length > 1 && !validMaximizedCellId}
            // Lock's exact-mirror barSpace only matters with >1 cell.
            locked={locked && cells.length > 1 && !validMaximizedCellId}
            onReady={(id, chart, controller) => {
              chartsRef.current.set(id, chart);
              onReady(id, chart, controller);
            }}
            onFocus={onFocus}
            onPeriod={onPeriod}
          />
        </div>
        );
      })}
      {/* Border-drag strips on internal grid lines (hidden while maximized). */}
      {!validMaximizedCellId &&
        Array.from({ length: shape.cols - 1 }, (_, i) => (
          <ResizeStrip
            key={`c${i + 1}`}
            axis="cols"
            line={i + 1}
            colFracs={colFracs}
            rowFracs={rowFracs}
            onLive={setDragSizes}
            onCommit={(s) => {
              setDragSizes(null);
              onSizes(s);
            }}
            onCancel={() => setDragSizes(null)}
          />
        ))}
      {!validMaximizedCellId &&
        Array.from({ length: shape.rows - 1 }, (_, i) => (
          <ResizeStrip
            key={`r${i + 1}`}
            axis="rows"
            line={i + 1}
            colFracs={colFracs}
            rowFracs={rowFracs}
            onLive={setDragSizes}
            onCommit={(s) => {
              setDragSizes(null);
              onSizes(s);
            }}
            onCancel={() => setDragSizes(null)}
          />
        ))}
      {/* Border swap buttons: one per adjacent cell pair, centered on the
          shared border SEGMENT (per row for vertical borders, per column for
          horizontal ones — a 2×2 gets four). Clicking swaps the two cells;
          identity travels with the cell, layout kind and track sizes stay put.
          Cells are placed row-major, so (row r, col c) = cells[r*cols + c].
          Hidden while a cell is maximized, same as the strips. Rendered AFTER
          the strips so the sibling-hover reveal in App.css matches. */}
      {!validMaximizedCellId &&
        Array.from({ length: shape.rows }, (_, r) =>
          Array.from({ length: shape.cols - 1 }, (_, i) => {
            const c = i + 1;
            const a = cells[r * shape.cols + c - 1];
            const b = cells[r * shape.cols + c];
            if (!a || !b) return null;
            const left = colFracs.slice(0, c).reduce((s, v) => s + v, 0) * 100;
            const top =
              (rowFracs.slice(0, r).reduce((s, v) => s + v, 0) + rowFracs[r] / 2) * 100;
            return (
              <button
                key={`swap-c${c}-r${r}`}
                type="button"
                className="cell-swap cols"
                data-line={`cols-${c}`}
                style={{ left: `calc(${left}% - 12px)`, top: `calc(${top}% - 12px)` }}
                title="Swap charts"
                aria-label="Swap charts"
                onClick={(e) => {
                  e.stopPropagation();
                  onSwapCells(a.id, b.id);
                }}
              >
                {/* ↔ two-way arrow */}
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 8h10" />
                  <path d="M6 5L3 8l3 3" />
                  <path d="M10 5l3 3-3 3" />
                </svg>
              </button>
            );
          }),
        )}
      {!validMaximizedCellId &&
        Array.from({ length: shape.rows - 1 }, (_, i) =>
          Array.from({ length: shape.cols }, (_, c) => {
            const r = i + 1;
            const a = cells[(r - 1) * shape.cols + c];
            const b = cells[r * shape.cols + c];
            if (!a || !b) return null;
            const top = rowFracs.slice(0, r).reduce((s, v) => s + v, 0) * 100;
            const left =
              (colFracs.slice(0, c).reduce((s, v) => s + v, 0) + colFracs[c] / 2) * 100;
            return (
              <button
                key={`swap-r${r}-c${c}`}
                type="button"
                className="cell-swap rows"
                data-line={`rows-${r}`}
                style={{ left: `calc(${left}% - 12px)`, top: `calc(${top}% - 12px)` }}
                title="Swap charts"
                aria-label="Swap charts"
                onClick={(e) => {
                  e.stopPropagation();
                  onSwapCells(a.id, b.id);
                }}
              >
                {/* ↕ two-way arrow */}
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 3v10" />
                  <path d="M5 6l3-3 3 3" />
                  <path d="M5 10l3 3 3-3" />
                </svg>
              </button>
            );
          }),
        )}
      {tabDrag && (
        <div
          className="merge-drop"
          // Halves follow the grid's main axis: side-by-side layouts split
          // left/right, stacked ones top/bottom.
          style={{ flexDirection: shape.rows === 1 ? "row" : "column" }}
        >
          {tabDrag.canMerge ? (
            (["before", "after"] as const).map((pos) => (
              // Only the centered TARGET box accepts the drop; the dead border
              // around it restores the pre-overlay escape hatch — releasing a
              // chip there cancels the drag instead of merging, so an
              // abandoned reorder can't destroy a tab.
              <div key={pos} className="merge-drop-half">
                <div
                  className={`merge-drop-target${mergeHover === pos ? " over" : ""}`}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    if (mergeHover !== pos) setMergeHover(pos);
                  }}
                  onDragLeave={() => setMergeHover((h) => (h === pos ? null : h))}
                  onDrop={(e) => {
                    e.preventDefault();
                    setMergeHover(null);
                    onMergeDrop?.(pos);
                  }}
                />
              </div>
            ))
          ) : (
            <div className="merge-drop-blocked">Would exceed 4 charts</div>
          )}
        </div>
      )}
      {detachMenu && (
        <ContextMenu
          x={detachMenu.x}
          y={detachMenu.y}
          items={[
            { label: "Detach in new tab", onClick: () => onDetachCell(detachMenu.cellId, "move") },
            { label: "Open in new tab", onClick: () => onDetachCell(detachMenu.cellId, "tab") },
            { label: "Open in new browser tab", onClick: () => onDetachCell(detachMenu.cellId, "window") },
          ]}
          onClose={() => setDetachMenu(null)}
        />
      )}
    </div>
  );
}

// One invisible drag strip on an internal grid line. `axis` picks columns vs
// rows; `line` is the 1-based grid-line index (between fracs[line-1] and
// fracs[line]). Drag updates a local copy of the fractions (parent renders
// them live via dragSizes) and commits once on release.
function ResizeStrip({
  axis,
  line,
  colFracs,
  rowFracs,
  onLive,
  onCommit,
  onCancel,
}: {
  axis: "cols" | "rows";
  line: number;
  colFracs: number[];
  rowFracs: number[];
  onLive: (s: { cols: number[]; rows: number[] }) => void;
  onCommit: (s: { cols: number[]; rows: number[] }) => void;
  // Fires on pointercancel (touch cancel / OS gesture takeover) — live-drag
  // state must be cleared WITHOUT committing the half-finished gesture.
  onCancel: () => void;
}) {
  const MIN = 0.15; // no cell below 15% of the grid
  const f = axis === "cols" ? colFracs : rowFracs;
  // Strip center sits at the cumulative fraction of the preceding tracks.
  const at = f.slice(0, line).reduce((a, b) => a + b, 0) * 100;
  const pos: CSSProperties =
    axis === "cols"
      ? { left: `calc(${at}% - 4px)`, top: 0, bottom: 0, width: 8, cursor: "col-resize" }
      : { top: `calc(${at}% - 4px)`, left: 0, right: 0, height: 8, cursor: "row-resize" };
  return (
    <div
      className={`cell-resize-strip ${axis}`}
      data-line={`${axis}-${line}`}
      style={pos}
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        const rect = el.parentElement!.getBoundingClientRect();
        const total = axis === "cols" ? rect.width : rect.height;
        const start = axis === "cols" ? e.clientX : e.clientY;
        const f0 = [...f];
        let latest: { cols: number[]; rows: number[] } | null = null;
        const apply = (ev: PointerEvent) => {
          const d = ((axis === "cols" ? ev.clientX : ev.clientY) - start) / total;
          const next = [...f0];
          // Clamp so BOTH neighbors stay >= MIN.
          const dd = Math.max(MIN - f0[line - 1], Math.min(f0[line] - MIN, d));
          next[line - 1] = f0[line - 1] + dd;
          next[line] = f0[line] - dd;
          latest = axis === "cols"
            ? { cols: next, rows: rowFracs }
            : { cols: colFracs, rows: next };
          onLive(latest);
        };
        const cleanup = () => {
          el.removeEventListener("pointermove", apply);
          el.removeEventListener("pointerup", up);
          el.removeEventListener("pointercancel", cancel);
        };
        const up = () => {
          cleanup();
          if (latest) onCommit(latest);
        };
        // Touch cancel / OS gesture takeover: drop the gesture, don't commit.
        const cancel = () => {
          cleanup();
          onCancel();
        };
        el.addEventListener("pointermove", apply);
        el.addEventListener("pointerup", up);
        el.addEventListener("pointercancel", cancel);
      }}
      onDoubleClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        // TV-style instant reset: split the two tracks this strip separates
        // evenly, preserving their combined fraction so other tracks are
        // unaffected. Commits through the same onSizes path a drag uses.
        const half = (f[line - 1] + f[line]) / 2;
        const next = [...f];
        next[line - 1] = half;
        next[line] = half;
        onCommit(
          axis === "cols" ? { cols: next, rows: rowFracs } : { cols: colFracs, rows: next }
        );
      }}
    />
  );
}
