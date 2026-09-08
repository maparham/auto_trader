import { describe, it, expect, beforeEach } from "vitest";
import type { KLineData } from "klinecharts";
import {
  BAR_CACHE_MAX_BARS,
  BAR_CACHE_MAX_SERIES,
  clearBarCache,
  getCachedBars,
  mergeBars,
  mergeFreshWindow,
  putCachedBars,
} from "./barCache";

const bar = (ts: number, close = 1): KLineData => ({
  timestamp: ts,
  open: 1,
  high: 2,
  low: 0.5,
  close,
  volume: 10,
});

beforeEach(() => {
  clearBarCache();
});

describe("putCachedBars / getCachedBars", () => {
  it("misses on an unknown key", () => {
    expect(getCachedBars("b|EPIC|HOUR|mid")).toBeNull();
  });

  it("round-trips bars under a key", () => {
    const bars = [bar(1000), bar(2000)];
    putCachedBars("b|EPIC|HOUR|mid", bars);
    expect(getCachedBars("b|EPIC|HOUR|mid")).toEqual(bars);
  });

  it("ignores an empty put (nothing to serve later)", () => {
    putCachedBars("b|EPIC|HOUR|mid", []);
    expect(getCachedBars("b|EPIC|HOUR|mid")).toBeNull();
  });

  it("isolates distinct keys", () => {
    putCachedBars("b|A|HOUR|mid", [bar(1000, 5)]);
    putCachedBars("b|B|HOUR|mid", [bar(1000, 9)]);
    expect(getCachedBars("b|A|HOUR|mid")![0].close).toBe(5);
    expect(getCachedBars("b|B|HOUR|mid")![0].close).toBe(9);
  });

  it("returns copies: mutating a served bar cannot corrupt the cache", () => {
    putCachedBars("k", [bar(1000, 5)]);
    const served = getCachedBars("k")!;
    served[0].close = 999;
    served.pop();
    expect(getCachedBars("k")).toEqual([bar(1000, 5)]);
  });

  it("copies on put: later mutation of the caller's array cannot corrupt the cache", () => {
    const bars = [bar(1000, 5)];
    putCachedBars("k", bars);
    bars[0].close = 999;
    bars.push(bar(2000));
    expect(getCachedBars("k")).toEqual([bar(1000, 5)]);
  });

  it("keeps only the newest tail past the per-series bar cap", () => {
    const bars = Array.from({ length: BAR_CACHE_MAX_BARS + 100 }, (_, i) => bar((i + 1) * 1000));
    putCachedBars("k", bars);
    const cached = getCachedBars("k")!;
    expect(cached.length).toBe(BAR_CACHE_MAX_BARS);
    expect(cached[cached.length - 1].timestamp).toBe(bars[bars.length - 1].timestamp);
    expect(cached[0].timestamp).toBe(bars[bars.length - BAR_CACHE_MAX_BARS].timestamp);
  });

  it("evicts the least-recently-used series past the series cap", () => {
    for (let i = 0; i < BAR_CACHE_MAX_SERIES; i++) putCachedBars(`k${i}`, [bar(1000)]);
    // Touch k0 so k1 becomes the oldest.
    getCachedBars("k0");
    putCachedBars("overflow", [bar(1000)]);
    expect(getCachedBars("k0")).not.toBeNull();
    expect(getCachedBars("k1")).toBeNull();
    expect(getCachedBars("overflow")).not.toBeNull();
  });
});

describe("mergeBars", () => {
  it("unions by timestamp, sorted ascending", () => {
    const merged = mergeBars([bar(1000), bar(3000)], [bar(2000), bar(4000)]);
    expect(merged.map((b) => b.timestamp)).toEqual([1000, 2000, 3000, 4000]);
  });

  it("fresh bars win on a shared timestamp", () => {
    const merged = mergeBars([bar(1000, 5)], [bar(1000, 7)]);
    expect(merged).toEqual([bar(1000, 7)]);
  });

  it("tolerates empty sides", () => {
    expect(mergeBars([], [bar(1000)])).toEqual([bar(1000)]);
    expect(mergeBars([bar(1000)], [])).toEqual([bar(1000)]);
    expect(mergeBars([], [])).toEqual([]);
  });
});

describe("mergeFreshWindow", () => {
  it("merges when the fresh window overlaps the painted bars", () => {
    const merged = mergeFreshWindow([bar(1000), bar(2000, 5)], [bar(2000, 7), bar(3000)]);
    expect(merged.map((b) => b.timestamp)).toEqual([1000, 2000, 3000]);
    expect(merged[1].close).toBe(7); // fresh wins
  });

  it("drops stale painted bars when the fresh window starts after them (unprovable gap)", () => {
    expect(mergeFreshWindow([bar(1000), bar(2000)], [bar(5000), bar(6000)])).toEqual([
      bar(5000),
      bar(6000),
    ]);
  });

  it("an empty fresh window yields fresh (the caller's keep-painted policy owns that case)", () => {
    expect(mergeFreshWindow([bar(1000)], [])).toEqual([]);
    expect(mergeFreshWindow([], [bar(1000)])).toEqual([bar(1000)]);
  });
});
