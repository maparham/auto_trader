import { useRef, useState } from "react";
import { createPortal } from "react-dom";

// A trailing ⓘ that reveals a description tooltip on hover, mirroring the indicator
// menu's info icon (same .ind-info / .ind-tooltip styling). The tooltip is portaled
// to <body> so the dropdown's own clipping/stacking can't hide it. onClick is
// swallowed so clicking the icon inside a menu row never triggers the row's action.
export default function InfoTip({ title, desc }: { title: string; desc: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);
  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setTip({ x: r.right + 8, y: r.top + r.height / 2 });
  };
  return (
    <>
      <button
        ref={ref}
        className="ind-info"
        aria-label={`About ${title}`}
        onClick={(e) => e.stopPropagation()}
        onMouseEnter={show}
        onMouseLeave={() => setTip(null)}
        onFocus={show}
        onBlur={() => setTip(null)}
      >
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <line x1="12" y1="11" x2="12" y2="16" />
          <circle cx="12" cy="7.5" r="0.6" fill="currentColor" stroke="none" />
        </svg>
      </button>
      {tip &&
        createPortal(
          <div className="ind-tooltip" style={{ left: tip.x, top: tip.y }} role="tooltip">
            <div className="ind-tooltip-title">{title}</div>
            <div className="ind-tooltip-desc">{desc}</div>
          </div>,
          document.body,
        )}
    </>
  );
}
