// TV-style transient snackbar (bottom-center): message + accent action + ✕.
// Auto-dismisses after `duration` ms. Hovering pauses the countdown; leaving
// restarts it in full (simple, and indistinguishable from a true pause at
// this duration).

import { useEffect, useRef, useState } from "react";

interface Props {
  message: string;
  actionLabel: string;
  onAction: () => void;
  onDismiss: () => void;
  duration?: number;
}

export default function Snackbar({
  message,
  actionLabel,
  onAction,
  onDismiss,
  duration = 8000,
}: Props) {
  const [hovered, setHovered] = useState(false);
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
