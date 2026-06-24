// A small ⓘ info icon that reveals an explanatory tooltip on hover/focus. The
// tooltip is portaled to <body> and fixed-positioned from the icon's rect, so it
// escapes the settings modal's clipping and stacking context (same approach as the
// indicator-menu row tooltip). Reuses the shared .ind-info / .ind-tooltip styles.

import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface Props {
  // One string, or several — each rendered as its own line/paragraph in the tooltip.
  text: string | string[];
  title?: string;
  // Optional custom trigger (e.g. a ⚠ badge); defaults to the ⓘ icon. `className`
  // overrides the trigger button's class (default "ind-info").
  children?: ReactNode;
  className?: string;
}

export default function InfoTip({ text, title, children, className }: Props) {
  const ref = useRef<HTMLButtonElement>(null);
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);

  function show() {
    const r = ref.current?.getBoundingClientRect();
    if (r) setTip({ x: r.right + 8, y: r.top + r.height / 2 });
  }

  return (
    <>
      <button
        ref={ref}
        type="button"
        className={className ?? "ind-info"}
        aria-label={title ? `About ${title}` : "More info"}
        tabIndex={-1}
        onClick={(e) => {
          e.preventDefault(); // info only — never toggles a wrapping label / row
          e.stopPropagation();
        }}
        onMouseEnter={show}
        onMouseLeave={() => setTip(null)}
        onFocus={show}
        onBlur={() => setTip(null)}
      >
        {children ?? (
          <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <line x1="12" y1="11" x2="12" y2="16" />
            <circle cx="12" cy="7.5" r="0.6" fill="currentColor" stroke="none" />
          </svg>
        )}
      </button>
      {tip &&
        createPortal(
          <div className="ind-tooltip" style={{ left: tip.x, top: tip.y }} role="tooltip">
            {title && <div className="ind-tooltip-title">{title}</div>}
            {(Array.isArray(text) ? text : [text]).map((line, i) => (
              <div className="ind-tooltip-desc" key={i}>
                {line}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
