// Per-trade dashes for a backtest viewed on a timeframe COARSER than its own:
// the aggregate pills (BacktestAggMarkers) say how many trades a bar holds, but
// not WHERE — these tiny ticks sit on the candle body/wick at each trade's
// entry price, offset through the candle's width by the entry's time within
// the bar, so a 5m run viewed on 4h shows where on each 4h candle the trades
// concentrated. Same DOM-layer idiom as BacktestAggMarkers (imperative handle
// fed by ChartCore's redraw loop; DOM, not klinecharts overlays, for reliable
// hover on tiny figures).
//
// Hover: a trade spanning ≥2 display candles sets highlightTradeSignal (the
// existing transient entry→exit segment overlay) — but only when this dash's
// result IS the panel-active one (highlightTradeSignal carries a bare index,
// and the subscriber resolves it against the ACTIVE result, so publishing from
// a non-active cell would light up the wrong trade elsewhere; same gate the
// native marker hover uses). Everything else — one-candle trades, non-active
// cells — opens the shared trade-details popover (backtestClusterHoverSignal),
// which carries its own trade payload and is safe from any cell.

import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import {
  backtestClusterHoverSignal,
  backtestResultSignal,
  highlightTradeSignal,
} from "./lib/signals";
import type { StoredBacktestResult } from "./lib/persist";

const WIN_COLOR = "#26a69a";
const LOSS_COLOR = "#ef5350";

type Trade = StoredBacktestResult["trades"][number];

// One projected dash: candle-pane absolute pixel anchor + the hover payload.
export interface ProjectedDash {
  key: string; // stable React key (trade index)
  x: number;
  y: number;
  index: number; // index into result.trades (highlightTradeSignal key)
  trade: Trade;
  spanBars: number; // display candles the trade covers (picks the hover kind)
  result: StoredBacktestResult; // owning result (active-result gate + drill-in)
  fromMs: number; // the trade's entry → exit window (drill-in zoom)
  toMs: number;
}

export interface BacktestTradeDashesHandle {
  setDashes(dashes: ProjectedDash[]): void;
}

// Cheap signature so setDashes skips the re-render when nothing visible moved —
// the redraw loop calls it every tick/scroll (matches BacktestAggMarkers).
// Includes the per-dash payload (win/loss, span, exit) and not just position:
// a re-run can produce trades with identical entries but different exits/P&L,
// and a position-only sig would keep serving the OLD run's dashes.
function dashesSig(dashes: ProjectedDash[]): string {
  return dashes
    .map(
      (d) =>
        `${d.key}@${Math.round(d.x)},${Math.round(d.y)}:${d.trade.pnl >= 0 ? "w" : "l"}:${d.spanBars}:${d.toMs}`,
    )
    .join("|");
}

type HoverKind = "highlight" | "popover";

export default function BacktestTradeDashes({
  handleRef,
  onDrillIn,
}: {
  handleRef?: Ref<BacktestTradeDashesHandle>;
  onDrillIn: (resolution: string, fromMs: number, toMs: number) => void;
}) {
  const [dashes, setDashes] = useState<ProjectedDash[]>([]);
  const sigRef = useRef("");
  // The dash driving a hover effect and WHICH signal it set with what value.
  // Tracked so a hovered dash that gets culled (scrolled off / cleared) can
  // drop its effect — React fires no onMouseLeave when the hovered element
  // unmounts. The clear re-checks the signal still holds OUR value: both
  // signals are global and shared (trades-panel row hover drives
  // highlightTradeSignal too, pills drive the popover), so a blind null would
  // wipe an effect another owner has since put up.
  const hoveredRef = useRef<{
    key: string;
    kind: HoverKind;
    index: number;
    trade: Trade;
  } | null>(null);
  // Where the last mousedown on a dash landed — a drag that happens to end on
  // a dash must not count as a click (accidental drill-in mid-pan).
  const downRef = useRef<{ x: number; y: number } | null>(null);
  const clearOwned = (h: { kind: HoverKind; index: number; trade: Trade }) => {
    if (h.kind === "highlight") {
      if (highlightTradeSignal.value === h.index) highlightTradeSignal.set(null);
    } else if (backtestClusterHoverSignal.value?.trades[0]?.trade === h.trade) {
      backtestClusterHoverSignal.set(null);
    }
  };
  const clearHoverIfOwned = () => {
    const h = hoveredRef.current;
    if (h === null) return;
    hoveredRef.current = null;
    clearOwned(h);
  };
  useImperativeHandle(
    handleRef,
    () => ({
      setDashes(next: ProjectedDash[]) {
        const h = hoveredRef.current;
        if (h !== null && !next.some((d) => d.key === h.key)) {
          clearHoverIfOwned();
        }
        const sig = dashesSig(next);
        if (sig === sigRef.current) return;
        sigRef.current = sig;
        setDashes(next);
      },
    }),
    [],
  );
  // On unmount (cell removed / backtest cleared) drop an effect THIS layer
  // opened; gated on hoveredRef so unrelated cells' hovers survive.
  useEffect(() => clearHoverIfOwned, []);

  if (dashes.length === 0) return null;
  // z-index below the aggregate pills (11) so a pill overlapping a dash wins.
  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 10, pointerEvents: "none" }}>
      {dashes.map((d) => (
        <span
          key={d.key}
          onMouseEnter={(e) => {
            const kind: HoverKind =
              d.spanBars >= 2 && backtestResultSignal.value === d.result ? "highlight" : "popover";
            // Enter can land BEFORE the previous dash's leave (adjacent hit
            // areas); when the two dashes use different signals, overwriting
            // hoveredRef would strand the old kind's effect forever — clear it
            // here first.
            const prev = hoveredRef.current;
            if (prev !== null && prev.kind !== kind) clearOwned(prev);
            hoveredRef.current = { key: d.key, kind, index: d.index, trade: d.trade };
            if (kind === "highlight") highlightTradeSignal.set(d.index);
            else
              backtestClusterHoverSignal.set({
                trades: [{ trade: d.trade, index: d.index }],
                x: e.clientX,
                y: e.clientY,
              });
          }}
          // Only clear if THIS dash still owns the hover: moving dash→dash can
          // fire the next enter before this leave (same guard as the pills).
          onMouseLeave={() => {
            if (hoveredRef.current?.key === d.key) clearHoverIfOwned();
          }}
          onMouseDown={(e) => {
            downRef.current = { x: e.clientX, y: e.clientY };
          }}
          // Same promise the popover's "Click to drill in" hint makes for the
          // pills: jump to the backtest's native timeframe zoomed to this
          // trade — but only for a true click (≤4px travel), not a drag that
          // started or ended here.
          onClick={(e) => {
            const dn = downRef.current;
            downRef.current = null;
            if (dn && Math.hypot(e.clientX - dn.x, e.clientY - dn.y) > 4) return;
            onDrillIn(d.result.resolution, d.fromMs, d.toMs);
          }}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            // Slightly padded hit area centered on the dash — a bare 7×2 tick
            // is too small to hover, but anything larger starts swallowing
            // pan-drags and crosshair moves aimed at the candles underneath
            // (this layer sits beside klinecharts' own listeners, so events on
            // a dash never reach the chart).
            transform: `translate(calc(${d.x}px - 50%), calc(${d.y}px - 50%))`,
            pointerEvents: "auto",
            cursor: "pointer",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 7,
            height: 5,
          }}
        >
          <span
            style={{
              width: 7,
              height: 2,
              borderRadius: 1,
              background: d.trade.pnl >= 0 ? WIN_COLOR : LOSS_COLOR,
            }}
          />
        </span>
      ))}
    </div>
  );
}
