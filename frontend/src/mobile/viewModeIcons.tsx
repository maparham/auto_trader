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

/** Turn the screen: one arc with an arrowhead. In the top bar it enters
 *  landscape; on the axis chip while rotated it turns back to portrait. */
export function RotateIcon() {
  return (
    <svg {...common}>
      <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
      <path d="M13.5 2.5v3.2h-3.2" />
    </svg>
  );
}
