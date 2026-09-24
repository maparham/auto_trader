// Tap detection for the chart canvas.
//
// klinecharts' canvas consumes the touch sequence, so Chrome never emits the
// synthetic mousedown/mousemove/click that the pill and line selection paths
// listen on: on a phone a tap produces pointerdown/touchstart/pointerup/
// touchend and nothing else. ChartCore therefore runs its click handler off
// pointerup for touch, and this module answers the one question that decision
// needs: was that gesture a tap, or a pan, a pinch, or a long press?
//
// Pure and framework-free so the thresholds are testable on their own.

/** Finger wobble tolerated before a press reads as a drag. */
export const TAP_MOVE_PX = 10;
/** Longest press still treated as a tap (beyond it, it's a hold). */
export const TAP_MS = 700;

export interface TapState {
  x: number;
  y: number;
  t: number;
  /** Moved past the slop budget, or cancelled by a second finger. */
  cancelled: boolean;
}

export function tapStart(x: number, y: number, t: number): TapState {
  return { x, y, t, cancelled: false };
}

/** Track the finger; once cancelled a gesture never recovers, so stilling the
 *  hand mid-pan (or lifting the second finger of a pinch) can't revive it. */
export function tapMove(s: TapState | null, x: number, y: number): TapState | null {
  if (!s || s.cancelled) return s;
  if (Math.abs(x - s.x) > TAP_MOVE_PX || Math.abs(y - s.y) > TAP_MOVE_PX) {
    return { ...s, cancelled: true };
  }
  return s;
}

/** A pinch/two-finger gesture: never a tap, whatever the fingers do next. */
export function tapSecondFinger(s: TapState | null): TapState | null {
  return s ? { ...s, cancelled: true } : s;
}

export function isTap(s: TapState | null, t: number): boolean {
  if (!s || s.cancelled) return false;
  return t - s.t <= TAP_MS;
}

/** A handled tap must not act twice if the browser does deliver a click after
 *  it: selection is a toggle, so the second run would undo the first. */
export function clickSuppressed(lastTapT: number | null, t: number): boolean {
  if (lastTapT == null) return false;
  return t - lastTapT <= TAP_MS;
}

/** Second tap within this long of the first reads as a double tap. */
export const DOUBLE_TAP_MS = 300;
/** ...and within this far of it, per axis (looser than TAP_MOVE_PX: two
 *  separate presses land less precisely than one finger holding still). */
export const DOUBLE_TAP_PX = 25;

/** Is a tap at (x, y, t) the second half of a double tap begun by `first`
 *  (the previous handled tap's press)? The canvas swallows the synthetic
 *  dblclick just as it does click, so ChartCore replays its dblclick chain
 *  off this. */
export function isDoubleTap(first: TapState | null, x: number, y: number, t: number): boolean {
  if (!first) return false;
  if (t - first.t > DOUBLE_TAP_MS) return false;
  return Math.abs(x - first.x) <= DOUBLE_TAP_PX && Math.abs(y - first.y) <= DOUBLE_TAP_PX;
}

/** A still press held this long is a long press: over a drawing it opens the
 *  right-click menu (ChartCore replays it as a right-button press). Matches
 *  klinecharts' own long-tap delay, which places the crosshair elsewhere. */
export const LONG_PRESS_MS = 500;
