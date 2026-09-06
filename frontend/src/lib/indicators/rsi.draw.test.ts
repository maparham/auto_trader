// The RSI pane's custom draws (smoothing MA, Bollinger echoes, zone fills)
// must walk only the VISIBLE bars, not the whole loaded series: the polylines
// are dashed, and a dashed path over ~18k off-pane points regenerates dash
// segments for its full geometric length on every frame — the same class of
// bug as trendlines' unclipped MTF rays.
import { expect, it, vi } from "vitest";

vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));

import { RSI_TEMPLATE } from "./rsi";

function fakeCtx() {
  let moves = 0;
  let lines = 0;
  const ctx = new Proxy(
    {
      moveTo: () => { moves++; },
      lineTo: () => { lines++; },
      measureText: () => ({ width: 10 }),
      createLinearGradient: () => ({ addColorStop: () => {} }),
    },
    {
      get: (t, p) => (p in t ? t[p as keyof typeof t] : () => {}),
      set: () => true,
    },
  );
  return { ctx, count: () => moves + lines };
}

it("walks only the visible range when painting smoothing lines and zone fills", () => {
  const n = 5000;
  const result = Array.from({ length: n }, (_, i) => ({
    val: 50 + 30 * Math.sin(i / 7), // crosses both thresholds so fills paint
    ma: 50,
    bbUp: 60,
    bbDn: 40,
  }));
  const { ctx, count } = fakeCtx();
  const draw = RSI_TEMPLATE.draw as (p: unknown) => boolean;
  draw({
    ctx,
    chart: { getVisibleRange: () => ({ from: 4000, to: 4120 }) },
    indicator: { result, extendData: {} },
    xAxis: { convertToPixel: (i: number) => (i - 4060) * 6 + 450 },
    yAxis: { convertToPixel: (v: number) => 200 - v * 2 },
    bounding: { left: 0, width: 900, height: 200 },
  });
  // 3 polylines (ma, bbUp, bbDn) + 2 zone-fill outlines over ~122 visible
  // bars (+ margin) is well under 1000 vertices; the unbounded version walks
  // 5 series x 5000 points = 25k.
  expect(count()).toBeLessThan(1500);
  expect(count()).toBeGreaterThan(300); // and it did actually paint
});
