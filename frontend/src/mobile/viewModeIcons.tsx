// The maximize / restore / rotate icons for the mobile chart. Same box, same stroke,
// mirrored meaning: arrows leaving the centre to maximize, arrows returning
// to it to restore, so the button reads as one control flipping state.
const common = {
  width: 16,
  height: 16,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

export function MaximizeIcon() {
  return (
    <svg {...common}>
      <path d="M9.5 2.5h4v4M13.5 2.5L9 7M6.5 13.5h-4v-4M2.5 13.5L7 9" />
    </svg>
  );
}

export function RestoreIcon() {
  return (
    <svg {...common}>
      <path d="M13.5 6.5h-4v-4M9.5 6.5L14 2M2.5 9.5h4v4M6.5 9.5L2 14" />
    </svg>
  );
}

/** Turn the screen: a sideways phone under a half-turn arrow. A bare
 *  circular arrow read as the page-refresh button, so the phone carries the
 *  meaning. In the top bar it enters landscape; on the axis chip while
 *  rotated it turns back to portrait. */
export function RotateIcon() {
  return (
    <svg {...common}>
      <rect x="2" y="8" width="12" height="6.5" rx="1.5" />
      <path d="M3.5 5.5a5.5 5.5 0 0 1 9 0" />
      <path d="M12.8 2.6v2.9h-2.9" />
    </svg>
  );
}

// Gear for the tab bar's Settings button: same 16px box and stroke as the
// view-mode icons so the bar reads as one set.
export const GearIcon = () => (
  <svg {...common} width={18} height={18} strokeWidth={1.4}>
    <circle cx="8" cy="8" r="2.2" />
    <path d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M3.4 12.6l1.3-1.3M11.3 4.7l1.3-1.3" />
    <circle cx="8" cy="8" r="4.6" />
  </svg>
);
