// Hover popover for a backtest AGGREGATE marker (higher-timeframe view). On a
// timeframe coarser than the backtest's own, trades in one bar are drawn as a
// single count/net-P&L pill (see backtest.ts); hovering that pill lists the
// bar's trades here. Driven by backtestClusterHoverSignal (set with the cursor's
// page position by the pill's onMouseEnter); rendered once at App level.
//
// pointer-events: none so moving off the pill fires its onMouseLeave (which
// clears the signal) instead of the cursor entering the popover and stranding it.

import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { backtestClusterHoverSignal } from "./lib/signals";
import { useBarTimeLabel } from "./lib/useMaskedReplay";

const subscribe = (cb: () => void) => backtestClusterHoverSignal.subscribe(cb);

const fmtPrice = (n: number): string => n.toFixed(2);
const fmtPnl = (n: number): string => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}`;
const toneOf = (n: number): string => (n > 0 ? "pos" : n < 0 ? "neg" : "");

// Keep the list bounded (pointer-events:none means it can't scroll); overflow
// collapses to a "+N more" footer so a busy bar doesn't fill the screen.
const MAX_ROWS = 12;

// Widest the card can be; keep in sync with .bt-cluster-pop's max-width.
const POP_MAX_W = 500;

export default function BacktestClusterPopover() {
  const hover = useSyncExternalStore(subscribe, () => backtestClusterHoverSignal.value);
  // These rows label bars that are ON SCREEN, so during a masked replay session
  // they would print the exact date it hides (before the early return: hooks).
  const barTime = useBarTimeLabel();
  if (!hover) return null;
  const { trades, x, y } = hover;
  const shown = trades.slice(0, MAX_ROWS);
  const extra = trades.length - shown.length;

  // Offset from the cursor, and flip to the left / above when near a viewport
  // edge so the card stays fully on screen. POP_MAX_W mirrors the card's CSS
  // max-width (.bt-cluster-pop) — the card sizes to its content, so flip on the
  // widest it can get rather than on a guess it can outgrow.
  const flipX = x > window.innerWidth - POP_MAX_W;
  const flipY = y > window.innerHeight - 260;
  const style: React.CSSProperties = {
    left: flipX ? undefined : x + 14,
    right: flipX ? window.innerWidth - x + 14 : undefined,
    top: flipY ? undefined : y + 14,
    bottom: flipY ? window.innerHeight - y + 14 : undefined,
  };

  return createPortal(
    <div className="bt-cluster-pop" style={style}>
      <table className="bt-cluster-pop-table">
        <tbody>
          {shown.map(({ trade: t, index }, i) => (
            <tr key={i}>
              <td className="bt-cluster-pop-seq">#{index + 1}</td>
              <td className={t.leg === "long" ? "bt-panel-side-long" : "bt-panel-side-short"}>
                {t.leg === "long" ? "Long" : "Short"}
              </td>
              <td className="bt-cluster-pop-time">{barTime(t.entry_time * 1000)}</td>
              <td className="bt-cluster-pop-num">
                {fmtPrice(t.entry_price)} → {fmtPrice(t.exit_price)}
              </td>
              <td className={`bt-cluster-pop-num ${toneOf(t.pnl)}`}>{fmtPnl(t.pnl)}</td>
              <td className="bt-cluster-pop-reason">{t.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {extra > 0 && <div className="bt-cluster-pop-more">+{extra} more</div>}
      <div className="bt-cluster-pop-hint">Click to drill in</div>
    </div>,
    document.body,
  );
}
