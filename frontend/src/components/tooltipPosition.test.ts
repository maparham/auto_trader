import { describe, it, expect } from "vitest";
import { computePlacement } from "./tooltipPosition";

const VP = { width: 1000, height: 800 };
// a 40x20 trigger centred horizontally, mid-screen
const mid = { left: 480, top: 400, width: 40, height: 20 };
const bubble = { width: 120, height: 40 };

describe("computePlacement", () => {
  it("places on the preferred side (top) with the gap, horizontally centred", () => {
    const p = computePlacement(mid, bubble, "top", VP, 8);
    expect(p.side).toBe("top");
    // top = trigger.top - bubble.height - gap
    expect(p.top).toBe(400 - 40 - 8);
    // left = trigger centre - half bubble width = 500 - 60
    expect(p.left).toBe(440);
  });

  it("flips top->bottom when there is no room above", () => {
    const nearTop = { left: 480, top: 4, width: 40, height: 20 };
    const p = computePlacement(nearTop, bubble, "top", VP, 8);
    expect(p.side).toBe("bottom");
    expect(p.top).toBe(4 + 20 + 8);
  });

  it("shifts inward on the cross axis instead of overflowing the right edge", () => {
    const nearRight = { left: 970, top: 400, width: 40, height: 20 };
    const p = computePlacement(nearRight, bubble, "top", VP, 8, 4);
    // would be centred at 990 -> left 930, overflows (930+120=1050>996); clamp
    expect(p.left).toBe(VP.width - bubble.width - 4); // 876
  });

  it("flips right->left when there is no room to the right", () => {
    const nearRight = { left: 900, top: 400, width: 40, height: 20 };
    const p = computePlacement(nearRight, bubble, "right", VP, 8);
    expect(p.side).toBe("left");
    expect(p.left).toBe(900 - bubble.width - 8);
  });
});
