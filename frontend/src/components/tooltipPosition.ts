export type Placement = "top" | "bottom" | "left" | "right";

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Placed {
  left: number;
  top: number;
  side: Placement;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));

/**
 * Decide where a tooltip bubble goes relative to its trigger.
 * Pure and DOM-free so it can be unit-tested without a layout engine.
 * - vertical placements (top/bottom) flip to the opposite side if there's no
 *   room, then centre + clamp horizontally.
 * - horizontal placements (left/right) mirror that on the other axis.
 */
export function computePlacement(
  trigger: Box,
  bubble: { width: number; height: number },
  preferred: Placement,
  viewport: { width: number; height: number },
  gap = 8,
  margin = 4,
): Placed {
  const cx = trigger.left + trigger.width / 2;
  const cy = trigger.top + trigger.height / 2;

  if (preferred === "top" || preferred === "bottom") {
    const roomAbove = trigger.top - gap - bubble.height >= margin;
    const roomBelow = trigger.top + trigger.height + gap + bubble.height <= viewport.height - margin;
    let side: Placement = preferred;
    if (preferred === "top" && !roomAbove && roomBelow) side = "bottom";
    if (preferred === "bottom" && !roomBelow && roomAbove) side = "top";
    const top = side === "top"
      ? trigger.top - bubble.height - gap
      : trigger.top + trigger.height + gap;
    const left = clamp(cx - bubble.width / 2, margin, viewport.width - bubble.width - margin);
    return { left, top, side };
  }

  const roomLeft = trigger.left - gap - bubble.width >= margin;
  const roomRight = trigger.left + trigger.width + gap + bubble.width <= viewport.width - margin;
  let side: Placement = preferred;
  if (preferred === "right" && !roomRight && roomLeft) side = "left";
  if (preferred === "left" && !roomLeft && roomRight) side = "right";
  const left = side === "left"
    ? trigger.left - bubble.width - gap
    : trigger.left + trigger.width + gap;
  const top = clamp(cy - bubble.height / 2, margin, viewport.height - bubble.height - margin);
  return { left, top, side };
}
