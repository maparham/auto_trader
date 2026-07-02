// TradingView-style multi-chart layout: renders the active tab's cells in a CSS
// grid (1 / 2-horizontal / 2-vertical / 3 / 4-quad). Each cell is an independent
// <ChartCore> with its own symbol/period/scope, keyed on cell.id so switching
// layouts remounts only the cells that actually change. The focused cell gets a
// thin accent ring (no drop-shadow, per project style).

import { useRef, useState, type CSSProperties } from "react";
import ChartCore from "./ChartCore";
import ContextMenu from "./ContextMenu";
import { DomPosition } from "klinecharts";
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
  onDetachCell: (cellId: string, target: "tab" | "window") => void;
  // Per-tab cell-size fractions (see ChartTab.sizes). Undefined = equal split.
  sizes?: { cols: number[]; rows: number[] };
  // Commit new fractions after a border drag.
  onSizes: (sizes: { cols: number[]; rows: number[] }) => void;
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
  sizes,
  onSizes,
}: Props) {
  // Right-click menu on a detach handle: which cell + where to anchor it.
  const [detachMenu, setDetachMenu] = useState<{ x: number; y: number; cellId: string } | null>(null);
  // The corner controls (detach/maximize) sit INSIDE the chart area, just left
  // of the price axis (TV-style) — anchored to the cell edge they'd cover the
  // axis labels. The axis width is dynamic (price magnitude / decimals), so
  // measure it from the cell's chart when the pointer enters the cell (the
  // buttons only reveal on hover anyway) and offset the buttons by it.
  const chartsRef = useRef(new Map<string, Chart>());
  const [axisW, setAxisW] = useState<Record<string, number>>({});
  const measureAxis = (cellId: string) => {
    const w = chartsRef.current.get(cellId)?.getSize("candle_pane", DomPosition.YAxis)?.width;
    if (w && w !== axisW[cellId]) setAxisW((m) => ({ ...m, [cellId]: w }));
  };
  // Fallback before the first measurement (chart not ready yet).
  const buttonRight = (cellId: string, slot: 0 | 1) => (axisW[cellId] ?? 56) + 6 + slot * 28;
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
        >
          {cells.length > 1 && (
            <button
              type="button"
              className="chart-cell-maximize chart-cell-detach"
              style={{ right: buttonRight(cell.id, 1) }}
              title="Open in new tab (⌘-click: browser tab, right-click: options)"
              aria-label="Open in new tab"
              onClick={(e) => {
                e.stopPropagation();
                // Ctrl/Cmd-click matches the browser's own "open link in new
                // tab" gesture → detach to a new BROWSER tab instead of in-app.
                onDetachCell(cell.id, e.metaKey || e.ctrlKey ? "window" : "tab");
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
      {detachMenu && (
        <ContextMenu
          x={detachMenu.x}
          y={detachMenu.y}
          items={[
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
    />
  );
}
