import { describe, it, expect } from "vitest";
import { findCrossings, crossingsForSelection } from "./curveCrossings";
import type { LineCache } from "./chartGeometry";

// Pixel-space points: y grows DOWNWARD, so "selected crosses above the other
// curve" (in price) means its y goes from greater to smaller than the other's.
const pt = (x: number, y: number, t: number) => ({ x, y, t });

describe("findCrossings", () => {
  it("detects an upward crossing and interpolates the intersection", () => {
    // selected rises through a flat other line between t=0 and t=1
    const selected = [pt(0, 20, 0), pt(10, 10, 1)];
    const other = [pt(0, 15, 0), pt(10, 15, 1)];
    const out = findCrossings(selected, other);
    expect(out).toHaveLength(1);
    expect(out[0].dir).toBe("up");
    expect(out[0].x).toBeCloseTo(5);
    expect(out[0].y).toBeCloseTo(15);
  });

  it("detects a downward crossing", () => {
    const selected = [pt(0, 10, 0), pt(10, 20, 1)];
    const other = [pt(0, 15, 0), pt(10, 15, 1)];
    const out = findCrossings(selected, other);
    expect(out).toHaveLength(1);
    expect(out[0].dir).toBe("down");
  });

  it("interpolates asymmetric gaps to the true intersection", () => {
    // d goes +9 → -1: intersection at 90% of the segment
    const selected = [pt(0, 24, 0), pt(10, 14, 1)];
    const other = [pt(0, 15, 0), pt(10, 15, 1)];
    const out = findCrossings(selected, other);
    expect(out).toHaveLength(1);
    expect(out[0].x).toBeCloseTo(9);
    expect(out[0].y).toBeCloseTo(15);
  });

  it("counts touch-and-cross once, at the touch point", () => {
    // d: +5, 0, -5 — one crossing, dot exactly on the shared point
    const selected = [pt(0, 20, 0), pt(10, 15, 1), pt(20, 10, 2)];
    const other = [pt(0, 15, 0), pt(10, 15, 1), pt(20, 15, 2)];
    const out = findCrossings(selected, other);
    expect(out).toHaveLength(1);
    expect(out[0].dir).toBe("up");
    expect(out[0].x).toBeCloseTo(10);
    expect(out[0].y).toBeCloseTo(15);
  });

  it("ignores touch-and-bounce (no sign flip)", () => {
    // d: +5, 0, +5 — curves kiss and part, not a crossing
    const selected = [pt(0, 20, 0), pt(10, 15, 1), pt(20, 20, 2)];
    const other = [pt(0, 15, 0), pt(10, 15, 1), pt(20, 15, 2)];
    expect(findCrossings(selected, other)).toHaveLength(0);
  });

  it("skips sign flips across a data gap in the other series", () => {
    // other has no value at t=1: the flip between t=0 and t=2 is not adjacent
    const selected = [pt(0, 20, 0), pt(10, 15, 1), pt(20, 10, 2)];
    const other = [pt(0, 15, 0), pt(20, 15, 2)];
    expect(findCrossings(selected, other)).toHaveLength(0);
  });

  it("finds multiple crossings in both directions", () => {
    const selected = [pt(0, 20, 0), pt(10, 10, 1), pt(20, 20, 2)];
    const other = [pt(0, 15, 0), pt(10, 15, 1), pt(20, 15, 2)];
    const out = findCrossings(selected, other);
    expect(out.map((c) => c.dir)).toEqual(["up", "down"]);
  });

  it("returns nothing for empty or single-point series", () => {
    expect(findCrossings([], [])).toHaveLength(0);
    expect(findCrossings([pt(0, 10, 0)], [pt(0, 20, 0)])).toHaveLength(0);
  });
});

const line = (over: Partial<LineCache>): LineCache => ({
  paneId: "candle_pane",
  name: "EMA#a",
  figKey: "ma",
  indType: "EMA",
  extendData: undefined,
  color: "#fff",
  coords: [],
  ...over,
});

describe("crossingsForSelection", () => {
  const rising = [pt(0, 20, 0), pt(10, 10, 1)];
  const flat = [pt(0, 15, 0), pt(10, 15, 1)];

  it("marks crossings between the selected curve and other candle-pane curves", () => {
    const cache = [
      line({ name: "EMA#a", coords: rising }),
      line({ name: "EMA#b", coords: flat }),
    ];
    const out = crossingsForSelection(cache, { paneId: "candle_pane", name: "EMA#a" });
    expect(out).toHaveLength(1);
    expect(out[0].dir).toBe("up");
  });

  it("excludes sibling figures of the selected indicator itself", () => {
    // BOLL-style: selected instance plots two lines that cross each other
    const cache = [
      line({ name: "BOLL#a", figKey: "mid", coords: rising }),
      line({ name: "BOLL#a", figKey: "up", coords: flat }),
    ];
    expect(crossingsForSelection(cache, { paneId: "candle_pane", name: "BOLL#a" })).toHaveLength(0);
  });

  it("ignores curves on other panes and non-candle selections", () => {
    const cache = [
      line({ name: "EMA#a", coords: rising }),
      line({ paneId: "pane_rsi", name: "RSI", coords: flat }),
    ];
    expect(crossingsForSelection(cache, { paneId: "candle_pane", name: "EMA#a" })).toHaveLength(0);
    expect(crossingsForSelection(cache, { paneId: "pane_rsi", name: "RSI" })).toHaveLength(0);
  });

  it("checks every figure of the selected indicator against every other curve", () => {
    const falling = [pt(0, 10, 0), pt(10, 20, 1)];
    const cache = [
      line({ name: "PB#a", figKey: "htfHigh", coords: rising }),
      line({ name: "PB#a", figKey: "htfLow", coords: falling }),
      line({ name: "EMA#b", coords: flat }),
    ];
    const out = crossingsForSelection(cache, { paneId: "candle_pane", name: "PB#a" });
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.dir).sort()).toEqual(["down", "up"]);
  });
});
