// Coarse-timeframe LIVE exit markers: one small pill per bar showing the exit
// count + net P&L, for a view coarser than the journaled closes' cadence (where
// individual exit arrows would collapse onto the same bar). The live analog of
// BacktestAggMarkers — DOM, not klinecharts overlays, so hover events are
// reliable; ChartCore's redraw loop projects the clusters (tradeMarkers.ts
// aggregateExitsByBar) to pixels and pushes them here imperatively via a handle.
//
// Hovering a pill opens the live exit-list popover (liveExitClusterHoverSignal,
// rendered once at App level). Unlike the backtest pills there is NO drill-in —
// live markers have no native-TF target to zoom into.

import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { liveExitClusterHoverSignal } from "./lib/signals";
import type { JournalTrade } from "./lib/liveJournal";

const WIN_COLOR = "#26a69a";
const LOSS_COLOR = "#ef5350";
const FLAT_COLOR = "#78909c";

// One resolved pill: the bar-high pixel anchor (candle-pane absolute) + the data
// the pill and its hover need.
export interface ExitPill {
  key: string; // stable React key (the bar timestamp)
  x: number;
  y: number;
  count: number;
  net: number;
  exits: JournalTrade[];
}

export interface TradeExitAggMarkersHandle {
  setPills(pills: ExitPill[]): void;
}

// Cheap signature so setPills can skip the state update when nothing visible
// changed — the redraw loop calls it every tick/scroll (matches BacktestAggMarkers).
function pillsSig(pills: ExitPill[]): string {
  return pills
    .map((p) => `${p.key}@${Math.round(p.x)},${Math.round(p.y)}:${p.count}:${Math.round(p.net)}`)
    .join("|");
}

const fmtNet = (n: number): string => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(0)}`;

export default function TradeExitAggMarkers({
  handleRef,
}: {
  handleRef?: Ref<TradeExitAggMarkersHandle>;
}) {
  const [pills, setPills] = useState<ExitPill[]>([]);
  const sigRef = useRef("");
  // Key of the pill driving the shared popover, so it can be dismissed if that
  // pill later leaves the projected set (React fires no onMouseLeave on unmount —
  // scrolling a hovered pill off-screen would otherwise strand the popover open).
  const hoveredKeyRef = useRef<string | null>(null);
  const clearHoverIfOwned = () => {
    if (hoveredKeyRef.current !== null) {
      hoveredKeyRef.current = null;
      liveExitClusterHoverSignal.set(null);
    }
  };
  useImperativeHandle(
    handleRef,
    () => ({
      setPills(next: ExitPill[]) {
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
  // On unmount (cell removed) drop a popover THIS layer opened.
  useEffect(() => clearHoverIfOwned, []);

  if (pills.length === 0) return null;
  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 11, pointerEvents: "none" }}>
      {pills.map((p) => {
        const bg = p.net > 0 ? WIN_COLOR : p.net < 0 ? LOSS_COLOR : FLAT_COLOR;
        const text = p.count >= 2 ? `${p.count} · ${fmtNet(p.net)}` : fmtNet(p.net);
        return (
          <span
            key={p.key}
            onMouseEnter={(e) => {
              hoveredKeyRef.current = p.key;
              liveExitClusterHoverSignal.set({ exits: p.exits, x: e.clientX, y: e.clientY });
            }}
            onMouseLeave={() => {
              if (hoveredKeyRef.current === p.key) clearHoverIfOwned();
            }}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              // Center the pill on the bar and sit it just above the bar's high.
              transform: `translate(calc(${p.x}px - 50%), calc(${p.y}px - 100% - 6px))`,
              pointerEvents: "auto",
              cursor: "default",
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
