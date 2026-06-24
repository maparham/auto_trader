// One row in the indicator menu: the indicator name (click adds an instance),
// a leading favourite star, and a trailing ⓘ that reveals a description tooltip.
//
// The tooltip is rendered into a portal and positioned with fixed coordinates
// from the icon's bounding rect, because the menu's `.dropdown ul` is an
// overflow-scroll container that would otherwise clip a normally-positioned
// tooltip (worst on the last visible row).

import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { indicatorInfo } from "./lib/indicatorMeta";

interface Props {
  name: string;
  favorite: boolean;
  onAdd: () => void;
  onToggleFavorite: () => void;
}

export default function IndicatorRow({ name, favorite, onAdd, onToggleFavorite }: Props) {
  const { title, desc } = indicatorInfo(name);
  const infoRef = useRef<HTMLButtonElement>(null);
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);

  function showTip() {
    const r = infoRef.current?.getBoundingClientRect();
    if (r) setTip({ x: r.right + 8, y: r.top + r.height / 2 });
  }

  return (
    <li className="ind-row" onClick={onAdd}>
      <button
        className={"ind-star" + (favorite ? " on" : "")}
        title={favorite ? "Remove from favorites" : "Add to favorites"}
        aria-label={favorite ? "Remove from favorites" : "Add to favorites"}
        aria-pressed={favorite}
        onClick={(e) => {
          e.stopPropagation(); // don't add an instance
          onToggleFavorite();
        }}
      >
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
          <path d="M12 17.3l-5.4 3.3 1.5-6.2L3 10.2l6.3-.5L12 4l2.7 5.7 6.3.5-5.1 4.2 1.5 6.2z" />
        </svg>
      </button>

      {/* Full name with the abbreviation in parens, e.g. "Relative Strength
          Index (RSI)". Uncatalogued indicators fall back to just the code. */}
      <span className="ind-name">
        {title === name ? name : `${title} (${name})`}
      </span>

      {desc && (
        <button
          ref={infoRef}
          className="ind-info"
          aria-label={`About ${name}`}
          onClick={(e) => e.stopPropagation()} // info only; never adds an instance
          onMouseEnter={showTip}
          onMouseLeave={() => setTip(null)}
          onFocus={showTip}
          onBlur={() => setTip(null)}
        >
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <line x1="12" y1="11" x2="12" y2="16" />
            <circle cx="12" cy="7.5" r="0.6" fill="currentColor" stroke="none" />
          </svg>
        </button>
      )}

      {tip &&
        createPortal(
          <div
            className="ind-tooltip"
            style={{ left: tip.x, top: tip.y }}
            role="tooltip"
          >
            <div className="ind-tooltip-title">{title}</div>
            <div className="ind-tooltip-desc">{desc}</div>
          </div>,
          document.body,
        )}
    </li>
  );
}
