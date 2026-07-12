// Crossing points between the SELECTED candle-pane curve and every other
// visible candle-pane curve — the dots painted while an indicator is selected.
// Works entirely in pixel space on the LineCache the selection painter already
// uses: the drawn curves are straight segments between bar pixels, so a
// pixel-space intersection sits exactly on the visible crossing (log scale
// included). Pixel y grows downward, so "selected crosses ABOVE the other" (in
// price) means its y-difference flips from positive to negative.
import type { LineCache } from "./chartGeometry";

export interface CrossingDot {
  x: number;
  y: number;
  dir: "up" | "down"; // selected curve crossed above/below the other curve
}

type Pt = { x: number; y: number; t: number };

// Crossings of `selected` through `other`, aligned by bar timestamp. A missing
// timestamp in `other` breaks the run (a flip across a data gap is not a
// crossing). An exact touch (zero difference) counts only when the sign differs
// on both sides — touch-and-cross marks the touch point once; touch-and-bounce
// is skipped.
export function findCrossings(selected: Pt[], other: Pt[]): CrossingDot[] {
  const otherY = new Map(other.map((p) => [p.t, p.y]));
  const out: CrossingDot[] = [];
  let prevSign = 0; // last NONZERO sign seen (0 = none yet / run broken)
  let touch: { x: number; y: number } | null = null; // first point of a zero run
  let prev: { x: number; y: number; d: number } | null = null;
  for (const p of selected) {
    const oy = otherY.get(p.t);
    if (oy === undefined) {
      prevSign = 0;
      touch = null;
      prev = null;
      continue;
    }
    const d = p.y - oy;
    const sign = Math.sign(d);
    if (sign === 0) {
      touch ??= { x: p.x, y: p.y };
      prev = { x: p.x, y: p.y, d };
      continue;
    }
    if (prevSign !== 0 && sign !== prevSign) {
      const dir = sign < 0 ? "up" : "down";
      if (touch) {
        out.push({ ...touch, dir });
      } else if (prev) {
        const f = prev.d / (prev.d - d);
        out.push({ x: prev.x + f * (p.x - prev.x), y: prev.y + f * (p.y - prev.y), dir });
      }
    }
    touch = null;
    prevSign = sign;
    prev = { x: p.x, y: p.y, d };
  }
  return out;
}

// All crossing dots for the current selection: every figure of the selected
// indicator vs every other candle-pane curve. Sibling figures of the selected
// instance are excluded (a band "crossing" its own midline is not signal), and
// non-candle-pane selections get nothing — sub-panes have their own price
// scale, so an intersection there is meaningless. Hidden curves never reach
// the LineCache, so visibility needs no check here.
export function crossingsForSelection(
  cache: LineCache[],
  sel: { paneId: string; name: string },
): CrossingDot[] {
  if (sel.paneId !== "candle_pane") return [];
  const out: CrossingDot[] = [];
  for (const line of cache) {
    if (line.paneId !== "candle_pane" || line.name !== sel.name) continue;
    for (const other of cache) {
      if (other.paneId !== "candle_pane" || other.name === sel.name) continue;
      out.push(...findCrossings(line.coords, other.coords));
    }
  }
  return out;
}
