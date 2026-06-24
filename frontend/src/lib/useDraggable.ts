// Makes a modal draggable by its header. The modal stays flex-centered by the
// backdrop until the user grabs the handle; from the first drag we switch to a
// CSS translate offset so centering math stays correct across viewport sizes.
//
// Usage:
//   const drag = useDraggable();
//   <div className="modal" style={drag.style}>
//     <div className="modal-head" {...drag.handleProps}>…</div>
//   </div>

import { useCallback, useRef, useState } from "react";

export interface Draggable {
  style: React.CSSProperties;
  handleProps: { onMouseDown: (e: React.MouseEvent) => void };
}

export function useDraggable(): Draggable {
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  // Live offset during a drag, avoiding stale closures in the move handler.
  const base = useRef({ x: 0, y: 0 });

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Ignore clicks on interactive header controls (e.g. the ✕ button).
      if ((e.target as HTMLElement).closest("button, input, select, a")) return;
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      const origin = { ...base.current };

      const onMove = (ev: MouseEvent) => {
        const next = { x: origin.x + (ev.clientX - startX), y: origin.y + (ev.clientY - startY) };
        base.current = next;
        setOffset(next);
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [],
  );

  return {
    style: { transform: `translate(${offset.x}px, ${offset.y}px)` },
    handleProps: { onMouseDown },
  };
}
