// Open state for the tab overview plus the live pull distance, so the panel
// follows the finger while the strip's grab bar (or the panel's grip) drags.
import { useState } from "react";

export const OPEN_PX = 60;
const TAP_PX = 4;

// Shared pointer-drag handler for a grab bar / grip: tracks vertical
// movement from pointerdown, reports live delta via onPull, and the final
// delta via onPullEnd once the gesture ends. Used by both the strip's bar
// (MobileChartStrip) and the panel's own grip (MobileTabOverview) so the
// gesture logic lives in one place.
export function startPullDrag(
  e: React.PointerEvent<HTMLElement>,
  onPull?: (dy: number) => void,
  onPullEnd?: (dy: number) => void,
): void {
  const el = e.currentTarget;
  el.setPointerCapture(e.pointerId);
  const sy = e.clientY;
  let dy = 0;
  const move = (ev: PointerEvent) => {
    dy = ev.clientY - sy;
    onPull?.(dy);
  };
  const end = () => {
    el.removeEventListener("pointermove", move);
    el.removeEventListener("pointerup", end);
    el.removeEventListener("pointercancel", end);
    onPullEnd?.(dy);
  };
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
}

export function usePullPanel() {
  const [open, setOpen] = useState(false);
  const [dragOffset, setDragOffset] = useState<number | null>(null);
  return {
    open,
    setOpen,
    dragOffset,
    onPull: (dy: number) => setDragOffset(dy),
    onPullEnd: (dy: number) => {
      setDragOffset(null);
      if (Math.abs(dy) < TAP_PX) setOpen((o) => !o);
      else if (dy > OPEN_PX) setOpen(true);
      else if (dy < -OPEN_PX) setOpen(false);
    },
  };
}
