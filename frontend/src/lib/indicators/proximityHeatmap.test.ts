import { describe, expect, it, vi } from "vitest";

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

describe("drawHeatmap visible-range cull", () => {
  // One fillRect + two state changes per loaded bar per frame, visible or
  // not; the loop must walk only the visible range.
  it("fills only near-pane columns", async () => {
    const { PROXIMITY_HEATMAP_TEMPLATE } = await import("./proximityHeatmap");
    const rects: number[][] = [];
    const ctx = new Proxy(
      { fillRect: (...a: number[]) => rects.push(a) },
      { get: (t, p) => (p in t ? t[p as keyof typeof t] : () => {}), set: () => true },
    );
    const n = 8000;
    const points = Array.from({ length: n }, () => ({ v: 0.9 }));
    (PROXIMITY_HEATMAP_TEMPLATE as { draw: (p: unknown) => boolean }).draw({
      ctx,
      chart: {
        getBarSpace: () => ({ halfBar: 3 }),
        getVisibleRange: () => ({ from: 7800, to: 7950 }),
      },
      indicator: { result: points },
      xAxis: { convertToPixel: (i: number) => (i - 7875) * 6 + 450 },
      bounding: { width: 900, height: 200 },
    });
    expect(rects.length).toBeGreaterThan(100);
    expect(rects.length).toBeLessThan(300);
  });
});
