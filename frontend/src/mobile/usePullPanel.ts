// Open state for the tab overview plus the live pull distance, so the panel
// follows the finger while the strip's grab bar (or the panel's grip) drags.
//
// The live distance is NOT React state: MobileChartView hosts the panel and
// also hosts ChartCore, so a re-render on every pointermove would re-render
// the whole chart underneath a drag. Instead the drag writes the `--pull`
// custom property and a `.pulling` class straight onto the host element via
// a ref, imperatively, and only `open` (which changes rarely) is state.
import { useRef, useState } from "react";

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
  const hostRef = useRef<HTMLDivElement | null>(null);
  return {
    open,
    setOpen,
    hostRef,
    onPull: (dy: number) => {
      const el = hostRef.current;
      if (!el) return;
      el.classList.add("pulling");
      el.style.setProperty("--pull", `${dy}px`);
    },
    onPullEnd: (dy: number) => {
      const el = hostRef.current;
      if (el) {
        el.classList.remove("pulling");
        el.style.removeProperty("--pull");
      }
      if (Math.abs(dy) < TAP_PX) setOpen((o) => !o);
      else if (dy > OPEN_PX) setOpen(true);
      else if (dy < -OPEN_PX) setOpen(false);
    },
  };
}
