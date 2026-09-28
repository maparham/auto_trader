// Touch gesture for the tab overview: a quick tap selects, holding lifts the
// item, then dragging reorders and releasing without moving opens its menu.
// Moving past SLOP_PX before the hold fires hands the gesture to native
// scrolling, so the overview still scrolls under a finger that lands on a chip.
import { useEffect, useRef, useState } from "react";

export const HOLD_MS = 350;
export const SLOP_PX = 8;

export interface HoldDragHandlers {
  onTap(id: string): void;
  onHold(id: string): void;
  onOver(id: string, overId: string): void;
  onDrop(id: string): void;
}

// Once an item is lifted, page scrolling must not steal the drag.
let touchLock = false;
if (typeof document !== "undefined") {
  document.addEventListener("touchmove", (e) => { if (touchLock) e.preventDefault(); }, { passive: false });
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
    const sx = e.clientX;
    const sy = e.clientY;
    let lifted = false;
    let dragging = false;
    let cancelled = false;
    const timer = setTimeout(() => {
      lifted = true;
      touchLock = true;
      setLiftedId(id);
    }, HOLD_MS);

    const move = (ev: PointerEvent) => {
      const dist = Math.hypot(ev.clientX - sx, ev.clientY - sy);
      if (!lifted) {
        if (dist > SLOP_PX) { cancelled = true; clearTimeout(timer); }
        return;
      }
      if (!dragging) {
        if (dist < 4) return;
        dragging = true;
        setDraggingId(id);
      }
      const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>("[data-drag-id]");
      const overId = over?.dataset.dragId;
      if (overId && overId !== id) hRef.current.onOver(id, overId);
    };
    const finish = (fire: boolean) => {
      clearTimeout(timer);
      touchLock = false;
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
    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    cleanupRef.current = () => finish(false);
  };

  return { onPointerDown, liftedId, draggingId };
}
