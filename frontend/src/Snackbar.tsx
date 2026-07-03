// TV-style transient snackbar: message + accent action + ✕. Anchors itself
// just below the element matching `anchorSelector` (e.g. the merged tab's
// chip), so the offer appears where the action happened; without an anchor
// (or when the element is gone) it sits top-center under the tab bar.
// Auto-dismisses after `duration` ms. Hovering pauses the countdown; leaving
// restarts it in full (simple, and indistinguishable from a true pause at
// this duration).

import { useEffect, useLayoutEffect, useRef, useState } from "react";

interface Props {
  message: string;
  actionLabel: string;
  onAction: () => void;
  onDismiss: () => void;
  duration?: number;
  anchorSelector?: string;
}

export default function Snackbar({
  message,
  actionLabel,
  onAction,
  onDismiss,
  duration = 8000,
  anchorSelector,
}: Props) {
  const [hovered, setHovered] = useState(false);
  // Anchored position (viewport px), or null → the CSS default (top-center).
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // useLayoutEffect: the first placement happens BEFORE paint, so the pill
  // never flashes at the top-center fallback for a frame. The anchor chip can
  // also move without a window resize (a sibling label widens, a panel
  // toggles), so re-measure on a short interval while visible — the pill is
  // transient, so that's a few dozen cheap reads at most.
  useLayoutEffect(() => {
    if (!anchorSelector) return;
    const place = () => {
      const el = document.querySelector(anchorSelector);
      if (!el) {
        setPos(null);
        return;
      }
      const r = el.getBoundingClientRect();
      // Clamp the center so a chip near the viewport edge can't push the
      // pill off-screen (half a typical snackbar width of margin).
      const pad = 170;
      const next = {
        left: Math.min(Math.max(r.left + r.width / 2, pad), window.innerWidth - pad),
        top: r.bottom + 8,
      };
      // Keep the same object when nothing moved — a fresh object every tick
      // would re-render the pill 4×/second for nothing.
      setPos((p) => (p && p.left === next.left && p.top === next.top ? p : next));
    };
    place();
    const iv = setInterval(place, 250);
    window.addEventListener("resize", place);
    return () => {
      clearInterval(iv);
      window.removeEventListener("resize", place);
    };
  }, [anchorSelector]);
  // The timeout must always call the LATEST onDismiss without restarting the
  // countdown when the parent re-renders with a new closure.
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  useEffect(() => {
    if (hovered) return;
    const t = setTimeout(() => onDismissRef.current(), duration);
    return () => clearTimeout(t);
  }, [hovered, duration]);
  return (
    <div
      className="snackbar"
      style={pos ? { left: pos.left, top: pos.top } : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span className="snackbar-msg">{message}</span>
      <button type="button" className="snackbar-action" onClick={onAction}>
        {actionLabel}
      </button>
      <button type="button" className="snackbar-close" onClick={onDismiss} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}
