import { describe, it, expect, vi, afterEach } from "vitest";
import {
  barsInRange,
  formatForwardPct,
  previewGeometry,
  searchPatterns,
  DEFAULT_MATCH_SORT,
  nextMatchSort,
  sortMatches,
  type MatchSort,
  type PatternMatch,
} from "./patternSearch";

const bar = (ts: number, o: number, h: number, l: number, c: number) => ({ ts, o, h, l, c });

afterEach(() => vi.restoreAllMocks());

describe("barsInRange", () => {
  const bars = [bar(100, 1, 2, 0, 1), bar(200, 1, 2, 0, 1), bar(300, 1, 2, 0, 1)];

  it("selects the bars inside an inclusive millisecond range", () => {
    expect(barsInRange(bars, 100_000, 200_000).map((b) => b.ts)).toEqual([100, 200]);
  });

  it("is empty when the range covers no bar", () => {
    expect(barsInRange(bars, 400_000, 500_000)).toEqual([]);
  });

  it("orders the range regardless of drag direction", () => {
    expect(barsInRange(bars, 300_000, 100_000).map((b) => b.ts)).toEqual([100, 200, 300]);
  });
});

describe("searchPatterns", () => {
  it("posts the request and returns the parsed result", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        matches: [], scanned: 5, series: { oldestTs: 1, newestTs: 2, bars: 6 },
        elapsedMs: 12, cold: false,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const ctrl = new AbortController();
    const out = await searchPatterns({
      epic: "US100", resolution: "MINUTE_5", priceSide: "bid", broker: "capital",
      query: [bar(0, 1, 2, 0, 1.5)], queryFromTs: 1, queryToTs: 2, topK: 20, forwardBars: 20, mode: "ohlc",
    }, ctrl.signal);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/patterns/search");
    expect(init.method).toBe("POST");
    // The request itself, not just the URL: a body of "{}" would otherwise pass.
    expect(JSON.parse(init.body)).toMatchObject({ epic: "US100", topK: 20, queryFromTs: 1 });
    expect(JSON.parse(init.body).query).toHaveLength(1);
    expect(init.signal).toBe(ctrl.signal);
    expect(out.scanned).toBe(5);
  });

  it("throws the server's detail on a 400", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 400,
      json: async () => ({ detail: "the selection has no price movement to match on" }),
      text: async () => "",
    }));
    await expect(
      searchPatterns({
        epic: "US100", resolution: "MINUTE_5", priceSide: "bid", broker: "capital",
        query: [], queryFromTs: 1, queryToTs: 2, topK: 20, forwardBars: 20, mode: "ohlc",
      }),
    ).rejects.toThrow(/no price movement/);
  });
});

describe("previewGeometry", () => {
  const match: PatternMatch = {
    ts: 100, endTs: 200, distance: 0.1,
    bars: [bar(100, 10, 12, 9, 11), bar(200, 11, 13, 10, 10)],
    forward: [bar(300, 10, 11, 8, 9)],
    forwardComplete: true, forwardPct: -18.18,
  };

  it("lays out every bar, flagging the forward ones", () => {
    const g = previewGeometry(match);
    expect(g.candles).toHaveLength(3);
    expect(g.candles.map((c) => c.forward)).toEqual([false, false, true]);
  });

  it("marks direction from open against close", () => {
    expect(previewGeometry(match).candles.map((c) => c.up)).toEqual([true, false, false]);
  });

  it("scales across the match and forward bars together, so the join is readable", () => {
    // The extremes are split across the halves: the 13 high is in the match, the
    // 8 low is in the forward bars. So a shared scale spans 8..13 and each bar's
    // y is pinned to that. Asserting only that the overall min is 0 and max is
    // 100 would hold under independent scaling too, which is exactly the bug
    // this test exists to catch, so assert individual bars instead.
    const g = previewGeometry(match);
    // y(v) = (13 - v) / 5 * 100
    expect(g.candles[0].wickTop).toBeCloseTo(20, 5); // the match's 12 high
    expect(g.candles[2].wickTop).toBeCloseTo(40, 5); // the forward bar's 11 high
    expect(g.candles[2].wickTop + g.candles[2].wickH).toBeCloseTo(100, 5); // its 8 low
  });

  it("keeps every bar inside the box", () => {
    const g = previewGeometry(match);
    const tops = g.candles.map((c) => c.wickTop);
    const bottoms = g.candles.map((c) => c.wickTop + c.wickH);
    expect(Math.min(...tops)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...bottoms)).toBeLessThanOrEqual(100);
  });

  it("puts the divider in the gutter between the last match bar and the first forward bar", () => {
    const g = previewGeometry(match);
    const w = g.candles[1].w;
    // Against bar EDGES, not centres. Candles have width, so a divider drawn
    // straight through the body of the last matched bar still sits between the
    // two centres and would satisfy a centre-based assertion.
    expect(g.dividerX).toBeGreaterThan(g.candles[1].x + w / 2);
    expect(g.dividerX).toBeLessThan(g.candles[2].x - w / 2);
  });

  it("gives a body a minimum height so a doji is still visible", () => {
    const doji: PatternMatch = { ...match, bars: [bar(100, 10, 12, 9, 10)], forward: [] };
    expect(previewGeometry(doji).candles[0].bodyH).toBeGreaterThan(0);
  });
});

