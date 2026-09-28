// Touch gesture for the tab overview: a quick tap selects, holding lifts the
// item, then dragging reorders and releasing without moving opens its menu.
// Moving past SLOP_PX before the hold fires hands the gesture to native
// scrolling, so the overview still scrolls under a finger that lands on a chip.
import { useEffect, useRef, useState } from "react";

export const HOLD_MS = 350;
export const SLOP_PX = 8;
// A second, smaller threshold than SLOP_PX: once lifted, a tiny jitter should
// not itself start a drag, but it should take less movement than the
// pre-hold scroll slop since the finger is now deliberately held down.
const DRAG_START_PX = 4;

export interface HoldDragHandlers {
  onTap(id: string): void;
  onHold(id: string): void;
  onOver(id: string, overId: string): void;
  onDrop(id: string): void;
}

export function useHoldDrag(h: HoldDragHandlers) {
  const hRef = useRef(h);
  hRef.current = h;
  const [liftedId, setLiftedId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanupRef.current?.(), []);

  const onPointerDown = (e: React.PointerEvent, id: string) => {
    if (e.button > 0) return;
    cleanupRef.current?.();
    const pointerId = e.pointerId;
    const sx = e.clientX;
    const sy = e.clientY;
    let lifted = false;
    let dragging = false;
    let cancelled = false;
    // Once an item is lifted, page scrolling must not steal the drag. The
    // listener is only live while lifted (added here, removed in finish)
    // rather than for the document's whole lifetime.
    const preventTouchScroll = (e: TouchEvent) => e.preventDefault();
    const timer = setTimeout(() => {
      lifted = true;
      document.addEventListener("touchmove", preventTouchScroll, { passive: false });
      setLiftedId(id);
    }, HOLD_MS);

    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const dist = Math.hypot(ev.clientX - sx, ev.clientY - sy);
      if (!lifted) {
        if (dist > SLOP_PX) { cancelled = true; clearTimeout(timer); }
        return;
      }
      if (!dragging) {
        if (dist < DRAG_START_PX) return;
        dragging = true;
        setDraggingId(id);
      }
      const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>("[data-drag-id]");
      const overId = over?.dataset.dragId;
      if (overId && overId !== id) hRef.current.onOver(id, overId);
    };
    const finish = (fire: boolean) => {
      clearTimeout(timer);
      document.removeEventListener("touchmove", preventTouchScroll);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      cleanupRef.current = null;
      setLiftedId(null);
      setDraggingId(null);
      if (!fire) return;
      if (dragging) hRef.current.onDrop(id);
      else if (lifted) hRef.current.onHold(id);
      else if (!cancelled) hRef.current.onTap(id);
    };
    const onUp = (ev: PointerEvent) => { if (ev.pointerId === pointerId) finish(true); };
    const onCancel = (ev: PointerEvent) => { if (ev.pointerId === pointerId) finish(false); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    cleanupRef.current = () => finish(false);
  };

  return { onPointerDown, liftedId, draggingId };
}
