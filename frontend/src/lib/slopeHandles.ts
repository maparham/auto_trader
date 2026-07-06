// Shared pixel geometry for the Slope tool's interactive handles. The overlay PAINTER
// (customOverlays' slope template) and the ChartCore HIT-TESTER both derive the
// midpoint dot, the perpendicular rotate-stem, and the knob position from THIS one
// helper — so the drawn knob and its clickable target can never drift apart.

export interface Pt {
  x: number;
  y: number;
}

export interface SlopeHandles {
  a: Pt; // first endpoint (as given)
  b: Pt; // second endpoint (as given)
  mid: Pt; // line center — the translate handle
  knob: Pt; // rotate knob, offset up a perpendicular stem from the midpoint
}

// Stem length (px) from midpoint to the rotate knob. The lever arm is what makes
// rotation feel proportional rather than twitchy (a knob ON the pivot has zero lever).
export const STEM_PX = 68;
// Click/grab radius (px) around each handle.
export const HANDLE_HIT_PX = 10;

export function slopeHandles(a: Pt, b: Pt): SlopeHandles {
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  // Perpendicular unit vector, forced to point toward screen-up (negative y) so the
  // stem always rises above the line no matter which way the line was drawn.
  let px = -dy / len;
  let py = dx / len;
  if (py > 0) {
    px = -px;
    py = -py;
  }
  return { a, b, mid, knob: { x: mid.x + px * STEM_PX, y: mid.y + py * STEM_PX } };
}

export type SlopeGrab = "a" | "b" | "mid" | "knob";

// Which handle (if any) the pixel `p` grabs. Knob first (it sits off the line, and a
// rotate intent should win where the offset stem overlaps a short line), then the
// endpoints, then the midpoint.
export function hitSlopeHandle(a: Pt, b: Pt, p: Pt, tol = HANDLE_HIT_PX): SlopeGrab | null {
  const h = slopeHandles(a, b);
  const near = (q: Pt): boolean => Math.hypot(p.x - q.x, p.y - q.y) <= tol;
  if (near(h.knob)) return "knob";
  if (near(h.a)) return "a";
  if (near(h.b)) return "b";
  if (near(h.mid)) return "mid";
  return null;
}
