// The store's whole job is "fetch these bars once, and only the missing part".
// These tests pin the interval rules: when a caller is served without a fetch,
// when only a gap is fetched, when a disjoint ask replaces the entry, and that
// a failed span never poisons the stored ask (retries must stay possible).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { KLineData } from "klinecharts";

import {
  fetchHtfInterval,
  htfIntervalKey,
  clearHtfCache,
  htfCacheStats,
  HTF_CACHE_TTL_MS,
} from "./htfBarCache";

const H = 3_600_000;
const mk = (t: number): KLineData =>
  ({ timestamp: t, open: 1, high: 1, low: 1, close: 1, volume: 1 }) as KLineData;

/** Serves one bar per hour bucket over the asked span; logs every span asked. */
const spanLoader = (log: Array<[number, number]>, failBelow = -Infinity) =>
  async (fromMs: number, toMs: number) => {
    log.push([fromMs, toMs]);
    if (fromMs < failBelow)
      return {
        // A failed walk still returns its contiguous newest-side prefix.
        bars: [] as KLineData[],
        failed: true,
      };
    const bars: KLineData[] = [];
    for (let t = Math.ceil(fromMs / H) * H; t <= toMs; t += H) bars.push(mk(t));
    return { bars, failed: false };
  };

const KEY = htfIntervalKey({
  brokerId: "b",
  epic: "E",
  timeframe: "HOUR",
  priceSide: "mid",
});

let clock = 1_000_000_000;
let nowSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  clock = 1_000_000_000;
  nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);
  clearHtfCache();
});
afterEach(() => nowSpy.mockRestore());

describe("fetchHtfInterval", () => {
  it("first ask loads the interval; a strictly-historical sub-interval is served with no fetch", async () => {
    const log: Array<[number, number]> = [];
    const r1 = await fetchHtfInterval(KEY, 0, 100 * H, H, spanLoader(log));
    expect(r1.failed).toBe(false);
    expect(r1.askFromMs).toBe(0);
    expect(r1.askToMs).toBe(100 * H);
    expect(r1.bars.length).toBeGreaterThan(0);
    const calls = log.length;
    clock += HTF_CACHE_TTL_MS * 10; // stale by TTL, but strictly historical
    const r2 = await fetchHtfInterval(KEY, 10 * H, 90 * H, H, spanLoader(log));
    expect(log.length).toBe(calls);
    expect(r2.bars[0].timestamp).toBeGreaterThanOrEqual(10 * H);
    expect(r2.bars[r2.bars.length - 1].timestamp).toBeLessThanOrEqual(90 * H);
  });

  it("a left extension fetches only the missing span and merges", async () => {
    const log: Array<[number, number]> = [];
    await fetchHtfInterval(KEY, 50 * H, 100 * H, H, spanLoader(log));
    log.length = 0;
    const r = await fetchHtfInterval(KEY, 20 * H, 90 * H, H, spanLoader(log));
    expect(log.length).toBe(1);
    expect(log[0][0]).toBe(20 * H);
    expect(log[0][1]).toBeLessThanOrEqual(50 * H);
    expect(r.bars[0].timestamp).toBe(20 * H);
  });

  it("a right extension refetches from the last stored bar (it may have been forming)", async () => {
    const log: Array<[number, number]> = [];
    await fetchHtfInterval(KEY, 0, 50 * H, H, spanLoader(log));
    log.length = 0;
    const r = await fetchHtfInterval(KEY, 10 * H, 80 * H, H, spanLoader(log));
    expect(log.length).toBe(1);
    expect(log[0][0]).toBe(50 * H); // last stored bar's open, not 50H+1
    expect(log[0][1]).toBe(80 * H);
    expect(r.bars[r.bars.length - 1].timestamp).toBe(80 * H);
  });

  it("a disjoint ask replaces the entry (rebase)", async () => {
    const log: Array<[number, number]> = [];
    await fetchHtfInterval(KEY, 90 * H, 100 * H, H, spanLoader(log));
    log.length = 0;
    const r = await fetchHtfInterval(KEY, 0, 10 * H, H, spanLoader(log));
    expect(log).toEqual([[0, 10 * H]]);
    expect(r.bars.every((b) => b.timestamp <= 10 * H)).toBe(true);
    // The old interval is gone: asking for it again refetches.
    log.length = 0;
    await fetchHtfInterval(KEY, 90 * H, 100 * H, H, spanLoader(log));
    expect(log.length).toBe(1);
  });

  it("a failed span returns partial with failed=true and stays retryable", async () => {
    const log: Array<[number, number]> = [];
    const r1 = await fetchHtfInterval(KEY, 0, 100 * H, H, spanLoader(log, 1));
    expect(r1.failed).toBe(true);
    const r2 = await fetchHtfInterval(KEY, 0, 100 * H, H, spanLoader(log));
    expect(r2.failed).toBe(false);
    expect(r2.bars[0].timestamp).toBe(0);
  });

  it("an ask at the live edge is served within the TTL and refetched past it", async () => {
    const log: Array<[number, number]> = [];
    await fetchHtfInterval(KEY, 0, 100 * H, H, spanLoader(log));
    const calls = log.length;
    await fetchHtfInterval(KEY, 0, 100 * H, H, spanLoader(log));
    expect(log.length).toBe(calls); // within TTL: served
    clock += HTF_CACHE_TTL_MS + 1;
    await fetchHtfInterval(KEY, 0, 100 * H, H, spanLoader(log));
    expect(log.length).toBe(calls + 1); // right-edge revalidation only
    expect(log[log.length - 1][0]).toBe(100 * H); // from the last stored bar
  });

  it("separates keys by broker, epic, timeframe and price side", () => {
    const base = { brokerId: "b", epic: "E", timeframe: "HOUR", priceSide: "mid" };
    const k = htfIntervalKey(base);
    expect(htfIntervalKey({ ...base })).toBe(k);
    expect(htfIntervalKey({ ...base, brokerId: "x" })).not.toBe(k);
    expect(htfIntervalKey({ ...base, epic: "F" })).not.toBe(k);
    expect(htfIntervalKey({ ...base, timeframe: "DAY" })).not.toBe(k);
    expect(htfIntervalKey({ ...base, priceSide: "bid" })).not.toBe(k);
  });

  it("coalesces concurrent identical asks into one walk", async () => {
    const log: Array<[number, number]> = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const load = async (fromMs: number, toMs: number) => {
      log.push([fromMs, toMs]);
      await gate;
      const bars: KLineData[] = [];
      for (let t = Math.ceil(fromMs / H) * H; t <= toMs; t += H) bars.push(mk(t));
      return { bars, failed: false };
    };
    const p1 = fetchHtfInterval(KEY, 0, 10 * H, H, load);
    const p2 = fetchHtfInterval(KEY, 0, 10 * H, H, load);
    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(log.length).toBe(1);
    expect(r1.bars.length).toBe(r2.bars.length);
    expect(htfCacheStats().inflight).toBe(0);
  });
});
