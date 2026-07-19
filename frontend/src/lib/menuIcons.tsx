// Inline SVG icons for context-menu items. Inline (not the Material Symbols
// woff2, which is subset to only 4 glyphs) so any action can have a crisp icon
// without re-subsetting the font — same approach as the legend's ⋯ button.
// 16px, 1.5px stroke, currentColor so they inherit the item's hover color.

import type { ReactNode } from "react";

function svg(children: ReactNode): ReactNode {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

// Bell glyph shared by the toolbar's alerts-panel toggle and the on-chart alert
// tags. Sized per caller (toolbar 16, chart tag 11); currentColor so each inherits
// its context's color. Standalone (not in MenuIcons) because those are fixed-size.
export function BellIcon({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 8A6 6 0 1 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </svg>
  );
}

// Ruler glyph for the toolbar's Measure toggle. A tilted ruler with tick marks,
// echoing TradingView's measure tool icon. currentColor so it inherits the button
// state (accent when armed).
export function RulerIcon({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="1.8" y="7.8" width="20.4" height="8.4" rx="1.5" transform="rotate(-45 12 12)" />
      <path d="M8.5 8.5l1.6 1.6M11 6l2.4 2.4M13.5 3.5l1.6 1.6" />
    </svg>
  );
}

// Slope glyph for the angle-ruler toggle: a rising line between two endpoint handles
// with a little angle arc at the base — reads as "measure the slope / angle". Same
// currentColor idiom as RulerIcon so it lights up when armed.
export function SlopeIcon({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 20h16" opacity="0.5" />
      <path d="M5 19L19 7" />
      <path d="M5 19a9 9 0 0 0 3.4-4.2" opacity="0.7" />
      <circle cx="5" cy="19" r="1.9" fill="currentColor" stroke="none" />
      <circle cx="19" cy="7" r="1.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

// Zoom-to-range glyph: a magnifier with a small range bracket inside the lens —
// reads as "zoom into this time span". Same 24x24 / currentColor conventions as
// RulerIcon/SlopeIcon so it lights up when armed.
export function ZoomRangeIcon({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="10" cy="10" r="6.5" />
      <path d="M14.8 14.8L21 21" />
      <path d="M6.8 10h6.4" opacity="0.85" />
      <path d="M6.8 8v4M13.2 8v4" opacity="0.85" />
    </svg>
  );
}

// Horseshoe magnet, angled −45° with detached pole caps (matches the user's
// reference art). "Filled" look built from thick butt-capped strokes so it
// still inherits currentColor like every other icon here.
export function MagnetIcon({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none"
      stroke="currentColor" strokeWidth="3.8" strokeLinecap="butt"
      aria-hidden="true">
      {/* Mirrored horizontally (user preference) — poles point up-right. */}
      <g transform="translate(24 0) scale(-1 1) rotate(-45 12 12)">
        <path d="M8.2 9.4v2.8a3.8 3.8 0 0 0 7.6 0V9.4" />
        <path d="M8.2 4.4v2.6" />
        <path d="M15.8 4.4v2.6" />
      </g>
    </svg>
  );
}

// "Strong Magnet": the same angled horseshoe with a lightning bolt striking
// from the top-right (the magnet-flyout rows pair Weak=plain / Strong=bolt,
// per the user's reference art).
export function StrongMagnetIcon({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none"
      stroke="currentColor" strokeWidth="3.6" strokeLinecap="butt"
      aria-hidden="true">
      {/* Mirrored horizontally (user preference) — bolt strikes from top-left. */}
      <g transform="translate(24 0) scale(-1 1)">
        <g transform="rotate(-45 13 14) translate(1.6 3.2)">
          <path d="M8.4 9.4v2.5a3.6 3.6 0 0 0 7.2 0V9.4" />
          <path d="M8.4 4.8v2.4" />
          <path d="M15.6 4.8v2.4" />
        </g>
        <path fill="currentColor" stroke="none"
          d="M23 0.6l-7.6 3.6 2.5 1.4-5 4.6 7.9-3.5-2.5-1.4z" />
      </g>
    </svg>
  );
}

export const MenuIcons = {
  settings: svg(
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>,
  ),
  clone: svg(
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </>,
  ),
  copy: svg(
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </>,
  ),
  bringFront: svg(
    <>
      <rect x="4" y="4" width="12" height="12" rx="1.5" />
      <path d="M16 8h2a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2v-2" />
    </>,
  ),
  sendBack: svg(
    <>
      <rect x="8" y="8" width="12" height="12" rx="1.5" />
      <path d="M8 16H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2" />
    </>,
  ),
  moveUp: svg(
    <>
      <path d="M12 19V5" />
      <path d="M5 12l7-7 7 7" />
    </>,
  ),
  moveDown: svg(
    <>
      <path d="M12 5v14" />
      <path d="M5 12l7 7 7-7" />
    </>,
  ),
  lock: svg(
    <>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </>,
  ),
  unlock: svg(
    <>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 7.4-2" />
    </>,
  ),
  hide: svg(
    <>
      <path d="M9.9 4.24A9.1 9.1 0 0 1 12 4c7 0 10 8 10 8a18 18 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
      <path d="M6.6 6.6A18 18 0 0 0 2 12s3 8 10 8a9 9 0 0 0 5.4-1.6" />
      <path d="M2 2l20 20" />
    </>,
  ),
  show: svg(
    <>
      <path d="M2 12s3-8 10-8 10 8 10 8-3 8-10 8-10-8-10-8z" />
      <circle cx="12" cy="12" r="3" />
    </>,
  ),
  remove: svg(
    <>
      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    </>,
  ),
  paste: svg(
    <>
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <rect x="8" y="2" width="8" height="4" rx="1" />
    </>,
  ),
  // Floppy disk — "save / overwrite this template".
  save: svg(
    <>
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
      <path d="M17 21v-8H7v8M7 3v5h8" />
    </>,
  ),
  // Checkmark — "apply this template to the current chart".
  apply: svg(<path d="M20 6L9 17l-5-5" />),
  // Star — marks the global, symbol-agnostic default template.
  star: svg(
    <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14l-5-4.87 6.91-1.01L12 2z" />,
  ),
  // Bell — "add alert here" (menu-weight twin of the standalone BellIcon).
  bell: svg(
    <>
      <path d="M18 8A6 6 0 1 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </>,
  ),
  // Horizontal line with endpoint handles — "draw a horizontal line here".
  horizontalLine: svg(
    <>
      <circle cx="4.5" cy="12" r="1.7" />
      <circle cx="19.5" cy="12" r="1.7" />
      <path d="M6.4 12h11.2" />
    </>,
  ),
  // Up chevron — "buy limit" (long).
  chevronUp: svg(<path d="M6 15l6-6 6 6" />),
  // Down chevron — "sell limit" (short).
  chevronDown: svg(<path d="M6 9l6 6 6-6" />),
};
