// Hover label for a LIVE trade marker. The on-chart entry/exit marker is a
// compact arrow glyph (tradeMarkers.ts, MARKER_OVERLAY style "live"); its full
// text ("Long 100 @ 72.28" for an entry, the P&L for an exit) is shown here as a
// DOM pill only while the glyph is hovered, so the always-on chart furniture
// never covers neighbouring candles. Driven by tradeMarkerHoverSignal (set with
// the cursor's page position + win by the glyph's onMouseEnter); rendered once at
// App level. Colour matches the marker: entry = neutral blue, win = green, loss =
// red — the same palette PositionLines uses.
//
// pointer-events: none so moving off the glyph fires its onMouseLeave (clearing
// the signal) instead of the pill stealing the hover and stranding itself.

import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { tradeMarkerHoverSignal } from "./lib/signals";

const subscribe = (cb: () => void) => tradeMarkerHoverSignal.subscribe(cb);

const ENTRY_COLOR = "#2962ff";
const WIN_COLOR = "#26a69a";
const LOSS_COLOR = "#ef5350";

export default function TradeMarkerLabelPopover() {
  const hover = useSyncExternalStore(subscribe, () => tradeMarkerHoverSignal.value);
  if (!hover) return null;
  const { label, win, x, y } = hover;
  const color = win == null ? ENTRY_COLOR : win ? WIN_COLOR : LOSS_COLOR;

  const flipX = x > window.innerWidth - 160;
  const style: React.CSSProperties = {
    position: "fixed",
    left: flipX ? undefined : x + 12,
    right: flipX ? window.innerWidth - x + 12 : undefined,
    top: y - 10,
    background: color,
    color: "#fff",
    font: "600 11px -apple-system, system-ui, sans-serif",
    padding: "3px 7px",
    borderRadius: 4,
    whiteSpace: "nowrap",
    pointerEvents: "none",
    zIndex: 1600,
  };

  return createPortal(<div style={style}>{label}</div>, document.body);
}
