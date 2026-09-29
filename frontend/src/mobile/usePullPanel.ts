// Open state for the tab overview plus the live pull distance, so the panel
// follows the finger while the strip's grab bar (or the panel's grip) drags.
//
// The live distance is NOT React state: MobileChartView hosts the panel and
// also hosts ChartCore, so a re-render on every pointermove would re-render
// the whole chart underneath a drag. Instead the drag writes the `--pull`
// custom property and a `.pulling` class straight onto the host element via
// a ref, imperatively, and only `open` (which changes rarely) is state.
import { useEffect, useRef, useState } from "react";

export const OPEN_PX = 60;
const TAP_PX = 4;
// A bare downward swipe anywhere in the chart body needs more distance than
// the dedicated handle before it commits, since it has to stay out of the
// way of chart panning and drawing.
const ANYWHERE_OPEN_PX = 90;

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

// Catches a downward pull that misses the small handle: any single-finger
// drag starting inside `containerEl`, once it's clearly a downward swipe
// (more vertical distance than horizontal) past ANYWHERE_OPEN_PX, opens the
// panel. Never captures the pointer or calls preventDefault, so it only ever
// adds a reading of the same touch stream; chart panning, zooming and
// drawing keep working exactly as before, and a swipe that turns out to be
// sideways or upward is dropped without side effects. `skip(target)` excuses
// gestures starting on a control with its own drag semantics (buttons, the
// drawing tools, an in-progress drawing).
export function useAnywherePull(
  containerRef: React.RefObject<HTMLElement | null>,
  enabled: boolean,
  skip: (target: EventTarget | null) => boolean,
  onOpen: () => void,
): void {
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !enabled) return;
    let pointerId: number | null = null;
    let sx = 0;
    let sy = 0;
    let live = false;
    const reset = () => { pointerId = null; live = false; };
    const onDown = (e: PointerEvent) => {
      if (pointerId !== null || e.button > 0 || skip(e.target)) return;
      pointerId = e.pointerId;
      sx = e.clientX;
      sy = e.clientY;
      live = true;
    };
    const onMove = (e: PointerEvent) => {
      if (!live || e.pointerId !== pointerId) return;
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      if (dy < 0 || Math.abs(dx) > Math.abs(dy)) { live = false; return; }
      if (dy > ANYWHERE_OPEN_PX) { reset(); onOpen(); }
    };
    const onUp = (e: PointerEvent) => { if (e.pointerId === pointerId) reset(); };
    // Capture phase: the chart library's own canvas handlers call
    // stopPropagation to manage panning/zooming, which would otherwise stop
    // these events before they ever reached a bubble-phase listener here.
    // Capture on an ancestor (and window, above everything) always fires
    // first, so it can't be silenced by something the target does later.
    el.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
    return () => {
      el.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
    };
  }, [containerRef, enabled, skip, onOpen]);
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
