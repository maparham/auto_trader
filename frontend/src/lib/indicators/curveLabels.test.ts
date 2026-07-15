import { describe, it, expect, vi } from "vitest";

// curveLabels pulls in prevHl/vwap which read klinecharts enums at load; stub the
// runtime surface like the other indicator tests do.
vi.mock("klinecharts", () => ({
  LineType: { Solid: "solid", Dashed: "dashed", Dotted: "dotted" },
  IndicatorSeries: { Normal: "normal", Price: "price" },
  registerIndicator: () => {},
}));

const { curveLabel } = await import("./curveLabels");

describe("curveLabel: EMA/MA pill follows the type", () => {
  it("labels an untouched instance by its template kind", () => {
    expect(curveLabel("EMA", "ma", {}, [20])).toBe("EMA 20");
    expect(curveLabel("MA", "ma", {}, [50])).toBe("MA 50");
    expect(curveLabel("EMA", "smoothingMa", {}, [20])).toBe("EMA 20 MA");
  });
  it("labels a flipped instance by its chosen kind", () => {
    expect(curveLabel("EMA", "ma", { maType: "vwma" }, [20])).toBe("VWMA 20");
    expect(curveLabel("MA", "ma", { maType: "evwma" }, [50])).toBe("EVWMA 50");
    expect(curveLabel("MA", "smoothingMa", { maType: "vwma" }, [50])).toBe("VWMA 50 MA");
  });
});

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
