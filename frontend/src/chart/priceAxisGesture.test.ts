import { describe, it, expect } from "vitest";
import { isOverPriceAxis, isPriceAxisScaleWheel } from "./priceAxisGesture";

// Candle pane main area is 800px wide starting at viewport x=100, so the price
// axis strip is everything right of x=900.
const geom = { left: 100, mainWidth: 800 };

describe("isOverPriceAxis", () => {
  it("is true right of the candle pane's main area", () => {
    expect(isOverPriceAxis(930, geom)).toBe(true);
  });

  it("is false over the candles", () => {
    expect(isOverPriceAxis(500, geom)).toBe(false);
  });

  it("is false before the chart has a measured main area", () => {
    // A pre-layout chart reports width 0; treating the whole cell as "axis"
    // there would flip auto-scale off on the first wheel anywhere.
    expect(isOverPriceAxis(930, { left: 100, mainWidth: 0 })).toBe(false);
  });
});

describe("isPriceAxisScaleWheel", () => {
  it("is true for a vertical wheel over the price axis", () => {
    expect(isPriceAxisScaleWheel({ clientX: 930, deltaX: 0, deltaY: -120 }, geom)).toBe(true);
  });

  it("is false for a vertical wheel over the candles (that zooms time, not price)", () => {
    expect(isPriceAxisScaleWheel({ clientX: 500, deltaX: 0, deltaY: -120 }, geom)).toBe(false);
  });

  it("is false for a horizontal-dominant wheel over the axis", () => {
    // klinecharts routes |deltaX| > |deltaY| to mouseWheelHortEvent, which
    // scrolls time and leaves the y-axis in auto mode.
    expect(isPriceAxisScaleWheel({ clientX: 930, deltaX: -200, deltaY: 30 }, geom)).toBe(false);
  });

  it("is false for a wheel with no vertical delta", () => {
    expect(isPriceAxisScaleWheel({ clientX: 930, deltaX: 0, deltaY: 0 }, geom)).toBe(false);
  });

  it("is true when the deltas tie with a non-zero deltaY", () => {
    // klinecharts' branch is `|deltaX| > |deltaY|` for horizontal, so an exact
    // tie falls through to the vertical (scaling) path.
    expect(isPriceAxisScaleWheel({ clientX: 930, deltaX: 40, deltaY: -40 }, geom)).toBe(true);
  });
});
