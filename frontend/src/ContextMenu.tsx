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
  // A toggle item: a check mark in the icon slot when true, blank when false.
  checked?: boolean;
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
    // A tap on the chart canvas never yields a mousedown (klinecharts consumes
    // the touch sequence), so on a phone the menu could only be closed by
    // picking an item. Watch the touch itself too.
    const onTouch = (e: TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("touchstart", onTouch, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("touchstart", onTouch, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // While a toggle item is ticked, every icon-less item gets the same blank
  // slot so the labels start in one column. With none ticked there is no
  // slot at all: a blank gutter would only widen the menu.
  const hasChecks = items.some((it) => it.checked === true);
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
            role={it.checked !== undefined ? "menuitemcheckbox" : undefined}
            aria-checked={it.checked}
            onClick={() => {
              if (it.disabled) return;
              it.onClick();
              onClose();
            }}
          >
            <span className="ctx-item-label">
              {hasChecks && !it.icon ? (
                <span className="ctx-item-icon ctx-item-check" aria-hidden="true">
                  {it.checked && (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  )}
                </span>
              ) : (
                it.icon && <span className="ctx-item-icon">{it.icon}</span>
              )}
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
