import { describe, it, expect, vi } from "vitest";

// curveLabels pulls in prevHl/vwap which read klinecharts enums at load; stub the
// runtime surface like the other indicator tests do.
vi.mock("klinecharts", () => ({
  LineType: { Solid: "solid", Dashed: "dashed", Dotted: "dotted" },
  IndicatorSeries: { Normal: "normal", Price: "price" },
  registerIndicator: () => {},
}));

const { curveLabel } = await import("./curveLabels");

describe("curveLabel — Pivots High/Low [LuxAlgo]", () => {
  it("labels the two forward-carried pivot curves", () => {
    expect(curveLabel("PIVOT_ANALYSIS", "pivotHigh", {}, [50])).toBe("Pivot High");
    expect(curveLabel("PIVOT_ANALYSIS", "pivotLow", {}, [50])).toBe("Pivot Low");
  });

  it("has no pill for the Δ%/Δt operand-only outputs", () => {
    expect(curveLabel("PIVOT_ANALYSIS", "deltaPct", {}, [50])).toBeNull();
    expect(curveLabel("PIVOT_ANALYSIS", "deltaT", {}, [50])).toBeNull();
  });
});
