// A non-blocking, draggable floating panel shared by the chart-context modals
// (ChartOperandPicker, IndicatorSettings, DrawingSettings, AlertModal). Unlike the
// classic `.modal-backdrop` shell, it renders NO backdrop — the chart behind stays
// fully interactive everywhere outside the panel footprint, which is the whole point
// of the on-chart emphasis and of tweaking settings while watching the chart.
//
// Dismiss (see onDocMouseDown): any click outside the modal closes it — the chart
// included — the only exception being popovers the modal itself spawns. Esc and the
// header ✕ also close.
//
// Provides the header (title + drag handle + CloseButton), optional footer, Esc,
// and the click-away — callers pass only their body + footer.

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import CloseButton from "../CloseButton";
import { useDraggable } from "../lib/useDraggable";
import { useCloseOnEscape } from "../lib/useCloseOnEscape";

export interface FloatingModalProps {
  title: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  width?: number;
  initialPlacement?: "center" | "right";
  className?: string;
  /** Header ✕ label — some modals treat close as "Cancel" (revert). */
  closeLabel?: string;
  children: ReactNode;
}

export default function FloatingModal({
  title,
  onClose,
  footer,
  width,
  initialPlacement = "center",
  className = "",
  closeLabel = "Close",
  children,
}: FloatingModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const drag = useDraggable();
  useCloseOnEscape(onClose);

  // Read onClose through a ref so the document listener attaches once and never
  // re-subscribes on a changing handler identity (callers pass inline arrows).
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    // Capture phase: portaled popovers / modal bodies call stopPropagation on
    // mousedown, which would otherwise stop a bubble-phase listener from ever
    // seeing the click. Capture fires top-down before any target handler.
    const onDocMouseDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (!t) return;
      if (panelRef.current?.contains(t)) return; // click inside the modal → keep open
      // Any click OUTSIDE the modal dismisses it — including the chart. The only
      // exception is a portaled popover the modal itself spawned (e.g. the color/
      // line picker's role="dialog" panel, or a menu/listbox): those live outside
      // panelRef but are logically part of the modal, so a click there must not
      // close it (otherwise editing a color would slam the settings modal shut).
      if (t.closest('[role="dialog"], [role="menu"], [role="listbox"]')) return;
      closeRef.current();
    };
    document.addEventListener("mousedown", onDocMouseDown, true);
    return () => document.removeEventListener("mousedown", onDocMouseDown, true);
  }, []);

  // Fixed placement + drag transform compose: position via top/left, drag via
  // transform. `center` needs a -50% self-offset that the drag translate stacks onto.
  const placement: React.CSSProperties =
    initialPlacement === "right" ? { right: 24, top: 64 } : { left: "50%", top: 64 };
  const baseTransform = initialPlacement === "right" ? "" : "translateX(-50%)";
  const style: React.CSSProperties = {
    ...placement,
    ...(width ? { width } : {}),
    transform: `${baseTransform} ${drag.style.transform}`.trim(),
  };

  return createPortal(
    <div ref={panelRef} className={`floating-modal ${className}`.trim()} style={style}>
      <div className="modal-head floating-modal-head" {...drag.handleProps}>
        <div className="floating-modal-title">{title}</div>
        <CloseButton onClick={onClose} label={closeLabel} />
      </div>
      <div className="floating-modal-body">{children}</div>
      {footer != null && <div className="modal-foot">{footer}</div>}
    </div>,
    document.body,
  );
}
