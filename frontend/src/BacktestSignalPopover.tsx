// Hover popover for a backtest SIGNAL glyph — the subtle caret drawn on the
// signal candle (the bar before a rule-based fill). It lists each PASSING rule
// with the authoritative operand values the engine actually compared, and every
// operand's timeframe inline (base ⇒ the run's TF), so a base-vs-HTF mismatch is
// unmissable. Driven by backtestSignalHoverSignal (set with the cursor's page
// position by the glyph's onMouseEnter); rendered once at App level.
//
// pointer-events: none (shared .bt-cluster-pop shell) so moving off the glyph
// fires its onMouseLeave (clearing the signal) instead of stranding the card.

import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { backtestSignalHoverSignal } from "./lib/signals";
import { signalHeader, termLabel, opSymbol } from "./lib/signalGlyphs";
import { formatExpiryShort } from "./lib/alertUi";

const subscribe = (cb: () => void) => backtestSignalHoverSignal.subscribe(cb);

// Match the engine's numeric formatting elsewhere in the panel: trim to a
// sensible precision without forcing trailing zeros. null (operand had no value
// at the signal bar) shows an em dash.
const fmt = (n: number | null): string =>
  n == null ? "—" : Number.isInteger(n) ? String(n) : String(Number(n.toFixed(5)));

export default function BacktestSignalPopover() {
  const hover = useSyncExternalStore(subscribe, () => backtestSignalHoverSignal.value);
  if (!hover) return null;
  const { glyph, x, y } = hover;

  const flipX = x > window.innerWidth - 340;
  const flipY = y > window.innerHeight - 240;
  const style: React.CSSProperties = {
    left: flipX ? undefined : x + 14,
    right: flipX ? window.innerWidth - x + 14 : undefined,
    top: flipY ? undefined : y + 14,
    bottom: flipY ? window.innerHeight - y + 14 : undefined,
  };

  return createPortal(
    <div className="bt-cluster-pop bt-signal-pop" style={style}>
      <div className="bt-signal-pop-head">
        {signalHeader(glyph, formatExpiryShort(glyph.signalTime * 1000))}
      </div>
      <table className="bt-cluster-pop-table">
        <tbody>
          {glyph.terms.map((t, i) =>
            t.op === "" ? (
              <tr key={i}>
                <td className="bt-signal-pop-op">{termLabel(t.left, t.leftTf)}</td>
                <td className="bt-cluster-pop-num">{fmt(t.lval)}</td>
              </tr>
            ) : (
              <tr key={i}>
                <td className="bt-signal-pop-op">{termLabel(t.left, t.leftTf)}</td>
                <td className="bt-cluster-pop-num">{fmt(t.lval)}</td>
                <td className="bt-signal-pop-cmp">{opSymbol(t.op)}</td>
                <td className="bt-signal-pop-op">{termLabel(t.right, t.rightTf)}</td>
                <td className="bt-cluster-pop-num">{fmt(t.rval)}</td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>,
    document.body,
  );
}
