import { describe, expect, it, vi } from "vitest";
vi.mock("klinecharts", () => ({ registerOverlay: () => {} }));
import { alertStepsTemplate } from "./alertSteps";

describe("alertStepsTemplate", () => {
  it("draws horizontals with risers at candle edges", () => {
    const figs = alertStepsTemplate.createPointFigures!({
      chart: { getBarSpace: () => ({ bar: 10, halfBar: 5, gapBar: 8, halfGapBar: 4 }) },
      overlay: {},
      coordinates: [{ x: 10, y: 50 }, { x: 30, y: 40 }, { x: 50, y: 30 }],
      bounding: { width: 400, height: 400 },
      xAxis: null,
      yAxis: null,
    } as never);
    const line = (Array.isArray(figs) ? figs : [figs])[0] as { attrs: { coordinates: Array<{ x: number; y: number }> } };
    expect(line.attrs.coordinates).toEqual([
      { x: 5, y: 50 }, { x: 25, y: 50 },
      { x: 25, y: 40 }, { x: 45, y: 40 },
      { x: 45, y: 30 }, { x: 55, y: 30 },
    ]);
  });

  it("draws nothing from fewer than one point and never throws", () => {
    const p = { chart: {}, overlay: {}, coordinates: [], bounding: { width: 1, height: 1 }, xAxis: null, yAxis: null };
    expect(alertStepsTemplate.createPointFigures!(p as never)).toEqual([]);
  });
});
