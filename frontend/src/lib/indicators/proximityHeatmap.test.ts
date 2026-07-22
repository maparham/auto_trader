import { expect, it, vi } from "vitest";

// proximityHeatmap.ts imports klinecharts, which touches `window` at module
// load; stub its runtime surface in node like timeHighlight.test.ts does.
vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));

import { computeHeatmapPoints } from "./proximityHeatmap";

it("maps extendData.values onto per-bar points by index", () => {
  const dataList = [{ timestamp: 0 }, { timestamp: 60 }, { timestamp: 120 }] as never[];
  const pts = computeHeatmapPoints(dataList, { values: [0.2, null, 0.9] });
  expect(pts).toEqual([{ v: 0.2 }, { v: null }, { v: 0.9 }]);
});

it("yields null points when no values are present", () => {
  const dataList = [{ timestamp: 0 }, { timestamp: 60 }] as never[];
  const pts = computeHeatmapPoints(dataList, {});
  expect(pts).toEqual([{ v: null }, { v: null }]);
});
