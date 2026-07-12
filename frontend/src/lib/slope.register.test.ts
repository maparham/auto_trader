import { describe, it, expect, vi } from "vitest";

// customIndicators reads LineType/IndicatorSeries at module load; stub klinecharts'
// runtime surface like the other indicator tests do.
vi.mock("klinecharts", () => ({
  LineType: { Solid: "solid", Dashed: "dashed" },
  IndicatorSeries: { Normal: "normal", Price: "price" },
  registerIndicator: () => {},
}));

const { BASE_TEMPLATES } = await import("./customIndicators");

describe("SLOPE registration", () => {
  it("SLOPE is a known base template", () => {
    expect(BASE_TEMPLATES.SLOPE).toBeDefined();
    // Multi-line slope: one figure per MA length, keyed slope0..slopeN.
    expect(BASE_TEMPLATES.SLOPE.figures?.[0]?.key).toBe("slope0");
  });
});
