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
  net: number; // money exits only (ExitCluster.net)
  // How many of `exits` are confirmed money (ExitCluster.moneyCount). 0 means
  // every exit in this bar is a price-units estimate (pnlIsMoney === false),
  // so there is no money net worth printing.
  moneyCount: number;
  exits: JournalTrade[];
}

export interface TradeExitAggMarkersHandle {
  setPills(pills: ExitPill[]): void;
}

/** Sign to color a pill by: the money net when the bucket has one, otherwise
 * the estimates' own sign (an all-estimate bucket has no money net, but the
 * closes still won/lost in price terms, so the pill keeps its win/loss tone). */
function toneValue(p: ExitPill): number {
  if (p.moneyCount > 0) return p.net;
  return p.exits.reduce((s, e) => s + e.pnl, 0);
}

// Cheap signature so setPills can skip the state update when nothing visible
// changed — the redraw loop calls it every tick/scroll (matches BacktestAggMarkers).
// Folds in the TONE sign (not just net): for an all-estimate bucket (moneyCount
// 0) net is always 0, so two updates to the same bar with differently-signed
// estimates (e.g. a sign flip) would otherwise hash identically, skip the
// setState, and leave a stale win/loss color on screen.
function pillsSig(pills: ExitPill[]): string {
  return pills
    .map(
      (p) =>
        `${p.key}@${Math.round(p.x)},${Math.round(p.y)}:${p.count}:${Math.round(p.net)}:${p.moneyCount}:${Math.sign(toneValue(p))}`,
    )
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
        const tone = toneValue(p);
        const bg = tone > 0 ? WIN_COLOR : tone < 0 ? LOSS_COLOR : FLAT_COLOR;
        // No money exit in the bucket: there's no net worth printing (just an
        // estimate sum), so the pill shows the exit count only.
        const text =
          p.moneyCount === 0
            ? `${p.count}`
            : p.count >= 2
              ? `${p.count} · ${fmtNet(p.net)}`
              : fmtNet(p.net);
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
