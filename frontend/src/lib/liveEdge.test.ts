import { describe, expect, it, vi } from "vitest";
import type { Chart } from "klinecharts";
import {
  GOLIVE_PILL_H,
  LIVE_JUMP_MS,
  barsPastRightEdge,
  formatBehind,
  goLivePillStyle,
  jumpToLive,
  readLiveEdge,
} from "./liveEdge";

// klinecharts' VisibleRange.realTo is an EXCLUSIVE index that keeps counting past
// the last bar when the view sits in right-edge whitespace, so "how many bars are
// hidden to the right" is the one number the pill's visibility hangs off.
describe("barsPastRightEdge", () => {
  it("counts the bars hidden to the right of the view", () => {
    expect(barsPastRightEdge(300, 1000)).toBe(700);
  });

  it("is zero when the newest bar is the last one on screen", () => {
    expect(barsPastRightEdge(1000, 1000)).toBe(0);
  });

  it("stays zero when the view has scrolled into future whitespace", () => {
    expect(barsPastRightEdge(1040, 1000)).toBe(0);
  });

  it("is zero for an empty chart, so the pill never shows over no data", () => {
    expect(barsPastRightEdge(0, 0)).toBe(0);
  });
});

describe("formatBehind", () => {
  const latest = Date.UTC(2026, 7, 20, 12, 0, 0);
  const mins = (n: number) => latest - n * 60_000;

  it("reads in minutes inside the first hour", () => {
    expect(formatBehind(mins(20), latest)).toBe("20m back");
  });

  it("reads in hours below a day", () => {
    expect(formatBehind(mins(5 * 60 + 30), latest)).toBe("5h back");
  });

  it("reads in days below a year", () => {
    expect(formatBehind(mins(12 * 24 * 60), latest)).toBe("12d back");
  });

  it("reads in years beyond one", () => {
    expect(formatBehind(mins(800 * 24 * 60), latest)).toBe("2y back");
  });

  it("never rounds a real gap down to nothing", () => {
    expect(formatBehind(latest - 5_000, latest)).toBe("1m back");
  });

  it("gives no label when the right edge is at or past the newest bar", () => {
    expect(formatBehind(latest, latest)).toBe(null);
    expect(formatBehind(latest + 60_000, latest)).toBe(null);
  });
});

describe("readLiveEdge", () => {
  const HOUR = 3_600_000;
  const T0 = Date.UTC(2026, 7, 1);
  // Enough of klinecharts' Chart to answer "where is the right edge, and where
  // does the data end" — the only two things the pill reads.
  const fakeChart = (dataLen: number, realTo: number) =>
    ({
      getDataList: () => Array.from({ length: dataLen }, (_, i) => ({ timestamp: T0 + i * HOUR })),
      getVisibleRange: () => ({ from: 0, to: Math.min(realTo, dataLen), realFrom: 0, realTo }),
    }) as unknown as Parameters<typeof readLiveEdge>[0];

  it("labels the gap from the newest visible bar to the newest bar", () => {
    // 100 hourly bars, view ends 12 bars short of the last one.
    expect(readLiveEdge(fakeChart(100, 88))).toBe("12h back");
  });

  it("gives no label when the newest bar is on screen", () => {
    expect(readLiveEdge(fakeChart(100, 100))).toBe(null);
  });

  it("gives no label when the view sits in right-edge whitespace", () => {
    expect(readLiveEdge(fakeChart(100, 130))).toBe(null);
  });

  it("gives no label on an empty chart", () => {
    expect(readLiveEdge(fakeChart(0, 0))).toBe(null);
  });
});

describe("goLivePillStyle", () => {
  // right/bottom are the axis-clearing offsets ChartCore already computes
  // (y-axis width + 10, x-axis height + 10); height is the cell's full height.
  const m = { right: 70, bottom: 38, priceY: 200, height: 600 };

  it("parks above the time axis by default", () => {
    expect(goLivePillStyle("axis", m)).toEqual({ right: 70, bottom: 38 });
  });

  it("parks at the top right of the chart area", () => {
    expect(goLivePillStyle("topRight", m)).toEqual({ right: 70, top: 10 });
  });

  it("centers on the last-price line in priceLine mode", () => {
    expect(goLivePillStyle("priceLine", m)).toEqual({
      right: 70,
      top: 200 - GOLIVE_PILL_H / 2,
    });
  });

  it("clamps into the pane when the price line sits above the view", () => {
    expect(goLivePillStyle("priceLine", { ...m, priceY: -50 })).toEqual({ right: 70, top: 8 });
  });

  it("clamps above the time axis when the price line sits below the view", () => {
    // Pane bottom = height - x-axis height = 600 - 28; the pill stays 8px above it.
    expect(goLivePillStyle("priceLine", { ...m, priceY: 900 })).toEqual({
      right: 70,
      top: 600 - 28 - GOLIVE_PILL_H - 8,
    });
  });

  it("falls back to the axis park when there is no price line to follow", () => {
    expect(goLivePillStyle("priceLine", { ...m, priceY: null })).toEqual({
      right: 70,
      bottom: 38,
    });
  });
});

describe("jumpToLive", () => {
  it("glides to the newest bar rather than teleporting", () => {
    const calls: number[] = [];
    const chart = { scrollToRealTime: (ms?: number) => calls.push(ms ?? 0) };
    jumpToLive(chart as unknown as Chart, () => {}, () => false);
    expect(calls).toEqual([LIVE_JUMP_MS]);
  });

  it("settles only once the glide has finished", () => {
    vi.useFakeTimers();
    try {
      let settled = 0;
      const chart = { scrollToRealTime: () => {} };
      jumpToLive(chart as unknown as Chart, () => settled++, () => false);
      // Mid-glide the view is still moving: saving the position now would
      // persist a half-way scroll, not the live edge.
      vi.advanceTimersByTime(LIVE_JUMP_MS - 1);
      expect(settled).toBe(0);
      vi.advanceTimersByTime(500);
      expect(settled).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("jumpToLive in a hidden tab", () => {
  // The glide runs on requestAnimationFrame, which the browser pauses while the
  // tab is hidden — so a tab hidden mid-jump freezes the view part-way, and the
  // settle would persist that half-scrolled position as the restore point.
  it("snaps the rest of the way before settling when the tab went hidden", () => {
    vi.useFakeTimers();
    try {
      const durations: (number | undefined)[] = [];
      const chart = { scrollToRealTime: (ms?: number) => durations.push(ms) };
      let hidden = false;
      const order: string[] = [];
      jumpToLive(chart as unknown as Chart, () => order.push("settled"), () => hidden);
      hidden = true;
      vi.advanceTimersByTime(LIVE_JUMP_MS);
      // Second call carries no duration: an instant scroll lands the view where
      // the frozen glide was heading, so what gets saved is the live edge.
      expect(durations).toEqual([LIVE_JUMP_MS, undefined]);
      expect(order).toEqual(["settled"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves a finished glide alone when the tab stayed visible", () => {
    vi.useFakeTimers();
    try {
      const durations: (number | undefined)[] = [];
      const chart = { scrollToRealTime: (ms?: number) => durations.push(ms) };
      jumpToLive(chart as unknown as Chart, () => {}, () => false);
      vi.advanceTimersByTime(LIVE_JUMP_MS);
      expect(durations).toEqual([LIVE_JUMP_MS]);
    } finally {
      vi.useRealTimers();
    }
  });
});
