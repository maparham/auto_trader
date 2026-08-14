// Shared SVG primitives for the strategy-guide diagrams. All colors come from
// the app theme variables (via .sgd-* classes in App.css) so every diagram is
// automatically correct in both light and dark themes. Marks follow the app's
// charting vernacular: thin 2px paths, dashed price levels with direct labels,
// --pos/--neg reserved for long/short semantics.

import type { ReactNode } from "react";

export function Diagram({
  title,
  viewBox,
  children,
}: {
  /** Accessible one-line description; becomes the SVG title. */
  title: string;
  viewBox: string;
  children: ReactNode;
}) {
  return (
    <svg className="sgd" viewBox={viewBox} role="img" aria-label={title}>
      <title>{title}</title>
      {children}
    </svg>
  );
}

/** Dashed horizontal price level (entry / stop / target / reference). */
export function Level({
  x1,
  x2,
  y,
  kind,
  label,
  labelBelow = false,
}: {
  x1: number;
  x2: number;
  y: number;
  kind: "entry" | "stop" | "target" | "ref";
  label: string;
  labelBelow?: boolean;
}) {
  return (
    <g>
      <line className={`sgd-level sgd-level--${kind}`} x1={x1} y1={y} x2={x2} y2={y} />
      <text className="sgd-label" x={x2} y={labelBelow ? y + 14 : y - 5} textAnchor="end">
        {label}
      </text>
    </g>
  );
}

/** Triangle entry/exit marker; long points up (--pos), short down (--neg). */
export function Marker({
  x,
  y,
  side,
  label,
  labelDx = 10,
}: {
  x: number;
  y: number;
  side: "long" | "short";
  label?: string;
  labelDx?: number;
}) {
  const d =
    side === "long"
      ? `M ${x} ${y - 7} L ${x + 6.5} ${y + 5} L ${x - 6.5} ${y + 5} Z`
      : `M ${x} ${y + 7} L ${x + 6.5} ${y - 5} L ${x - 6.5} ${y - 5} Z`;
  return (
    <g>
      <path className={`sgd-marker sgd-marker--${side}`} d={d} />
      {label && (
        <text className="sgd-label sgd-label--strong" x={x + labelDx} y={y + 4}>
          {label}
        </text>
      )}
    </g>
  );
}

/** Horizontal brace under the x axis marking a bar span, with a label. */
export function Span({
  x1,
  x2,
  y,
  label,
}: {
  x1: number;
  x2: number;
  y: number;
  label: string;
}) {
  return (
    <g>
      <path
        className="sgd-span"
        d={`M ${x1} ${y - 5} V ${y} H ${x2} V ${y - 5}`}
        fill="none"
      />
      <text className="sgd-label" x={(x1 + x2) / 2} y={y + 14} textAnchor="middle">
        {label}
      </text>
    </g>
  );
}
