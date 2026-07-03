import { describe, expect, it, vi } from "vitest";
import type { Chart } from "klinecharts";

// klinecharts ships a browser-only UMD bundle whose runtime exports are empty under
// node, so dereferencing the DomPosition enum (chartSync's mainWidth) would blow up.
// Type-only imports still come from the real package.
vi.mock("klinecharts", () => ({ DomPosition: { Root: "root", Main: "main", YAxis: "yAxis" } }));

const { applyVisibleRange, readVisibleRange } = await import("./chartSync");

// Minimal stand-in for klinecharts' TimeScaleStore geometry (v9 dist), enough to
// exercise the date-range math against the library's real coordinate semantics:
//  - pixel → index is pure linear extrapolation (whitespace maps to virtual indices),
//    but index → timestamp is a data lookup, so convertFromPixel returns NO timestamp
//    for a pixel past the last bar (the whitespace-null that broke the plain link);
//  - timestamp → index is binary-search NEAREST, CLAMPED to the data extent, so
//    convertToPixel/scrollToTimestamp cannot express a future (whitespace) time;
//  - setBarSpace silently ignores values outside [1, 50] px/bar;
//  - scrollByDistance shifts the right-edge whitespace by distance/barSpace bars,
//    clamped so at least 2 bars stay visible at either edge (adjustVisibleRange's
//    default minVisibleBarCount) — the cap the degradation tests lean on.
class FakeChart {
  data: { timestamp: number }[];
  barSpace: number;
  rightDiff: number; // bars of whitespace right of the last bar (klinecharts' _lastBarRightSideDiffBarCount)
  w: number;

  constructor(opts: { data: { timestamp: number }[]; barSpace: number; rightDiff?: number; width?: number }) {
    this.data = opts.data;
    this.barSpace = opts.barSpace;
    this.rightDiff = opts.rightDiff ?? 0;
    this.w = opts.width ?? 800;
    this.clampScroll();
  }

  private clampScroll() {
    const visible = this.w / this.barSpace;
    const n = this.data.length;
    this.rightDiff = Math.min(visible - Math.min(2, n), Math.max(-n + Math.min(2, n), this.rightDiff));
  }
  maxRightDiff(): number {
    return this.w / this.barSpace - Math.min(2, this.data.length);
  }

  getDataList() {
    return this.data;
  }
  getSize() {
    return { width: this.w };
  }
  getBarSpace() {
    return this.barSpace;
  }
  setBarSpace(s: number) {
    if (s >= 1 && s <= 50) this.barSpace = s;
  }
  private nearestClamped(ts: number): number {
    const d = this.data;
    let best = 0;
    for (let i = 1; i < d.length; i++) {
      if (Math.abs(d[i].timestamp - ts) < Math.abs(d[best].timestamp - ts)) best = i;
    }
    return best;
  }
  private indexToX(idx: number): number {
    const deltaFromRight = this.data.length + this.rightDiff - idx;
    return Math.floor(this.w - (deltaFromRight - 0.5) * this.barSpace);
  }
  convertFromPixel(points: { x: number }[]) {
    const x = points[0].x;
    const floatIdx = this.data.length + this.rightDiff - (this.w - x) / this.barSpace;
    const idx = Math.ceil(floatIdx) - 1;
    const bar = this.data[idx];
    return [{ timestamp: bar ? bar.timestamp : undefined }];
  }
  convertToPixel(points: { timestamp: number }[]) {
    return [{ x: this.indexToX(this.nearestClamped(points[0].timestamp)) }];
  }
  scrollByDistance(distance: number) {
    this.rightDiff -= distance / this.barSpace;
    this.clampScroll();
  }
  scrollToTimestamp(ts: number) {
    const idx = this.nearestClamped(ts);
    this.scrollByDistance((this.rightDiff + (this.data.length - 1 - idx)) * this.barSpace);
  }

  asChart(): Chart {
    return this as unknown as Chart;
  }
  xOf(ts: number): number {
    return this.indexToX(this.nearestClamped(ts));
  }
}

const HOUR = 3_600_000;
const T0 = 1_700_000_000_000;
const bars = (n: number, stepMs: number, start = T0) =>
  Array.from({ length: n }, (_, i) => ({ timestamp: start + i * stepMs }));

