import type { ReactNode } from "react";
import Tooltip from "./Tooltip";

interface InfoTipProps {
  // One string, or several — each rendered as its own description line.
  text: string | string[];
  title?: string;
  // Optional custom trigger (e.g. a ⚠ badge); defaults to the ⓘ glyph.
  children?: ReactNode;
  // Overrides the trigger button's class (default "ind-info").
  className?: string;
}

// A trailing ⓘ that reveals a description tooltip on hover/focus. The tooltip
// mechanics (portal, positioning, timing, animation) all live in <Tooltip>; this
// component only owns the icon trigger and swallows its click so tapping the icon
// inside a menu row / label never triggers the row's action.
export default function InfoTip({ text, title, children, className }: InfoTipProps) {
  return (
    <Tooltip title={title} content={text}>
      <button
        type="button"
        className={className ?? "ind-info"}
        aria-label={title ? `About ${title}` : "More info"}
        tabIndex={-1}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        {children ?? (
          <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <line x1="12" y1="11" x2="12" y2="16" />
            <circle cx="12" cy="7.5" r="0.6" fill="currentColor" stroke="none" />
          </svg>
        )}
      </button>
    </Tooltip>
  );
}
