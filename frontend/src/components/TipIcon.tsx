import type { ReactNode } from "react";
import Tooltip from "./Tooltip";

interface TipIconProps {
  // One string, or several lines, each rendered as its own description line.
  text: string | Array<string | ReactNode>;
  title?: string;
}

// The ⓘ that lives *inside* a tab and carries that tab's explanation. Two
// reasons it is not <InfoTip>: it renders inside a <button> (a nested button is
// invalid HTML, so the trigger is a span), and the tip hangs off the icon
// rather than the whole tab — a tab row is a picker, and a tooltip on the tab
// itself fires while you are only sweeping across the row to click one.
// Pointer events fall through to the tab, which is what pointing at a picker
// means anyway.
export default function TipIcon({ text, title }: TipIconProps) {
  return (
    <Tooltip title={title} content={text}>
      <span className="tip-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="11" height="11" fill="none"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="12" cy="12" r="9" />
          <line x1="12" y1="11" x2="12" y2="16" />
          <circle cx="12" cy="7.5" r="0.6" fill="currentColor" stroke="none" />
        </svg>
      </span>
    </Tooltip>
  );
}
