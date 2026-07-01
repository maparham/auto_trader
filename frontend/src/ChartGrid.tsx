// TradingView-style multi-chart layout: renders the active tab's cells in a CSS
// grid (1 / 2-horizontal / 2-vertical / 3 / 4-quad). Each cell is an independent
// <ChartCore> with its own symbol/period/scope, keyed on cell.id so switching
// layouts remounts only the cells that actually change. The focused cell gets a
// thin accent ring (no drop-shadow, per project style).

import ChartCore from "./ChartCore";
import type { Chart } from "klinecharts";
import type { ChartController } from "./lib/chartController";
import type { ChartCell, LayoutKind } from "./lib/persist";
import type { Period } from "./lib/feed";
import type { BidAsk, BidAskStyle, Clock, CrosshairStyle, DateFormat, PriceSide, Theme } from "./theme";

// CSS grid template per layout. "3" is three equal columns; "4" is a 2x2 quad.
const GRID: Record<LayoutKind, { columns: string; rows: string }> = {
  "1": { columns: "1fr", rows: "1fr" },
  "2h": { columns: "1fr 1fr", rows: "1fr" },
  "2v": { columns: "1fr", rows: "1fr 1fr" },
  "3": { columns: "1fr 1fr 1fr", rows: "1fr" },
  "4": { columns: "1fr 1fr", rows: "1fr 1fr" },
};

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
}: Props) {
  const baseGrid = GRID[layout] ?? GRID["1"];
  // Clamp to a cell that's actually in this render's set: the parent clears
  // maximizedCellId via an effect that commits one render after a layout
  // trim or tab switch can drop the id, so treat a dangling id as unmaximized
  // right here rather than blanking the whole grid for a frame.
  const validMaximizedCellId = cells.some((c) => c.id === maximizedCellId) ? maximizedCellId : null;
  // When a cell is maximized, collapse the grid to a single area; the maximized
  // cell fills it and siblings are display:none'd below.
  const grid = validMaximizedCellId ? { columns: "1fr", rows: "1fr" } : baseGrid;
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
        >
          {cells.length > 1 && (
            <button
              type="button"
              className="chart-cell-maximize"
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
            onReady={onReady}
            onFocus={onFocus}
            onPeriod={onPeriod}
          />
        </div>
        );
      })}
    </div>
  );
}
