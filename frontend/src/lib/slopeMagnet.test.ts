import { describe, it, expect } from "vitest";
import { snapSlopeEndpoint } from "./slopeMagnet";

// A bar's four OHLC candidates at known pixel ys. The cursor is dragged near them and we
// assert whether the endpoint price snaps, per magnet mode.
const cands = [
  { price: 100.0, py: 400 }, // open
  { price: 101.0, py: 340 }, // high
  { price: 99.0, py: 460 }, //  low
  { price: 100.5, py: 370 }, // close
];

describe("snapSlopeEndpoint", () => {
  it("never snaps in normal mode", () => {
    expect(snapSlopeEndpoint(100.42, 372, cands, "normal")).toBe(100.42);
  });

  it("always snaps to the nearest OHLC in strong mode, even when far", () => {
    // cursor pixel 372 is nearest the close (py 370) → snaps to 100.5, regardless of gap
    expect(snapSlopeEndpoint(100.42, 372, cands, "strong_magnet")).toBe(100.5);
    // far cursor still snaps in strong mode
    expect(snapSlopeEndpoint(100.42, 372, cands, "strong_magnet", 2)).toBe(100.5);
  });

  it("weak mode snaps only when the nearest candidate is within sensitivity", () => {
    // 2px from the close (370) → within default 16px → snaps
    expect(snapSlopeEndpoint(100.42, 372, cands, "weak_magnet")).toBe(100.5);
    // 30px from the nearest candidate (open at py 400) → outside 16px → stays raw
    expect(snapSlopeEndpoint(99.5, 430, cands, "weak_magnet")).toBe(99.5);
  });

  it("respects a custom sensitivity threshold", () => {
    // 6px from close: snaps at 8px sensitivity, not at 4px
    expect(snapSlopeEndpoint(100.4, 376, cands, "weak_magnet", 8)).toBe(100.5);
    expect(snapSlopeEndpoint(100.4, 376, cands, "weak_magnet", 4)).toBe(100.4);
  });

  it("returns the raw price when there are no candidates", () => {
    expect(snapSlopeEndpoint(100.42, 372, [], "strong_magnet")).toBe(100.42);
  });
});
