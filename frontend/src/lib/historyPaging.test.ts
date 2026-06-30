import { describe, it, expect, vi } from "vitest";
import { pageHistoryBack, type PageHistoryBackArgs } from "./historyPaging";

// Minimal bar factory — pageHistoryBack only reads `.timestamp`.
const bar = (timestamp: number) => ({ timestamp }) as never;
const SEC = 1000;
const MIN = 60 * SEC;

// A small harness: an in-memory bar list that fetchOlder feeds from a fixed
// "server" history, mirroring how the chart prepends older pages.
function harness(opts: {
  fromTs: number;
  toTs: number;
  server: number[]; // older bar timestamps (ms) the broker can return, any order
  initial?: number[]; // bars already loaded (ms), ascending
  stale?: () => boolean;
}) {
  const data = (opts.initial ?? []).map((t) => bar(t));
  const exhausted = { value: false };
  const applied: number[][] = [];
  const args: PageHistoryBackArgs<ReturnType<typeof bar>> = {
    fromTs: opts.fromTs,
    toTs: opts.toTs,
    resSec: 60,
    pageBars: 5,
    maxPages: 20,
    maxEmpty: 3,
    isStale: opts.stale ?? (() => false),
    getData: () => data,
    fetchOlder: vi.fn(async (fromSec: number, toSec: number) => {
      const fromMs = fromSec * SEC;
      const toMs = toSec * SEC;
      return opts.server.filter((t) => t >= fromMs && t <= toMs).map((t) => bar(t));
    }),
    applyData: (merged) => {
      data.length = 0;
      data.push(...merged);
      applied.push(merged.map((b) => b.timestamp));
    },
    onExhausted: () => {
      exhausted.value = true;
    },
  };
  return { args, data, exhausted, applied };
}

describe("pageHistoryBack", () => {
  it("walks older bars back until coverage reaches fromTs, then returns 'reached'", async () => {
    const now = 100 * MIN;
    // Loaded: bars at 96..100 min. Want coverage back to 90 min. Server has 90..95.
    const server = [90, 91, 92, 93, 94, 95].map((m) => m * MIN);
    const h = harness({
      fromTs: 90 * MIN,
      toTs: now,
      server,
      initial: [96, 97, 98, 99, 100].map((m) => m * MIN),
    });
    const res = await pageHistoryBack(h.args);
    expect(res).toBe("reached");
    // Oldest loaded bar now reaches the period start.
    expect(h.data[0].timestamp).toBeLessThanOrEqual(90 * MIN);
  });

  it("never re-applies bars at or newer than the current oldest (no duplicates)", async () => {
    const h = harness({
      fromTs: 90 * MIN,
      toTs: 100 * MIN,
      // Server overlaps the loaded range (96,97) plus genuinely older (94,95).
      server: [94, 95, 96, 97].map((m) => m * MIN),
      initial: [96, 97, 98].map((m) => m * MIN),
    });
    await pageHistoryBack(h.args);
    const timestamps = h.data.map((b) => b.timestamp);
    expect(timestamps).toEqual([...new Set(timestamps)].sort((a, b) => a - b));
    // 96 and 97 were already loaded; only 94 and 95 get prepended.
    expect(timestamps).toContain(94 * MIN);
    expect(timestamps).toContain(95 * MIN);
  });

  it("declares exhausted after maxEmpty consecutive empty windows", async () => {
    const h = harness({
      fromTs: 0, // unreachable target so it walks until exhausted
      toTs: 100 * MIN,
      server: [], // broker has no older history
      initial: [100 * MIN],
    });
    const res = await pageHistoryBack(h.args);
    expect(res).toBe("exhausted");
    expect(h.exhausted.value).toBe(true);
  });

  it("aborts without applying when isStale() flips true mid-walk", async () => {
    let stale = false;
    const h = harness({
      fromTs: 0,
      toTs: 100 * MIN,
      server: [80, 85, 90, 95].map((m) => m * MIN),
      initial: [100 * MIN],
      stale: () => stale,
    });
    // Flip stale right after the first fetch resolves.
    const realFetch = h.args.fetchOlder;
    h.args.fetchOlder = vi.fn(async (a: number, b: number) => {
      const r = await realFetch(a, b);
      stale = true;
      return r;
    });
    const res = await pageHistoryBack(h.args);
    expect(res).toBe("aborted");
    // The post-fetch staleness check fires before applyData, so nothing landed.
    expect(h.applied.length).toBe(0);
  });

  it("returns 'aborted' immediately when stale before the first fetch", async () => {
    const h = harness({
      fromTs: 0,
      toTs: 100 * MIN,
      server: [90 * MIN],
      initial: [100 * MIN],
      stale: () => true,
    });
    const res = await pageHistoryBack(h.args);
    expect(res).toBe("aborted");
    expect(h.args.fetchOlder).not.toHaveBeenCalled();
  });
});
