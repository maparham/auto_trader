// The legend rebuild calls prevHlDegenerateInfo on EVERY pan frame; its bar-
// spacing estimate must not re-walk (and re-sort) the whole history each time.
// Cache key is (array identity, length): klinecharts mutates the forming bar in
// place (timestamps unchanged), appends grow the length, and a prepend mints a
// new array — so the pair pins the exact timestamp sequence the estimate saw.
import { describe, it, expect, vi } from "vitest";
import type { KLineData } from "klinecharts";

// prevHl.ts touches klinecharts' runtime surface at module load; stub it like
// sessions.test.ts / overlays.test.ts do.
vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));

const { prevHlDegenerateInfo } = await import("./prevHl");

const MIN = 60_000;
const bars = (n: number, stepMs: number): KLineData[] =>
  Array.from({ length: n }, (_, i) => ({
    timestamp: i * stepMs,
    open: 1,
    high: 1,
    low: 1,
    close: 1,
  }));

const ext = { lengths: { day: 1 } };

describe("prevHlDegenerateInfo bar-spacing memo", () => {
  it("reuses the estimate for the same array at the same length", () => {
    const dl = bars(50, MIN);
    expect(prevHlDegenerateInfo(dl, ext).minDuration).toBe("1 minute");
    // In-place timestamp rewrite without a length/identity change: a cached
    // estimate ignores it (this never happens on a real chart — klinecharts
    // only mutates the forming bar's prices in place).
    for (let i = 0; i < dl.length; i++) dl[i].timestamp = i * 60 * MIN;
    expect(prevHlDegenerateInfo(dl, ext).minDuration).toBe("1 minute");
  });

  it("recomputes when the same array grows (a closed bar appended)", () => {
    const dl = bars(50, MIN);
    expect(prevHlDegenerateInfo(dl, ext).minDuration).toBe("1 minute");
    for (let i = 0; i < dl.length; i++) dl[i].timestamp = i * 60 * MIN;
    dl.push({ timestamp: 50 * 60 * MIN, open: 1, high: 1, low: 1, close: 1 });
    expect(prevHlDegenerateInfo(dl, ext).minDuration).toBe("1 hour");
  });

  it("recomputes for a new array identity (a prepend)", () => {
    const dl = bars(50, MIN);
    expect(prevHlDegenerateInfo(dl, ext).minDuration).toBe("1 minute");
    const wider = bars(50, 60 * MIN);
    expect(prevHlDegenerateInfo(wider, ext).minDuration).toBe("1 hour");
  });
});
