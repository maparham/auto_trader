// Inline SVG glyphs for the backtest panel's buttons. All use currentColor.

// Results-column icon: a panel with a column pane on the left and an arrow
// pointing at it — results pop out INTO that column. `flipped` mirrors the
// whole icon for the closing direction (pane on the right = the config panel,
// arrow pointing right = results dock back into it). `currentColor` so it
// inherits the button's colour.
export function ColumnGlyph({ flipped = false }: { flipped?: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="15"
      height="15"
      aria-hidden="true"
      style={flipped ? { transform: "scaleX(-1)" } : undefined}
    >
      <g fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
        <path d="M5.5 2.5 V13.5" />
        <path d="M12.5 8 H8.2" />
        <path d="M10.2 5.9 L8 8 L10.2 10.1" />
      </g>
    </svg>
  );
}

// Sweep toggle icon: three equalizer faders at staggered heights — a parameter
// sweep tunes a value across a range of settings. `currentColor` so it inherits
// the button's colour, including the accent when the axis is on (.sp-sweep.on).
export function SweepGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" className="bt-sweep-icon">
      <g fill="none" stroke="currentColor" strokeLinecap="round">
        <path d="M4 2.5 V13.5 M8 2.5 V13.5 M12 2.5 V13.5" strokeWidth="1.2" opacity="0.55" />
        <path d="M2.4 9 H5.6 M6.4 5 H9.6 M10.4 10.5 H13.6" strokeWidth="2.2" />
      </g>
    </svg>
  );
}

export function KebabIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <circle cx="12" cy="5" r="1.7" fill="currentColor" />
      <circle cx="12" cy="12" r="1.7" fill="currentColor" />
      <circle cx="12" cy="19" r="1.7" fill="currentColor" />
    </svg>
  );
}

// Two overlapping sheets — the standard "copy" glyph, reused for both the
// copy-all and paste-all whole-group actions.
export function CopyAllIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="9" y="9" width="11" height="11" rx="2" strokeLinejoin="round" />
      <path d="M5 15 H4.5 A1.5 1.5 0 0 1 3 13.5 V4.5 A1.5 1.5 0 0 1 4.5 3 h9 A1.5 1.5 0 0 1 15 4.5 V5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// The ✓ the copy-all button swaps to while its "copied" flash is up.
export function CheckSmallIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4.5 12.5 10 17.5 19.5 6.5" />
    </svg>
  );
}

export function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 6h16" />
      <path d="M9 6V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V6" />
      <path d="M6 6l1 13.5A1.5 1.5 0 0 0 8.5 21h7a1.5 1.5 0 0 0 1.5-1.5L18 6" />
      <path d="M10 10.5v6M14 10.5v6" />
    </svg>
  );
}
