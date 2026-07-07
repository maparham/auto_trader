// Screen-space snapping helpers for the TradingView-style Shift key while drawing
// or editing overlays. Pure geometry in PIXEL space (that is what "45° on screen"
// means) — the caller converts data↔pixel around these. See
// docs/superpowers/specs/2026-07-07-shift-snap-and-rectangle-design.md.

export interface Pt {
  x: number;
  y: number;
}

// klinecharts synthesizes its own mouse-event objects (_makeCompatEvent) that carry
// only {x,y,pageX,pageY,isTouch} — NOT shiftKey. So overlay event callbacks can't see
// the modifier; we track it ourselves off the window, which also gives the live
// press/release-mid-drag toggle (a keydown/keyup fires independently of the drag).
let shiftHeld = false;
let installed = false;
function installShiftTracker(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("keydown", (e) => { if (e.key === "Shift") shiftHeld = true; }, true);
  window.addEventListener("keyup", (e) => { if (e.key === "Shift") shiftHeld = false; }, true);
  window.addEventListener("blur", () => { shiftHeld = false; });
}
installShiftTracker();
export function isShiftHeld(): boolean {
  return shiftHeld;
}

// Snap the moving endpoint to the nearest 45° screen angle relative to the anchored
// endpoint (horizontal, vertical, or a 45° diagonal — the 8 principal directions),
// preserving the cursor's distance along that locked direction. Screen-y is
// down-positive, so a snapped-flat vector paints a perfectly horizontal line.
export function snapScreenAngle(fixed: Pt, moving: Pt): Pt {
  const dx = moving.x - fixed.x;
  const dy = moving.y - fixed.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return { x: fixed.x, y: fixed.y };
  const step = Math.PI / 4;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  return { x: fixed.x + Math.cos(angle) * len, y: fixed.y + Math.sin(angle) * len };
}

// Snap the moving corner so the box is a perfect on-screen square about the anchored
// corner: equal |Δx| and |Δy| (the larger extent wins so the square encloses the
// cursor), keeping the drag direction in each axis.
export function snapSquare(fixed: Pt, moving: Pt): Pt {
  const dx = moving.x - fixed.x;
  const dy = moving.y - fixed.y;
  const s = Math.max(Math.abs(dx), Math.abs(dy));
  const sx = dx < 0 ? -1 : 1;
  const sy = dy < 0 ? -1 : 1;
  return { x: fixed.x + sx * s, y: fixed.y + sy * s };
}
