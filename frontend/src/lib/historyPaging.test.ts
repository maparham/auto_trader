import { describe, it, expect, vi } from "vitest";
import {
  pageHistoryBack,
  scrollbackLoadOlder,
  type PageHistoryBackArgs,
  type ScrollbackLoadArgs,
} from "./historyPaging";

// Minimal bar factory — pageHistoryBack only reads `.timestamp`.
const bar = (timestamp: number): { timestamp: number } => ({ timestamp });
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
  maxEmpty?: number; // override the default consecutive-empty budget
}) {
  const data = (opts.initial ?? []).map((t) => bar(t));
  const exhausted = { value: false };
  const applied: number[][] = [];
  const cursors: number[] = [];
  const args: PageHistoryBackArgs<ReturnType<typeof bar>> = {
    fromTs: opts.fromTs,
    toTs: opts.toTs,
    resSec: 60,
    pageBars: 5,
    maxPages: 20,
    maxEmpty: opts.maxEmpty ?? 3,
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
    onCursor: (sec) => {
      cursors.push(sec);
    },
    onExhausted: () => {
      exhausted.value = true;
    },
  };
  return { args, data, exhausted, applied, cursors };
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

  // The "jump to a backtest trade" pager (coverBacktestTradeTo) walks 1m history
  // back to a KNOWN trade timestamp, so real data provably exists at fromTs and
  // any empty windows en route are interior gaps (a weekend the instrument is
  // closed), never end-of-history. A window is pageBars*resSec = 5min wide here;
  // maxEmpty=3 means a 15min+ gap trips false exhaustion. The weekend gap on a
  // real 1m chart (~49h) dwarfs maxEmpty*window (~33h), so empty-exhaustion quits
  // at the weekend and never reaches a trade just on the far side of it.
  it("with the default empty budget, an interior gap wider than maxEmpty falsely exhausts", async () => {
    // Loaded [100]. Target 70 has real data. Gap at 74..99 (26min > 15min budget).
    const server = [70, 71, 72, 73].map((m) => m * MIN);
    const h = harness({
      fromTs: 70 * MIN,
      toTs: 100 * MIN,
      server,
      initial: [100 * MIN],
    });
    const res = await pageHistoryBack(h.args);
    // Quits at the gap before reaching the (real, present) target — the bug.
    expect(res).toBe("exhausted");
    expect(h.data[0].timestamp).toBeGreaterThan(70 * MIN);
  });

  it("crosses an interior gap to reach a known target when empty-exhaustion is disabled", async () => {
    const server = [70, 71, 72, 73].map((m) => m * MIN);
    const h = harness({
      fromTs: 70 * MIN,
      toTs: 100 * MIN,
      server,
      initial: [100 * MIN],
      maxEmpty: Infinity, // cover-trade policy: let maxPages be the sole bound
    });
    const res = await pageHistoryBack(h.args);
    expect(res).toBe("reached");
    // The cursor marched through the empty gap (line 80) and picked up the far bars.
    expect(h.data[0].timestamp).toBeLessThanOrEqual(70 * MIN);
    expect(h.exhausted.value).toBe(false);
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

  // The walk applies ONCE, when it settles. Every apply is a full chart re-init
  // (setBars -> resetData) that snaps the view to the live edge — per-page
  // applies turned a deep walk into N pages of visible thrashing plus a
  // quadratic re-serve of the growing array. Accumulating keeps the chart
  // untouched until the walk finishes, so the follow-up scroll is one jump.
  it("applies exactly once, with the fully merged data, after a multi-page walk", async () => {
    // Two page windows' worth of history (page = 5 min here).
    const server = [88, 89, 90, 91, 92, 93, 94, 95].map((m) => m * MIN);
    const h = harness({
      fromTs: 88 * MIN,
      toTs: 100 * MIN,
      server,
      initial: [96, 97, 98, 99, 100].map((m) => m * MIN),
    });
    const res = await pageHistoryBack(h.args);
    expect(res).toBe("reached");
    expect(h.applied).toHaveLength(1);
    const timestamps = h.applied[0];
    expect(timestamps[0]).toBeLessThanOrEqual(88 * MIN);
    expect(timestamps).toEqual([...new Set(timestamps)].sort((a, b) => a - b));
  });

  it("applies what it accumulated before declaring exhaustion", async () => {
    // One real page (95 min), then nothing older — the walk exhausts, but the
    // page it DID fetch must still land (partial coverage beats none).
    const h = harness({
      fromTs: 0,
      toTs: 100 * MIN,
      server: [95 * MIN],
      initial: [96, 100].map((m) => m * MIN),
    });
    const res = await pageHistoryBack(h.args);
    expect(res).toBe("exhausted");
    expect(h.applied).toHaveLength(1);
    expect(h.applied[0]).toContain(95 * MIN);
  });

  it("applies nothing and fires no onCursor when the walk aborts", async () => {
    let stale = false;
    const h = harness({
      fromTs: 0,
      toTs: 100 * MIN,
      server: [80, 85, 90, 95].map((m) => m * MIN),
      initial: [100 * MIN],
      stale: () => stale,
    });
    const realFetch = h.args.fetchOlder;
    h.args.fetchOlder = vi.fn(async (a: number, b: number) => {
      const r = await realFetch(a, b);
      stale = true;
      return r;
    });
    const res = await pageHistoryBack(h.args);
    expect(res).toBe("aborted");
    expect(h.applied).toHaveLength(0);
    // An aborted walk must not advance the shared scroll-back cursor either:
    // data it fetched was discarded, so a cursor pointing past it would make
    // the next native scroll-back page fetch beyond a never-applied span and
    // prepend bars with a permanent hole behind them.
    expect(h.cursors).toHaveLength(0);
  });

  it("settles with the oldest APPLIED bar as the cursor", async () => {
    const server = [88, 89, 90, 91, 92, 93, 94, 95].map((m) => m * MIN);
    const h = harness({
      fromTs: 88 * MIN,
      toTs: 100 * MIN,
      server,
      initial: [96, 97, 98, 99, 100].map((m) => m * MIN),
    });
    await pageHistoryBack(h.args);
    expect(h.cursors).toEqual([(88 * MIN) / SEC]);
  });

  // The walk takes real wall time (sequential fetches); on a live market the
  // stream keeps appending newer bars to the chart meanwhile. The settle-time
  // apply must merge against the CURRENT data, not a walk-start snapshot —
  // otherwise the full re-init silently deletes every bar appended mid-walk.
  it("keeps bars appended to the dataset during the walk", async () => {
    const h = harness({
      fromTs: 90 * MIN,
      toTs: 100 * MIN,
      server: [90, 91, 92, 93, 94, 95].map((m) => m * MIN),
      initial: [96, 97, 98, 99, 100].map((m) => m * MIN),
    });
    // Simulate a live tick landing while a page fetch is in flight.
    const realFetch = h.args.fetchOlder;
    let appended = false;
    h.args.fetchOlder = vi.fn(async (a: number, b: number) => {
      const r = await realFetch(a, b);
      if (!appended) {
        appended = true;
        h.data.push(bar(101 * MIN));
      }
      return r;
    });
    const res = await pageHistoryBack(h.args);
    expect(res).toBe("reached");
    const timestamps = h.data.map((b) => b.timestamp);
    expect(timestamps).toContain(101 * MIN); // the live append survived
    expect(timestamps).toEqual([...new Set(timestamps)].sort((a, b) => a - b));
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

// Harness for the interactive scroll-back loader (klinecharts DataLoader answer).
// Boundary = oldest loaded bar (100 min); the cursor starts there.
function sbHarness(opts: {
  server: number[]; // older bar timestamps (ms) the broker can return
  maxEmpty?: number;
  stale?: () => boolean;
  fetchOlder?: ScrollbackLoadArgs<{ timestamp: number }>["fetchOlder"];
}) {
  const doneCalls: Array<{ bars: number[]; more: boolean; loadingAtDone: boolean }> = [];
  const loading = { current: false };
  const args: ScrollbackLoadArgs<ReturnType<typeof bar>> = {
    boundary: 100 * MIN,
    resSec: 60,
    pageBars: 5, // page window = 5 min
    maxPageSpanSec: 10_000_000,
    maxEmpty: opts.maxEmpty ?? 3,
    cursorSec: { current: (100 * MIN) / SEC },
    emptyStreak: { current: 0 },
    exhausted: { current: false },
    loading,
    isStale: opts.stale ?? (() => false),
    fetchOlder:
      opts.fetchOlder ??
      (async (fromSec, toSec) =>
        opts.server.filter((t) => t >= fromSec * SEC && t <= toSec * SEC).map((t) => bar(t))),
    done: (bars, more) =>
      doneCalls.push({ bars: bars.map((b) => b.timestamp), more, loadingAtDone: loading.current }),
  };
  return { args, doneCalls };
}

describe("scrollbackLoadOlder", () => {
  it("answers one page of fresh older bars with more=true", async () => {
    const h = sbHarness({ server: [96, 97, 98, 99].map((m) => m * MIN) });
    await scrollbackLoadOlder(h.args);
    expect(h.doneCalls).toHaveLength(1);
    expect(h.doneCalls[0].bars).toEqual([96, 97, 98, 99].map((m) => m * MIN));
    expect(h.doneCalls[0].more).toBe(true);
  });

  it("frees the loading mutex BEFORE done() so klinecharts' synchronous re-ask can start the next page", async () => {
    // done() re-enters the loader synchronously in production (adjustVisibleRange
    // fires the next forward load from inside the callback). If the mutex is
    // still held there, the chain dies after one page per user gesture.
    const h = sbHarness({ server: [99 * MIN] });
    await scrollbackLoadOlder(h.args);
    expect(h.doneCalls[0].loadingAtDone).toBe(false);
  });

  it("crosses interior empty gap windows inside ONE load instead of answering empty", async () => {
    // Gap: nothing in [90,100). Bars exist at 85..89 min, two page windows back.
    // An empty done() would stall the fill until the next user gesture, so the
    // walk must continue internally and answer with the far-side bars.
    const h = sbHarness({ server: [85, 86, 87, 88, 89].map((m) => m * MIN) });
    await scrollbackLoadOlder(h.args);
    expect(h.doneCalls).toHaveLength(1);
    expect(h.doneCalls[0].bars.length).toBeGreaterThan(0);
    expect(h.doneCalls[0].more).toBe(true);
    expect(h.args.cursorSec.current).toBeLessThan((90 * MIN) / SEC);
  });

  it("latches exhaustion (done([], false)) after maxEmpty consecutive empty windows", async () => {
    const h = sbHarness({ server: [], maxEmpty: 3 });
    await scrollbackLoadOlder(h.args);
    expect(h.doneCalls).toHaveLength(1);
    expect(h.doneCalls[0]).toMatchObject({ bars: [], more: false });
    expect(h.args.exhausted.current).toBe(true);
    expect(h.args.loading.current).toBe(false);
  });

  it("a transient fetch failure answers more=true WITHOUT advancing the cursor or the empty streak", async () => {
    const h = sbHarness({
      server: [],
      fetchOlder: async () => {
        throw new Error("503");
      },
    });
    const cursorBefore = h.args.cursorSec.current;
    await scrollbackLoadOlder(h.args);
    expect(h.doneCalls).toHaveLength(1);
    expect(h.doneCalls[0]).toMatchObject({ bars: [], more: true });
    expect(h.args.cursorSec.current).toBe(cursorBefore);
    expect(h.args.emptyStreak.current).toBe(0);
    expect(h.args.exhausted.current).toBe(false);
    expect(h.args.loading.current).toBe(false);
  });

  it("contains a throwing done() (disposed chart): promise resolves, mutex stays free", async () => {
    const h = sbHarness({ server: [99 * MIN] });
    h.args.done = () => {
      throw new Error("chart disposed");
    };
    // Must not reject (a floating rejection would surface as a console error)
    // and must not touch the mutex after freeing it (a catch-side reset would
    // stomp a re-entrant page's ownership in production).
    await expect(scrollbackLoadOlder(h.args)).resolves.toBeUndefined();
    expect(h.args.loading.current).toBe(false);
  });

  it("bails with more=true when the series goes stale mid-flight, applying nothing", async () => {
    let stale = false;
    const h = sbHarness({
      server: [99 * MIN],
      stale: () => stale,
      fetchOlder: async (fromSec, toSec) => {
        stale = true;
        return [99 * MIN].filter((t) => t >= fromSec * SEC && t <= toSec * SEC).map((t) => bar(t));
      },
    });
    await scrollbackLoadOlder(h.args);
    expect(h.doneCalls).toHaveLength(1);
    expect(h.doneCalls[0]).toMatchObject({ bars: [], more: true });
    expect(h.args.loading.current).toBe(false);
  });
});
