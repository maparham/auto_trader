// TradingView-style multi-chart layout: renders the active tab's cells in a CSS
// grid (1 / 2-horizontal / 2-vertical / 3 / 4-quad). Each cell is an independent
// <ChartCore> with its own symbol/period/scope, keyed on cell.id so switching
// layouts remounts only the cells that actually change. The focused cell gets a
// thin accent ring (no drop-shadow, per project style).

import ChartCore from "./ChartCore";
import type { Chart } from "klinecharts";
import type { ChartController } from "./lib/chartController";
import type { ChartCell, LayoutKind } from "./lib/persist";
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
}: Props) {
  const grid = GRID[layout] ?? GRID["1"];
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
      {cells.map((cell) => (
        <div
          key={cell.id}
          className={`chart-cell${
            cell.id === focusedCellId && cells.length > 1 ? " focused" : ""
          }`}
        >
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
            // Crosshair link only matters with >1 cell.
            syncCrosshair={syncCrosshair && cells.length > 1}
            // Date-range link only matters with >1 cell.
            syncTime={syncTime && cells.length > 1}
            // Lock's exact-mirror barSpace only matters with >1 cell.
            locked={locked && cells.length > 1}
            onReady={onReady}
            onFocus={onFocus}
          />
        </div>
      ))}
    </div>
  );
}
