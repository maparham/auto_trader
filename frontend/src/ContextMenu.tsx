// Minimal reusable right-click menu: a fixed-position list that closes on
// outside-click or Escape.

import { useEffect, useRef, type ReactNode } from "react";
import Tooltip from "./components/Tooltip";

export interface MenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
  // Optional leading icon (an inline SVG node — see ./lib/menuIcons).
  icon?: ReactNode;
  // A greyed-out, non-clickable item. `disabledReason` (when set) shows as a
  // tooltip explaining why — e.g. "MACD isn't supported in rules yet".
  disabled?: boolean;
  disabledReason?: string;
}

interface Props {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

export default function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      // Ignore the RIGHT-button press (button 2). When this menu is opened by a
      // right-click on a chart overlay, klinecharts fires its onRightClick on the
      // `mousedown`, and React commits this menu synchronously — so the very same
      // mousedown that opened it would otherwise be caught here and close it
      // instantly. A right-click never CLOSES an open context menu anyway.
      if (e.button === 2) return;
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const style: React.CSSProperties = {
    left: Math.min(x, window.innerWidth - 200),
    top: Math.min(y, window.innerHeight - items.length * 34 - 12),
  };

  return (
    <div ref={ref} className="ctxmenu" style={style}>
      {items.map((it, i) => {
        const btn = (
          <button
            key={i}
            // aria-disabled (not the native `disabled` attr) so the button still
            // emits the pointer events the tooltip wrapper listens for.
            className={`ctx-item${it.danger ? " danger" : ""}${it.disabled ? " disabled" : ""}`}
            aria-disabled={it.disabled}
            onClick={() => {
              if (it.disabled) return;
              it.onClick();
              onClose();
            }}
          >
            <span className="ctx-item-label">
              {it.icon && <span className="ctx-item-icon">{it.icon}</span>}
              {it.label}
            </span>
          </button>
        );
        return it.disabled && it.disabledReason ? (
          <Tooltip key={i} content={it.disabledReason} placement="right">
            {btn}
          </Tooltip>
        ) : (
          btn
        );
      })}
    </div>
  );
}