describe("readVisibleRange", () => {
  it("reads the two edge timestamps of an in-data window", () => {
    // 100 hourly bars, 10px each, right edge exactly on the last bar.
    const c = new FakeChart({ data: bars(100, HOUR), barSpace: 10 });
    const r = readVisibleRange(c.asChart());
    expect(r).not.toBeNull();
    const last = T0 + 99 * HOUR;
    expect(Math.abs(r!.toTs - last)).toBeLessThanOrEqual(HOUR);
    // 800px / 10px = 80 bars visible.
    expect(Math.abs(r!.fromTs - (last - 79 * HOUR))).toBeLessThanOrEqual(HOUR);
  });

  it("extrapolates the right edge into whitespace instead of bailing", () => {
    // Panned left: 20 bars (200px) of whitespace after the last candle.
    const c = new FakeChart({ data: bars(100, HOUR), barSpace: 10, rightDiff: 20 });
    const last = T0 + 99 * HOUR;
    const r = readVisibleRange(c.asChart());
    expect(r).not.toBeNull();
    // Right pixel edge sits ~20.4 virtual bars past the last bar's centre.
    expect(r!.toTs).toBeGreaterThan(last);
    expect(Math.abs(r!.toTs - (last + 20.4 * HOUR))).toBeLessThanOrEqual(HOUR);
  });

  it("keeps reporting at klinecharts' max right-whitespace (2 bars left visible)", () => {
    // The real chart clamps scrolling so ≥2 bars stay visible; at that extreme the
    // right edge is ~78 virtual bars out and must still be reported.
    const c = new FakeChart({ data: bars(100, HOUR), barSpace: 10, rightDiff: 1000 });
    expect(c.rightDiff).toBe(c.maxRightDiff()); // 78
    const last = T0 + 99 * HOUR;
    const r = readVisibleRange(c.asChart());
    expect(r).not.toBeNull();
    expect(Math.abs(r!.toTs - (last + 77.9 * HOUR))).toBeLessThanOrEqual(HOUR);
  });

  it("extrapolates the left edge when scrolled back past the first bar", () => {
    // History exhausted and scrolled back beyond it: the left pixel edge sits in
    // whitespace before the first bar.
    const c = new FakeChart({ data: bars(100, HOUR), barSpace: 10, rightDiff: -1000 });
    const r = readVisibleRange(c.asChart());
    expect(r).not.toBeNull();
    expect(r!.fromTs).toBeLessThan(T0);
    expect(r!.toTs).toBeGreaterThan(r!.fromTs);
  });
});

describe("applyVisibleRange", () => {
  it("fits an in-data window: right edge exact, left edge within a bar", () => {
    const c = new FakeChart({ data: bars(200, HOUR), barSpace: 25 });
    const from = T0 + 100 * HOUR;
    const to = T0 + 180 * HOUR;
    applyVisibleRange(c.asChart(), from, to);
    // 80 bars over 800px → 10px/bar; the `to` bar at the right edge.
    expect(c.xOf(to)).toBeGreaterThan(c.w - 1.5 * c.barSpace);
    expect(c.xOf(to)).toBeLessThanOrEqual(c.w);
    expect(Math.abs(c.xOf(from))).toBeLessThanOrEqual(1.5 * c.barSpace);
  });

  it("reproduces a whitespace window: latest candle revealed, whitespace mirrored", () => {
    // Follower on 30m bars gets a master window that ends 20h past the last bar.
    const HALF = HOUR / 2;
    const data = bars(200, HALF);
    const lastTs = data[data.length - 1].timestamp;
    const c = new FakeChart({ data, barSpace: 25 });
    const from = lastTs - 60 * HOUR;
    const to = lastTs + 20 * HOUR;
    applyVisibleRange(c.asChart(), from, to);
    // 80h window on 30m bars = 160 bars → 5px/bar; 20h whitespace = 40 bars = 200px,
    // so the follower's latest candle must sit ~200px left of the right edge —
    // revealed, with the master's whitespace mirrored (the bug froze it off-screen).
    expect(c.barSpace).toBeCloseTo(5, 0);
    const xLast = c.xOf(lastTs);
    expect(Math.abs(xLast - (c.w - 40 * c.barSpace))).toBeLessThanOrEqual(2 * c.barSpace);
    // Round-trip: reading the window back reproduces what was asked for (the
    // invariant the whole master/follower loop rests on), whitespace included.
    const r = readVisibleRange(c.asChart());
    expect(r).not.toBeNull();
    expect(Math.abs(r!.toTs - to)).toBeLessThanOrEqual(2 * HALF);
    expect(Math.abs(r!.fromTs - from)).toBeLessThanOrEqual(2 * HALF);
  });

  it("scrolls newer follower bars out of view when the window ends in its past", () => {
    // Mirror image of the whitespace case: the master is STALER than the follower
    // (window's toTs sits inside the follower's data), so the follower's newer bars
    // belong right of the visible window.
    const data = bars(200, HOUR);
    const to = T0 + 150 * HOUR;
    const c = new FakeChart({ data, barSpace: 25 });
    applyVisibleRange(c.asChart(), T0 + 70 * HOUR, to);
    expect(c.xOf(to)).toBeGreaterThan(c.w - 1.5 * c.barSpace);
    expect(c.xOf(to)).toBeLessThanOrEqual(c.w);
    expect(c.xOf(data[data.length - 1].timestamp)).toBeGreaterThan(c.w);
  });

  it("degrades to max whitespace, without hanging, on a window entirely past the data", () => {
    // A quick-range window on a closed market can sit wholly past the last bar
    // (e.g. "1D" on a Sunday). The pin target is unreachable — klinecharts' scroll
    // clamp (≥2 bars visible) must win, leaving max whitespace, not a loop. The
    // quick-range caller clamps such windows to end at the last bar precisely
    // because this is all a chart can show for one.
    const data = bars(200, HOUR);
    const lastTs = data[data.length - 1].timestamp;
    const c = new FakeChart({ data, barSpace: 25 });
    applyVisibleRange(c.asChart(), lastTs + 24 * HOUR, lastTs + 48 * HOUR);
    expect(c.rightDiff).toBe(c.maxRightDiff());
  });
});
