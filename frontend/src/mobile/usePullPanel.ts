// Open state for the tab overview plus the live pull distance, so the panel
// follows the finger while the strip (its handle, or a downward swipe
// anywhere on the chip row) or the panel's grip drags. A swipe on the chart
// itself never opens it, since a stray pull while panning or pinching kept
// dropping the overview over the chart.
//
// The live distance is NOT React state: MobileChartView hosts the panel and
// also hosts ChartCore, so a re-render on every pointermove would re-render
// the whole chart underneath a drag. Instead the drag writes the `--pull`
// custom property and a `.pulling` class straight onto the host element via
// a ref, imperatively, and only `open` (which changes rarely) is state.
import { useRef, useState } from "react";

export const OPEN_PX = 60;
const TAP_PX = 4;
// How far a swipe on the chip row must travel, mostly downward, before it
// becomes a pull rather than a tap or a sideways scroll of the chips.
const SWIPE_PX = 8;

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

// A downward swipe on the chip row: the row keeps scrolling sideways and its
// chips keep their taps, and only a gesture that goes mostly down past
// SWIPE_PX turns into the same live pull as the handle's. Needs
// `touch-action: pan-x` on the row, or the browser claims the vertical move
// and cancels the pointer. Once a pull starts, the click that would follow
// on whatever chip the finger started on is swallowed.
export function startSwipePull(
  e: React.PointerEvent<HTMLElement>,
  onPull?: (dy: number) => void,
  onPullEnd?: (dy: number) => void,
): void {
  if (e.button > 0) return;
  const el = e.currentTarget;
  const id = e.pointerId;
  const sx = e.clientX;
  const sy = e.clientY;
  let dy = 0;
  let live = false;
  const move = (ev: PointerEvent) => {
    if (ev.pointerId !== id) return;
    const dx = ev.clientX - sx;
    dy = ev.clientY - sy;
    if (!live) {
      if (Math.abs(dx) < SWIPE_PX && Math.abs(dy) < SWIPE_PX) return;
      if (dy <= 0 || Math.abs(dx) > dy) { end(); return; }
      live = true;
      el.setPointerCapture(id);
    }
    onPull?.(dy);
  };
  const swallowClick = (ev: MouseEvent) => {
    ev.stopPropagation();
    ev.preventDefault();
  };
  const end = (ev?: PointerEvent) => {
    if (ev && ev.pointerId !== id) return;
    el.removeEventListener("pointermove", move);
    el.removeEventListener("pointerup", end);
    el.removeEventListener("pointercancel", end);
    if (!live) return;
    el.addEventListener("click", swallowClick, { capture: true, once: true });
    setTimeout(() => el.removeEventListener("click", swallowClick, true), 0);
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
