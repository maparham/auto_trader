// The provider's whole job is "fetch these bars once". These tests pin the
// rules that decide when a caller may ride someone else's walk, because getting
// them wrong is either a silent duplicate fetch (the bug it exists to kill) or,
// worse, an indicator served bars that do not reach back as far as it asked.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { KLineData } from "klinecharts";

import {
  fetchHtfShared,
  htfKey,
  clearHtfCache,
  htfCacheStats,
  HTF_CACHE_TTL_MS,
} from "./htfBarCache";

const KEY = "k";
const bars = (n: number): KLineData[] =>
  Array.from({ length: n }, (_, i) => ({
    timestamp: i * 60_000,
    open: 1,
    high: 1,
    low: 1,
    close: 1,
    volume: 1,
  })) as KLineData[];

/** A loader that counts calls and resolves when told, so overlapping callers
 * can be observed while a walk is genuinely still in flight. */
function deferredLoader(result: KLineData[] = bars(3), failed = false) {
  const calls: number[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const load = async (fromMs: number) => {
    calls.push(fromMs);
    await gate;
    return { htf: result, failed };
  };
  return { load, calls, release };
}

let clock = 1_000_000;
let nowSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  clock = 1_000_000;
  nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);
  clearHtfCache();
});
afterEach(() => nowSpy.mockRestore());

describe("in-flight sharing", () => {
  it("collapses concurrent identical requests into ONE walk", () => {
    const { load, calls, release } = deferredLoader();
    const a = fetchHtfShared(KEY, 500, load);
    const b = fetchHtfShared(KEY, 500, load);
    const c = fetchHtfShared(KEY, 500, load);
    release();
    return Promise.all([a, b, c]).then((res) => {
      expect(calls).toHaveLength(1);
      expect(res[0]).toBe(res[1]);
      expect(res[1]).toBe(res[2]);
    });
  });

  it("lets a shallower need ride a deeper walk already running", async () => {
    const { load, calls, release } = deferredLoader();
    const deep = fetchHtfShared(KEY, 100, load); // reaches back to 100
    const shallow = fetchHtfShared(KEY, 900, load); // only needs 900 onwards
    release();
    await Promise.all([deep, shallow]);
    expect(calls).toEqual([100]);
  });

  it("does NOT serve a deeper need from a shallower walk", async () => {
    const { load, calls, release } = deferredLoader();
    const shallow = fetchHtfShared(KEY, 900, load);
    const deep = fetchHtfShared(KEY, 100, load); // needs more history: own walk
    release();
    await Promise.all([shallow, deep]);
    expect(calls).toEqual([900, 100]);
  });

  it("keeps a superseded walk serving its own riders", async () => {
    const { load, calls, release } = deferredLoader();
    const shallowA = fetchHtfShared(KEY, 900, load);
    const shallowB = fetchHtfShared(KEY, 900, load); // rides shallowA
    const deep = fetchHtfShared(KEY, 100, load); // replaces the in-flight slot
    release();
    const [a, b] = await Promise.all([shallowA, shallowB, deep]);
    expect(a).toBe(b); // the superseded walk still resolved its riders
    expect(calls).toEqual([900, 100]);
    expect(htfCacheStats().inflight).toBe(0); // and both slots cleaned up
  });

  it("separates different keys", async () => {
    const { load, calls, release } = deferredLoader();
    const a = fetchHtfShared("US100|DAY", 100, load);
    const b = fetchHtfShared("GOLD|DAY", 100, load);
    release();
    await Promise.all([a, b]);
    expect(calls).toHaveLength(2);
  });
});

describe("completed-walk reuse", () => {
  it("serves a later request from a fresh result", async () => {
    const { load, calls, release } = deferredLoader();
    release();
    await fetchHtfShared(KEY, 100, load);
    clock += HTF_CACHE_TTL_MS - 1;
    await fetchHtfShared(KEY, 100, load);
    expect(calls).toHaveLength(1);
  });

  it("re-walks once the result has aged out", async () => {
    const { load, calls, release } = deferredLoader();
    release();
    await fetchHtfShared(KEY, 100, load);
    clock += HTF_CACHE_TTL_MS;
    await fetchHtfShared(KEY, 100, load);
    expect(calls).toHaveLength(2);
  });

  it("never reuses a FAILED walk, so retries stay possible", async () => {
    const { load, calls, release } = deferredLoader(bars(1), true);
    release();
    const first = await fetchHtfShared(KEY, 100, load);
    expect(first.failed).toBe(true);
    await fetchHtfShared(KEY, 100, load); // immediately after: must re-walk
    expect(calls).toHaveLength(2);
    expect(htfCacheStats().cached).toBe(0);
  });

  it("does not serve a deeper need from a shallower cached result", async () => {
    const { load, calls, release } = deferredLoader();
    release();
    await fetchHtfShared(KEY, 900, load);
    await fetchHtfShared(KEY, 100, load);
    expect(calls).toEqual([900, 100]);
  });
});

describe("htfKey", () => {
  const base = {
    brokerId: "capital",
    epic: "US100",
    timeframe: "DAY",
    priceSide: "mid",
    newestMs: 1_700_000_000_000,
    htfMs: 86_400_000,
  };

  it("pools two indicators on the same bars", () => {
    expect(htfKey(base)).toBe(
      htfKey({ ...base, newestMs: base.newestMs + 60_000 }),
    );
  });

  it("separates price sides, since they are different bars", () => {
    expect(htfKey(base)).not.toBe(htfKey({ ...base, priceSide: "bid" }));
  });

  it("separates epic, timeframe and broker", () => {
    expect(htfKey(base)).not.toBe(htfKey({ ...base, epic: "GOLD" }));
    expect(htfKey(base)).not.toBe(htfKey({ ...base, timeframe: "HOUR" }));
    expect(htfKey(base)).not.toBe(htfKey({ ...base, brokerId: "mt5" }));
  });

  it("separates a replaying cell from a live one", () => {
    // A cell replaying a month ago sits in a different bucket, so it can never
    // be served the live chart's bars.
    const replaying = { ...base, newestMs: base.newestMs - 30 * 86_400_000 };
    expect(htfKey(base)).not.toBe(htfKey(replaying));
  });
});
