import { describe, it, expect, vi } from "vitest";

// curveLabels pulls in prevHl/vwap which read klinecharts enums at load; stub the
// runtime surface like the other indicator tests do.
vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
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

// The PREV_HL anchor pill is painted ON the chart (chart/chartPainters.ts:139),
// and anchorTs comes from persisted extendData — so a masked replay session leaks
// its own period through a chart that merely HAS this indicator, with no
// in-session editing at all. The anchor curve also only draws from that instant
// forward, so the label bounds the hidden window visually.
describe("curveLabel — PREV_HL anchor pill and blind replay", () => {
  const ANCHOR = Date.UTC(2026, 2, 2, 9, 30); // 2026-03-02 09:30 UTC
  const ext = { anchorTs: ANCHOR, tz: "UTC" };

  it("shows the real month-day when no session is masked", () => {
    expect(curveLabel("PREV_HL", "anchorHigh", ext, [])).toBe("since 03-02 high");
  });

  it("shows Day N instead while a masked session is armed", async () => {
    const { maskedReplaySignal, armMaskedReplay } = await import("../maskedReplay");
    maskedReplaySignal.set(
      armMaskedReplay(maskedReplaySignal.value, {
        cellId: "cell-a",
        startMs: ANCHOR - 2 * 86_400_000, // the session began 2 days before the anchor
        clock: "24h",
        timezone: "UTC",
      }),
    );
    try {
      const label = curveLabel("PREV_HL", "anchorHigh", ext, []);
      expect(label).toBe("since Day 3 high");
      expect(label).not.toMatch(/2026|03-02|Mar/);
    } finally {
      maskedReplaySignal.set({});
    }
  });
});
