// A drop-DOWN select: the list opens below the field, like every other menu in
// the app. A native <select> on macOS opens as a popup layered OVER the field,
// with the current option under the cursor, which reads as a context menu
// rather than as part of the form.
//
// The list is PORTALED to <body> and positioned fixed. Inside the settings
// modal, .floating-modal-body scrolls (overflow-y: auto), so an absolutely
// positioned list would be clipped by it for any field near the bottom.
//
// Closes on outside mousedown (the app-wide rule for every popover), on Escape,
// and on any scroll OUTSIDE its own list — reanchoring on scroll would need a
// scroll listener per ancestor, and a menu that quietly follows a scrolling page
// is worse than one that gets out of the way.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface SelectMenuOption {
  value: string;
  label: string;
}

interface Props {
  value: string;
  options: readonly SelectMenuOption[];
  onChange: (value: string) => void;
  /** Extra class on the trigger, e.g. to make it fill its row. */
  className?: string;
  disabled?: boolean;
  ariaLabel?: string;
}

const GAP = 4;
const MAX_H = 280;

export default function SelectMenu({
  value,
  options,
  onChange,
  className,
  disabled,
  ariaLabel,
}: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Measured on the CLICK, not in an effect: the list is only ever rendered
  // once a position exists, so it can never paint at 0,0 for a frame, and there
  // is no cascading render.
  function toggle() {
    if (open) return setOpen(false);
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const below = window.innerHeight - r.bottom - GAP;
    const h = Math.min(MAX_H, options.length * 30 + 8);
    // Flip up only when below genuinely cannot hold it AND above has more room.
    const up = below < h && r.top - GAP > below;
    setPos({
      top: up ? Math.max(GAP, r.top - GAP - h) : r.bottom + GAP,
      left: r.left,
      width: r.width,
    });
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || listRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    // NOT scrolling of the list itself: this listener is capture-phase on
    // window, so a wheel inside a list long enough to overflow (maxHeight, with
    // overflow-y: auto) would close the menu mid-scroll.
    const onScroll = (e: Event) => {
      if (listRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  const current = options.find((o) => o.value === value);

  return (
    <>
      <button
        type="button"
        ref={btnRef}
        className={`sel-trigger${className ? ` ${className}` : ""}${open ? " on" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={toggle}
      >
        <span className="sel-value">{current?.label ?? value}</span>
        <span className="sel-caret" aria-hidden="true">
          ⌄
        </span>
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={listRef}
            className="dropdown sel-dropdown"
            role="listbox"
            aria-label={ariaLabel}
            style={{ top: pos.top, left: pos.left, minWidth: pos.width, maxHeight: MAX_H }}
          >
            {options.map((o) => (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={o.value === value}
                className={`sel-option${o.value === value ? " on" : ""}`}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
              >
                {o.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
