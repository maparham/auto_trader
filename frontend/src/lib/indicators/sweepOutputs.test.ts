import { describe, it, expect, vi } from "vitest";
import type { SweepPoint } from "./sweepCompute";

vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));

const { SWEEP_OUTPUTS, SWEEP_DEFAULTS, parseSweepConfig, sweepWarmup } = await import("./sweepOutputs");
const { SWEEP_TEMPLATE, sweepConfirmedAt } = await import("./sweep");
const { BASE_TEMPLATES, OVERLAY_INDICATORS } = await import("../customIndicators");

// Minimal SweepPoint[] builder for sweepConfirmedAt tests: zeroed flags at
// every index except the ones a case overrides.
function points(len: number, overrides: Record<number, Partial<SweepPoint>>): SweepPoint[] {
  return Array.from({ length: len }, (_, i) => ({
    bearSweep: 0,
    bullSweep: 0,
    bearConfirmed: 0,
    bullConfirmed: 0,
    ...overrides[i],
  }));
}

describe("SWEEP config", () => {
  it("defaults and falls back like the backend parser", () => {
    expect(parseSweepConfig([], {})).toEqual({ ...SWEEP_DEFAULTS, tz: undefined });
    expect(parseSweepConfig(["x", 0, "y", 0, null, -2, 0, 0, -5, 0], {})).toEqual({ ...SWEEP_DEFAULTS, tz: undefined });
    expect(parseSweepConfig([2, 3, 50, 40, 10, 1.2, 30, 1.5, 60, 4], { usePrevDay: false, useVolume: true, tz: "Europe/London" }))
      .toEqual({
        pivotLeft: 2, pivotRight: 3, levelMaxAge: 50, minWickPct: 40, atrLen: 10, minRangeAtr: 1.2,
        volLen: 30, volZ: 1.5, minScore: 60, confirmBars: 4, usePrevDay: false, useVolume: true, tz: "Europe/London",
      });
  });
  it("warms up over a level's whole life", () => {
    expect(sweepWarmup(SWEEP_DEFAULTS)).toBe(160);
    expect(sweepWarmup({ ...SWEEP_DEFAULTS, useVolume: true, volLen: 200 })).toBe(201);
  });
});

describe("SWEEP template", () => {
  it("is a registered price overlay with the default params", () => {
    expect(BASE_TEMPLATES.SWEEP).toBe(SWEEP_TEMPLATE);
    expect(OVERLAY_INDICATORS.has("SWEEP")).toBe(true);
    expect(SWEEP_TEMPLATE.calcParams).toEqual([5, 5, 150, 50, 14, 1.5, 20, 2, 70, 3]);
    expect(SWEEP_TEMPLATE.figures?.map((f) => f.key)).toEqual(["sweptLevel"]);
  });
});

describe("sweepConfirmedAt", () => {
  it("still confirms the first sweep when a same-side flag coincides with its confirm bar", () => {
    // Bar 0 flags a bear sweep. Bar 3 (0 + confirmBars) is ALSO a fresh bear
    // flag, so barsSince resets to 0 there even though bearConfirmed is
    // correctly 1 for the original sweep's confirmation.
    const result = points(5, {
      0: { bearSweep: 1 },
      3: { bearSweep: 1, bearConfirmed: 1, barsSince: 0 },
    });
    expect(sweepConfirmedAt(result, 0, 3)).toBe(true);
  });

  it("does not confirm when the confirm bar belongs to the opposite side", () => {
    const result = points(5, {
      0: { bearSweep: 1 },
      3: { bullConfirmed: 1 },
    });
    expect(sweepConfirmedAt(result, 0, 3)).toBe(false);
  });
});
