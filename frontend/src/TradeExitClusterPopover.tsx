// Hover popover for a coarse-timeframe LIVE exit pill (TradeExitAggMarkers). On a
// view coarser than the journaled closes' cadence, a bar's exits are drawn as one
// count/net-P&L pill; hovering it lists that bar's closes here. The live analog of
// BacktestClusterPopover — driven by liveExitClusterHoverSignal, rendered once at
// App level. Reuses the same bt-cluster-pop styling.
//
// pointer-events: none so moving off the pill fires its onMouseLeave (clearing the
// signal) instead of the cursor entering the popover and stranding it.

import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { liveExitClusterHoverSignal } from "./lib/signals";
import { formatExpiryShort } from "./lib/alertUi";

const subscribe = (cb: () => void) => liveExitClusterHoverSignal.subscribe(cb);

const fmtPrice = (n: number): string => n.toFixed(2);
const fmtPnl = (n: number): string => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}`;
const toneOf = (n: number): string => (n > 0 ? "pos" : n < 0 ? "neg" : "");

// Keep the list bounded (pointer-events:none means it can't scroll); overflow
// collapses to a "+N more" footer so a busy bar doesn't fill the screen.
const MAX_ROWS = 12;

export default function TradeExitClusterPopover() {
  const hover = useSyncExternalStore(subscribe, () => liveExitClusterHoverSignal.value);
  if (!hover) return null;
  const { exits, x, y } = hover;
  const shown = exits.slice(0, MAX_ROWS);
  const extra = exits.length - shown.length;

  // Offset from the cursor, flipping near a viewport edge to stay on screen.
  const flipX = x > window.innerWidth - 320;
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
          {shown.map((t, i) => (
            <tr key={i}>
              <td className={t.leg === "long" ? "bt-panel-side-long" : "bt-panel-side-short"}>
                {t.leg === "long" ? "Long" : "Short"}
              </td>
              <td className="bt-cluster-pop-time">{formatExpiryShort(t.ts * 1000)}</td>
              <td className="bt-cluster-pop-num">
                {fmtPrice(t.entry)} → {fmtPrice(t.exit)}
              </td>
              <td className={`bt-cluster-pop-num ${toneOf(t.pnl)}`}>{fmtPnl(t.pnl)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {extra > 0 && <div className="bt-cluster-pop-more">+{extra} more</div>}
    </div>,
    document.body,
  );
}
