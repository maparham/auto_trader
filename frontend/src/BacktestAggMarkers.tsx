// Higher-timeframe backtest markers: one small pill per bar showing the trade
// count + net P&L, for a backtest viewed on a timeframe COARSER than its own
// (where individual fill arrows would collapse onto the same bar). DOM, not
// klinecharts overlays — native hover/click events are reliable, whereas the
// overlay-event hit test on a tiny locked figure is flaky (same reason the
// legend and curve labels are DOM). ChartCore's redraw loop projects the
// clusters (backtest.ts getBacktestAggregate) to pixels and pushes them here
// imperatively via a handle — no React re-render per crosshair pixel.
//
// Hovering a pill opens the shared trade-list popover (backtestClusterHoverSignal,
// rendered once at App level); clicking drills into the backtest's native
// timeframe zoomed to that bar's window (onDrillIn, wired by ChartCore).

import { useImperativeHandle, useRef, useState, type Ref } from "react";
import { backtestClusterHoverSignal } from "./lib/signals";
import type { StoredBacktestResult } from "./lib/persist";

const BUY_COLOR = "#26a69a";
const SELL_COLOR = "#ef5350";
const FLAT_COLOR = "#78909c";

type Trade = StoredBacktestResult["trades"][number];

// One resolved pill: the bar-high pixel anchor (candle-pane absolute, same space
// as the other DOM overlays) + the data the pill and its interactions need.
export interface AggPill {
  key: string; // stable React key (the bar timestamp)
  x: number;
  y: number;
  count: number;
  net: number;
  trades: Trade[];
  resolution: string; // the backtest's native timeframe (drill-in target)
  fromMs: number; // bar's min-entry → max-exit window (drill-in zoom)
  toMs: number;
}

export interface BacktestAggMarkersHandle {
  setPills(pills: AggPill[]): void;
}

// Cheap signature of the rendered pills so setPills can skip the state update
// (and the re-render) when nothing visible changed — the redraw loop calls it
// every tick/scroll (matches CurveLabels' guard).
function pillsSig(pills: AggPill[]): string {
  return pills
    .map((p) => `${p.key}@${Math.round(p.x)},${Math.round(p.y)}:${p.count}:${Math.round(p.net)}`)
    .join("|");
}

const fmtNet = (n: number): string => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(0)}`;

export default function BacktestAggMarkers({
  handleRef,
  onDrillIn,
}: {
  handleRef?: Ref<BacktestAggMarkersHandle>;
  onDrillIn: (resolution: string, fromMs: number, toMs: number) => void;
}) {
  const [pills, setPills] = useState<AggPill[]>([]);
  const sigRef = useRef("");
  useImperativeHandle(
    handleRef,
    () => ({
      setPills(next: AggPill[]) {
        const sig = pillsSig(next);
        if (sig === sigRef.current) return;
        sigRef.current = sig;
        setPills(next);
      },
    }),
    [],
  );

  if (pills.length === 0) return null;
  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 11, pointerEvents: "none" }}>
      {pills.map((p) => {
        const bg = p.net > 0 ? BUY_COLOR : p.net < 0 ? SELL_COLOR : FLAT_COLOR;
        // A single-trade bar shows just its P&L (a "1" badge is noise); a
        // multi-trade bar prefixes the count.
        const text = p.count >= 2 ? `${p.count} · ${fmtNet(p.net)}` : fmtNet(p.net);
        return (
          <span
            key={p.key}
            onMouseEnter={(e) =>
              backtestClusterHoverSignal.set({ trades: p.trades, x: e.clientX, y: e.clientY })
            }
            onMouseLeave={() => backtestClusterHoverSignal.set(null)}
            onClick={() => onDrillIn(p.resolution, p.fromMs, p.toMs)}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              // Center the pill on the bar and sit it just above the bar's high.
              transform: `translate(calc(${p.x}px - 50%), calc(${p.y}px - 100% - 6px))`,
              pointerEvents: "auto",
              cursor: "pointer",
              whiteSpace: "nowrap",
              font: "11px -apple-system, system-ui, sans-serif",
              lineHeight: "14px",
              padding: "1px 5px",
              borderRadius: 3,
              color: "#fff",
              background: bg,
            }}
          >
            {text}
          </span>
        );
      })}
    </div>
  );
}