describe("formatForwardPct", () => {
  it("signs the number and marks the unit", () => {
    expect(formatForwardPct(0.4237)).toBe("+0.42%");
    expect(formatForwardPct(-1.5)).toBe("-1.50%");
  });

  it("says so when there is no aftermath to measure", () => {
    expect(formatForwardPct(null)).toBe("no bars after");
  });

  it("distinguishes a flat outcome from no outcome", () => {
    // The backend sends null for "no bars after" and a real 0.0 for "went
    // nowhere". A falsy check instead of a null check would collapse the two.
    expect(formatForwardPct(0)).toBe("+0.00%");
  });
});

describe("sortMatches", () => {
  // Distance order (as the backend sends it) deliberately disagrees with both
  // the date order and the outcome order, so a wrong key cannot pass by luck.
  const m = (
    over: Partial<PatternMatch>,
  ): PatternMatch => ({
    ts: 0, endTs: 0, distance: 0,
    bars: [], forward: [], forwardComplete: true, forwardPct: 0,
    ...over,
  });
  // rank 1..4 as received.
  const matches = [
    m({ ts: 300, distance: 0.1, forwardPct: -1.5 }),  // 1
    m({ ts: 100, distance: 0.2, forwardPct: 4.0 }),   // 2
    m({ ts: 400, distance: 0.3, forwardPct: null }),  // 3
    m({ ts: 200, distance: 0.4, forwardPct: 2.0 }),   // 4
  ];
  const ranksOf = (sort: MatchSort) => sortMatches(matches, sort).map((r) => r.rank);

  it("defaults to distance ascending, which is the order the backend sent", () => {
    expect(DEFAULT_MATCH_SORT).toEqual({ key: "dist", dir: "asc" });
    expect(ranksOf(DEFAULT_MATCH_SORT)).toEqual([1, 2, 3, 4]);
  });

  it("sorts by distance both ways", () => {
    expect(sortMatches(matches, { key: "dist", dir: "asc" }).map((r) => r.match.distance))
      .toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(sortMatches(matches, { key: "dist", dir: "desc" }).map((r) => r.match.distance))
      .toEqual([0.4, 0.3, 0.2, 0.1]);
  });

  it("sorts by date both ways", () => {
    expect(sortMatches(matches, { key: "when", dir: "desc" }).map((r) => r.match.ts))
      .toEqual([400, 300, 200, 100]);
    expect(sortMatches(matches, { key: "when", dir: "asc" }).map((r) => r.match.ts))
      .toEqual([100, 200, 300, 400]);
  });

  it("sorts by outcome both ways", () => {
    expect(sortMatches(matches, { key: "outcome", dir: "desc" }).map((r) => r.match.forwardPct))
      .toEqual([4.0, 2.0, -1.5, null]);
    expect(sortMatches(matches, { key: "outcome", dir: "asc" }).map((r) => r.match.forwardPct))
      .toEqual([-1.5, 2.0, 4.0, null]);
  });

  it("puts a missing outcome last in BOTH directions, never treated as zero", () => {
    // A null between -1.5 and 2.0 would mean "no bars after" was read as 0%.
    expect(ranksOf({ key: "outcome", dir: "desc" }).at(-1)).toBe(3);
    expect(ranksOf({ key: "outcome", dir: "asc" }).at(-1)).toBe(3);
  });

  it("leaves a missing outcome alone when sorting by another column", () => {
    // Null-last is an outcome rule only: rank 3 is the newest date and the
    // third-closest, and must sort there.
    expect(ranksOf({ key: "when", dir: "desc" })[0]).toBe(3);
    expect(ranksOf({ key: "dist", dir: "asc" })[2]).toBe(3);
  });

  it("is stable, so equal values keep the order they arrived in", () => {
    const flat = [
      m({ ts: 1, distance: 0.5, forwardPct: 1 }),
      m({ ts: 2, distance: 0.5, forwardPct: 1 }),
      m({ ts: 3, distance: 0.5, forwardPct: 1 }),
    ];
    expect(sortMatches(flat, { key: "dist", dir: "asc" }).map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(sortMatches(flat, { key: "dist", dir: "desc" }).map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(sortMatches(flat, { key: "outcome", dir: "desc" }).map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it("keeps the similarity rank recoverable after any sort", () => {
    // The whole point: sorted by outcome, the best analogue is still labelled
    // with how close it was (rank 2), not with its new position.
    const byOutcome = sortMatches(matches, { key: "outcome", dir: "desc" });
    expect(byOutcome[0].rank).toBe(2);
    expect(byOutcome.map((r) => r.rank)).toEqual([2, 4, 1, 3]);
    // And no rank is lost or duplicated.
    expect([...byOutcome.map((r) => r.rank)].sort()).toEqual([1, 2, 3, 4]);
  });

  it("does not mutate the array it was given", () => {
    const before = matches.map((x) => x.ts);
    sortMatches(matches, { key: "when", dir: "asc" });
    expect(matches.map((x) => x.ts)).toEqual(before);
  });
});

describe("nextMatchSort", () => {
  it("flips the direction of the column already active", () => {
    expect(nextMatchSort({ key: "dist", dir: "asc" }, "dist")).toEqual({ key: "dist", dir: "desc" });
    expect(nextMatchSort({ key: "dist", dir: "desc" }, "dist")).toEqual({ key: "dist", dir: "asc" });
  });

  it("starts a new column at its own most useful end", () => {
    // Closest first, most recent first, best first.
    expect(nextMatchSort({ key: "when", dir: "asc" }, "dist")).toEqual({ key: "dist", dir: "asc" });
    expect(nextMatchSort({ key: "dist", dir: "asc" }, "when")).toEqual({ key: "when", dir: "desc" });
    expect(nextMatchSort({ key: "dist", dir: "asc" }, "outcome"))
      .toEqual({ key: "outcome", dir: "desc" });
  });
});
