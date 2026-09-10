// A tap on a phone must reach the same pill/line selection a mouse click does.
// The chart canvas swallows the synthetic mouse events (verified on device: a tap
// emits only pointerdown/touchstart/pointerup/touchend), so ChartCore drives
// selection off the pointer events instead — and this module decides which of
// those gestures counts as a tap rather than a pan, a pinch or a long press.
import { describe, it, expect } from "vitest";
import {
  TAP_MOVE_PX,
  TAP_MS,
  tapStart,
  tapMove,
  tapSecondFinger,
  isTap,
  clickSuppressed,
} from "./touchTap";

describe("touchTap gesture predicate", () => {
  it("counts a still, prompt release as a tap", () => {
    const s = tapStart(100, 200, 1_000);
    expect(isTap(s, 1_120)).toBe(true);
  });

  it("rejects a release with no press behind it", () => {
    expect(isTap(null, 1_000)).toBe(false);
  });

  it("rejects a drag: a pan past the slop budget is not a tap", () => {
    let s = tapStart(100, 200, 1_000);
    s = tapMove(s, 100 + TAP_MOVE_PX + 1, 200);
    expect(isTap(s, 1_100)).toBe(false);
  });

  it("tolerates the finger wobble inside the slop budget", () => {
    let s = tapStart(100, 200, 1_000);
    s = tapMove(s, 100 + TAP_MOVE_PX - 1, 200);
    expect(isTap(s, 1_100)).toBe(true);
  });

  it("measures slop on both axes, not just x", () => {
    let s = tapStart(100, 200, 1_000);
    s = tapMove(s, 100, 200 + TAP_MOVE_PX + 1);
    expect(isTap(s, 1_100)).toBe(false);
  });

  it("rejects a long press: holding past the budget is not a tap", () => {
    const s = tapStart(100, 200, 1_000);
    expect(isTap(s, 1_000 + TAP_MS + 1)).toBe(false);
  });

  it("rejects a pinch: a second finger cancels the gesture outright", () => {
    let s = tapStart(100, 200, 1_000);
    s = tapSecondFinger(s);
    expect(isTap(s, 1_050)).toBe(false);
  });

  it("stays cancelled after the second finger lifts and the hand stills", () => {
    let s = tapStart(100, 200, 1_000);
    s = tapSecondFinger(s);
    s = tapMove(s, 100, 200);
    expect(isTap(s, 1_050)).toBe(false);
  });
});

describe("touchTap click suppression", () => {
  it("swallows the synthetic click a handled tap may still produce", () => {
    expect(clickSuppressed(1_000, 1_100)).toBe(true);
  });

  it("lets a genuine later click through", () => {
    expect(clickSuppressed(1_000, 1_000 + TAP_MS + 1)).toBe(false);
  });

  it("lets every click through when no tap has been handled", () => {
    expect(clickSuppressed(null, 1_000)).toBe(false);
  });
});
