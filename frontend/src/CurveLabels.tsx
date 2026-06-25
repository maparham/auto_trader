// Curve-end parameter labels: small DOM pills shown at the right (or left) end of
// each plotted curve of a SELECTED or HIGHLIGHTED indicator, naming that curve's
// key parameter (e.g. Prev HL's day high/low → "1d"). DOM, not canvas, so the text
// stays crisp (the same reason the legend was moved off canvas). Membership/text is
// React state but updated imperatively via a handle from ChartCore's redraw loop —
// no React re-render per crosshair pixel. Positioned with `transform: translate`
// (compositor-only, no layout reflow) over the full-height overlay region.

import { useImperativeHandle, useRef, useState, type Ref } from "react";

export type CurveLabelSide = "right" | "left";
export type CurveLabelAlign = "above" | "center" | "below";

// One resolved pill: text + the curve-end pixel anchor (container-absolute, the
// same space as the selection overlay) + its style + placement.
export interface CurveLabelPill {
  key: string; // stable React key (paneId:name:figKey)
  text: string;
  x: number;
  y: number;
  color: string;
  side: CurveLabelSide;
  align: CurveLabelAlign;
  // Right edge of the chart's main plot (px). Right-side pills are clamped to this
  // so a curve ending at the latest bar doesn't push the label over the price axis.
  maxX: number;
}

export interface CurveLabelsHandle {
  setPills(pills: CurveLabelPill[]): void;
}

// Translate a pill's (x,y) anchor + side/align into a CSS transform. The anchor is
// the curve END; the pill sits just PAST it on the chosen side, and is shifted
// vertically so "above"/"below" clear the line. Percentages are of the pill's own
// box so it works regardless of text width.
function pillTransform(p: CurveLabelPill): string {
  const GAP = 5; // px gap between the curve end and the pill
  // Horizontal: right → pill starts at x+GAP, but clamped with min() so its right
  // edge never passes the plot edge (maxX − own width); left → pill ends at x−GAP,
  // clamped with max() so it never runs off the left. `100%` = the pill's own width.
  const tx =
    p.side === "right"
      ? `min(${p.x + GAP}px, ${p.maxX}px - 100%)`
      : `max(0px, ${p.x - GAP}px - 100%)`;
  // Vertical: center → middle on the line; above → bottom edge a hair above; below
  // → top edge a hair below.
  const ty =
    p.align === "center"
      ? `calc(${p.y}px - 50%)`
      : p.align === "above"
        ? `calc(${p.y}px - 100% - 2px)`
        : `calc(${p.y}px + 2px)`;
  return `translate(${tx}, ${ty})`;
}

// Cheap signature of the rendered pills — every field that affects output. Lets
// setPills skip the state update (and the re-render) when nothing visible changed.
function pillsSig(pills: CurveLabelPill[]): string {
  return pills
    .map(
      (p) =>
        `${p.key}@${Math.round(p.x)},${Math.round(p.y)}:${p.text}:${p.color}:${p.side}:${p.align}:${Math.round(p.maxX)}`,
    )
    .join("|");
}

export default function CurveLabels({ handleRef }: { handleRef?: Ref<CurveLabelsHandle> }) {
  const [pills, setPills] = useState<CurveLabelPill[]>([]);
  const sigRef = useRef("");
  // ChartCore's redraw loop calls setPills on every tick/scroll/zoom with a fresh
  // array — usually [] (no selected/hovered indicator). Guard on a signature so the
  // common idle case is a no-op instead of a React re-render to the same output.
  useImperativeHandle(
    handleRef,
    () => ({
      setPills(next: CurveLabelPill[]) {
        const sig = pillsSig(next);
        if (sig === sigRef.current) return;
        sigRef.current = sig;
        setPills(next);
      },
    }),
    [],
  );

  if (pills.length === 0) return null;
  return (
    <div
      data-testid="curve-labels"
      style={{ position: "absolute", inset: 0, zIndex: 11, pointerEvents: "none" }}
    >
      {pills.map((p) => (
        <span
          key={p.key}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            transform: pillTransform(p),
            whiteSpace: "nowrap",
            font: "11px -apple-system, system-ui, sans-serif",
            lineHeight: "14px",
            padding: "1px 4px",
            borderRadius: 3,
            color: "#fff",
            background: p.color,
          }}
        >
          {p.text}
        </span>
      ))}
    </div>
  );
}
