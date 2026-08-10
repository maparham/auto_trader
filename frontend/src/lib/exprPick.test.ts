import { describe, it, expect, vi } from "vitest";
import type { Chart } from "klinecharts";

// customIndicators.ts (pulled in by indicators.ts) reads klinecharts' runtime
// surface at module load; stub it like indicators.test.ts does.
vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));

const { pickedIndicatorToken } = await import("./exprPick");

function fakeChart(
  inds: Array<{ name: string; paneId: string; calcParams?: unknown[]; extendData?: unknown }>,
) {
  return { getIndicators: () => inds } as unknown as Chart;
}

const SLOPE = {
  name: "SLOPE#a1b",
  paneId: "pane_1",
  calcParams: [9, 21],
  extendData: { indType: "SLOPE", units: "pctBar", showAccel: true },
};
// The companion is a SEPARATE instance whose config is COPIED from its parent.
const ACCEL = {
  name: "SLOPE#a1b__accel",
  paneId: "pane_2",
  calcParams: [9, 21],
  extendData: { indType: "SLOPE_ACCEL", units: "pctBar", showAccel: true },
};

describe("pickedIndicatorToken", () => {
  it("references the clicked slope line", () => {
    const chart = fakeChart([SLOPE, ACCEL]);
    expect(pickedIndicatorToken(chart, { paneId: "pane_1", name: "SLOPE#a1b", lineIndex: 1 }))
      .toBe("SLOPE#a1b.21");
  });

  it("defaults to the first line when the click carries no line", () => {
    const chart = fakeChart([SLOPE, ACCEL]);
    expect(pickedIndicatorToken(chart, { paneId: "pane_1", name: "SLOPE#a1b" }))
      .toBe("SLOPE#a1b.9");
  });

  it("maps an acceleration pane click onto its PARENT with an accel output", () => {
    const chart = fakeChart([SLOPE, ACCEL]);
    expect(
      pickedIndicatorToken(chart, { paneId: "pane_2", name: "SLOPE#a1b__accel", lineIndex: 1 }),
    ).toBe("SLOPE#a1b.accel21");
  });

  it("reads the PARENT's settings, not the companion's copy", () => {
    // Companion left stale with one line; the parent (two lines) is the source
    // of truth, so its second line is still referenceable.
    const chart = fakeChart([SLOPE, { ...ACCEL, calcParams: [9] }]);
    expect(
      pickedIndicatorToken(chart, { paneId: "pane_2", name: "SLOPE#a1b__accel", lineIndex: 1 }),
    ).toBe("SLOPE#a1b.accel21");
  });

  it("refuses an orphaned companion whose parent is gone", () => {
    const chart = fakeChart([ACCEL]);
    expect(pickedIndicatorToken(chart, { paneId: "pane_2", name: "SLOPE#a1b__accel" })).toBeNull();
  });

  it("refuses a line the pane does not draw", () => {
    const chart = fakeChart([SLOPE, ACCEL]);
    expect(pickedIndicatorToken(chart, { paneId: "pane_1", name: "SLOPE#a1b", lineIndex: 4 }))
      .toBeNull();
  });

  it("still emits a call token for a catalog indicator", () => {
    const chart = fakeChart([
      { name: "EMA#c3d", paneId: "candle_pane", calcParams: [9], extendData: { indType: "EMA" } },
    ]);
    expect(pickedIndicatorToken(chart, { paneId: "candle_pane", name: "EMA#c3d" })).toBe("EMA(9)");
  });

  it("returns null for an indicator that is no longer on the chart", () => {
    expect(pickedIndicatorToken(fakeChart([]), { paneId: "pane_1", name: "SLOPE" })).toBeNull();
  });

  it("passes the clicked figure through, so the ATR% figure picks the pct output", () => {
    const chart = fakeChart([
      { name: "ATR1", paneId: "pane_3", calcParams: [14], extendData: { indType: "ATR" } },
    ]);
    expect(pickedIndicatorToken(chart, { paneId: "pane_3", name: "ATR1", figureKey: "atrPct" }))
      .toBe("ATR1.14.to%");
    expect(pickedIndicatorToken(chart, { paneId: "pane_3", name: "ATR1" }))
      .toBe("ATR1.14");
  });
});
