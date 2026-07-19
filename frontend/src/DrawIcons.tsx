// Mini TV-style glyphs for the drawing tools: a picture of each tool next to
// its name (sidebar family buttons, favorites zone, and flyout rows). One
// component keyed by klinecharts overlay name so callers never switch on it.

import type { ReactNode } from "react";

interface GlyphProps {
  name: string;
}

const S = {
  width: 20,
  height: 20,
  viewBox: "0 0 20 20",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round" as const,
  "aria-hidden": true,
};

// Hollow anchor dot (TV's endpoint circles).
function Dot({ x, y }: { x: number; y: number }) {
  return <circle cx={x} cy={y} r={1.6} />;
}

const GLYPHS: Record<string, () => ReactNode> = {
  // Trend line: diagonal segment, both endpoints dotted.
  segment: () => (
    <svg {...S}>
      <line x1="5.2" y1="14.8" x2="14.8" y2="5.2" />
      <Dot x={4} y={16} />
      <Dot x={16} y={4} />
    </svg>
  ),
  // Ray: one dotted origin, line runs off the corner.
  rayLine: () => (
    <svg {...S}>
      <line x1="5.2" y1="14.8" x2="18" y2="2" />
      <Dot x={4} y={16} />
    </svg>
  ),
  // Extended line: runs off both corners, mid anchors dotted.
  straightLine: () => (
    <svg {...S}>
      <line x1="2" y1="18" x2="18" y2="2" />
      <Dot x={7} y={13} />
      <Dot x={13} y={7} />
    </svg>
  ),
  // Horizontal line: full-width line, center anchor dotted.
  horizontalStraightLine: () => (
    <svg {...S}>
      <line x1="2" y1="10" x2="18" y2="10" />
      <Dot x={10} y={10} />
    </svg>
  ),
  // Vertical line: full-height line, center anchor dotted.
  verticalStraightLine: () => (
    <svg {...S}>
      <line x1="10" y1="2" x2="10" y2="18" />
      <Dot x={10} y={10} />
    </svg>
  ),
  // Price line: horizontal ray from a dot + a little price tag on the right.
  priceLine: () => (
    <svg {...S}>
      <line x1="4" y1="10" x2="12" y2="10" />
      <Dot x={4} y={10} />
      <rect x="12.5" y="7.5" width="5.5" height="5" rx="1" />
    </svg>
  ),
  // Parallel channel: two parallel diagonals, anchors on the main one.
  priceChannelLine: () => (
    <svg {...S}>
      <line x1="3" y1="13" x2="14" y2="4" />
      <line x1="6" y1="17" x2="17" y2="8" />
      <Dot x={3} y={13} />
      <Dot x={14} y={4} />
    </svg>
  ),
  // Rectangle: a box with two opposite corners dotted (the draggable anchors).
  rect: () => (
    <svg {...S}>
      <rect x="4" y="6" width="12" height="8" rx="0.5" />
      <Dot x={4} y={6} />
      <Dot x={16} y={14} />
    </svg>
  ),
  // Fib retracement: stacked horizontal levels, top+bottom anchored.
  fibonacciLine: () => (
    <svg {...S}>
      <line x1="3" y1="4.5" x2="17" y2="4.5" />
      <line x1="3" y1="10" x2="17" y2="10" />
      <line x1="3" y1="15.5" x2="17" y2="15.5" />
      <Dot x={5} y={4.5} />
      <Dot x={15} y={15.5} />
    </svg>
  ),
  // Time range: a full-height vertical band (two edges) marking a time span.
  timeRange: () => (
    <svg {...S}>
      <rect x="6" y="3" width="8" height="14" rx="0.5" fill="currentColor" fillOpacity="0.12" />
      <line x1="6" y1="3" x2="6" y2="17" />
      <line x1="14" y1="3" x2="14" y2="17" />
    </svg>
  ),
};

export default function DrawGlyph({ name }: GlyphProps) {
  const G = GLYPHS[name] ?? GLYPHS.segment;
  return <G />;
}
