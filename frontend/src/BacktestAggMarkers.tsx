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

import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { backtestClusterHoverSignal } from "./lib/signals";
import { aggPillLabel } from "./lib/backtest";
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
    .map((p) => `${p.key}@${Math.round(p.x)},${Math.round(p.y)}:${p.count}:${Math.round(p.net * 10)}`)
    .join("|");
}

export default function BacktestAggMarkers({
  handleRef,
  onDrillIn,
}: {
  handleRef?: Ref<BacktestAggMarkersHandle>;
  onDrillIn: (resolution: string, fromMs: number, toMs: number) => void;
}) {
  const [pills, setPills] = useState<AggPill[]>([]);
  const sigRef = useRef("");
  // Key of the pill currently driving the shared hover popover (set on
  // mouseEnter, below). Tracked so we can dismiss the popover if that pill later
  // leaves the projected set — React fires NO onMouseLeave when a hovered element
  // unmounts, so scrolling/zooming a hovered pill off-screen would otherwise
  // strand the popover open with that bar's stale trades.
  const hoveredKeyRef = useRef<string | null>(null);
  const clearHoverIfOwned = () => {
    if (hoveredKeyRef.current !== null) {
      hoveredKeyRef.current = null;
      backtestClusterHoverSignal.set(null);
    }
  };
  useImperativeHandle(
    handleRef,
    () => ({
      setPills(next: AggPill[]) {
        // If the pill under the open popover was culled (moved off-screen), clear
        // the signal here since its onMouseLeave will never fire. A cull always
        // changes the signature, so this runs before the no-op early return below.
        if (hoveredKeyRef.current !== null && !next.some((p) => p.key === hoveredKeyRef.current)) {
          clearHoverIfOwned();
        }
        const sig = pillsSig(next);
        if (sig === sigRef.current) return;
        sigRef.current = sig;
        setPills(next);
      },
    }),
    [],
  );
  // On unmount (cell removed / backtest cleared) drop a popover THIS layer opened.
  // Gated on hoveredKeyRef so unmounting an unrelated cell never wipes another
  // cell's open popover — the signal is global (one App-level popover).
  useEffect(() => clearHoverIfOwned, []);

  if (pills.length === 0) return null;
  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 11, pointerEvents: "none" }}>
      {pills.map((p) => {
        const bg = p.net > 0 ? BUY_COLOR : p.net < 0 ? SELL_COLOR : FLAT_COLOR;
        // Direction glyph(s) + count·net. Same ▲/▼ language as the native pill,
        // so long/short reads on the coarse timeframes too (aggPillLabel: one
        // glyph for a single-direction bar, ▲n ▼m split for a mixed one).
        const longs = p.trades.reduce((n, t) => n + (t.leg === "long" ? 1 : 0), 0);
        const text = aggPillLabel(longs, p.count - longs, p.net);
        return (
          <span
            key={p.key}
            onMouseEnter={(e) => {
              hoveredKeyRef.current = p.key;
              backtestClusterHoverSignal.set({ trades: p.trades, x: e.clientX, y: e.clientY });
            }}
            // Only clear if THIS pill still owns the popover: when moving pill→pill
            // the next pill's onMouseEnter can land before this leave, and an
            // unconditional clear would wipe the popover it just opened.
            onMouseLeave={() => {
              if (hoveredKeyRef.current === p.key) clearHoverIfOwned();
            }}
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
