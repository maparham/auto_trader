import { describe, it, expect } from "vitest";
import { filterResultToCursor, openTradesAtCursor, revealBarMs } from "./replayReveal";
import type { StoredBacktestResult } from "./persist";

const S = (ms: number) => Math.floor(ms / 1000);
const T = Date.UTC(2026, 2, 2, 12);
const HOUR = 3_600_000;

const result = {
  epic: "US100",
  resolution: "HOUR",
  markers: [
    { time: S(T), side: "buy", price: 100, reason: "entry", leg: "long" },
    { time: S(T + 2 * HOUR), side: "sell", price: 110, reason: "target", leg: "long" },
    { time: S(T + 5 * HOUR), side: "buy", price: 105, reason: "entry", leg: "long" },
  ],
  trades: [
    { entry_time: S(T), exit_time: S(T + 2 * HOUR), pnl: 10 },
    { entry_time: S(T + 5 * HOUR), exit_time: S(T + 7 * HOUR), pnl: -4 },
  ],
  equity: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ time: S(T + i * HOUR), value: 1000 + i })),
  summary: { net_pnl: 6, n_trades: 2, win_rate: 0.5, max_drawdown: 4 },
  metrics: { profit_factor: 2.5, expectancy: 3 },
} as unknown as StoredBacktestResult;

// The guard's width is an UPPER bound on a bar, never the nominal one: too
// narrow reveals a fill before its bar closed, which is the only direction that
// costs anything here.
describe("revealBarMs", () => {
  const DAY = 86_400_000;
  const HOUR = 3_600_000;

  it("is the exact nominal width for the intraday resolutions", () => {
    expect(revealBarMs("MINUTE")).toBe(60_000);
    expect(revealBarMs("MINUTE_15")).toBe(900_000);
    expect(revealBarMs("HOUR")).toBe(HOUR);
    expect(revealBarMs("HOUR_4")).toBe(4 * HOUR);
  });

  it("pads the calendar buckets past their too-narrow nominal width", () => {
    // RESOLUTION_SECONDS says 30d / 90d / 365d. Real months, quarters and years
    // are longer, and a fill on the longer one would be revealed days early.
    expect(revealBarMs("MONTH")).toBeGreaterThanOrEqual(31 * DAY);
    expect(revealBarMs("MONTH_3")).toBeGreaterThanOrEqual(92 * DAY);
    expect(revealBarMs("YEAR")).toBeGreaterThanOrEqual(366 * DAY);
  });

  it("gives every day-or-wider bucket an hour of DST slack", () => {
    // A daily bar spanning a fall-back transition is 25 hours long.
    expect(revealBarMs("DAY")).toBe(DAY + HOUR);
    expect(revealBarMs("WEEK")).toBe(7 * DAY + HOUR);
    expect(revealBarMs("WEEK_2")).toBe(14 * DAY + HOUR);
  });

  it("never returns a width NARROWER than the nominal one", () => {
    for (const [res, secs] of Object.entries(RESOLUTION_SECONDS_SNAPSHOT)) {
      expect(revealBarMs(res)).toBeGreaterThanOrEqual(secs * 1000);
    }
  });

  it("reveals NOTHING for an unrecognised resolution, rather than guessing 60s", () => {
    // Fail-safe: if we cannot say when this result's bars close, we cannot say
    // any of its fills has happened. A legacy/corrupt record shows an empty
    // reveal instead of a leaking one.
    expect(revealBarMs("1m")).toBe(Infinity);
    expect(revealBarMs("")).toBe(Infinity);
    const out = filterResultToCursor(
      { ...result, resolution: "not-a-resolution" } as StoredBacktestResult,
      Date.UTC(2099, 0, 1),
    );
    expect(out.markers).toEqual([]);
    expect(out.trades).toEqual([]);
    expect(out.equity).toEqual([]);
  });
});

// A copy of the widths this module must never undercut, kept local so the test
// states its own expectation rather than re-deriving it from the table it guards.
const RESOLUTION_SECONDS_SNAPSHOT: Record<string, number> = {
  SECOND: 1, MINUTE: 60, MINUTE_5: 300, MINUTE_15: 900, MINUTE_30: 1800,
  HOUR: 3600, HOUR_4: 14400, DAY: 86400, WEEK: 604800, WEEK_2: 1209600,
  WEEK_3: 1814400, WEEK_6: 3628800, MONTH: 2592000, MONTH_2: 5184000,
  MONTH_3: 7776000, YEAR: 31536000,
};

describe("filterResultToCursor", () => {
  it("keeps only markers on bars that have CLOSED at the cursor", () => {
    const out = filterResultToCursor(result, T + 3 * HOUR);
    expect(out.markers).toHaveLength(2);
  });

  it("keeps only trades whose EXIT has happened (an open trade is not yet a result)", () => {
    const out = filterResultToCursor(result, T + 3 * HOUR);
    expect(out.trades).toHaveLength(1);
    expect(out.summary.n_trades).toBe(1);
  });

  it("truncates the equity curve at the newest CLOSED bar", () => {
    const out = filterResultToCursor(result, T + 3 * HOUR);
    expect(out.equity.map((p) => p.time)).toEqual([S(T), S(T + HOUR), S(T + 2 * HOUR)]);
  });

  it("recomputes the summary so the panel cannot spoil the outcome", () => {
    const out = filterResultToCursor(result, T + 3 * HOUR);
    expect(out.summary).toMatchObject({ net_pnl: 10, n_trades: 1, win_rate: 1 });
  });

  it("drops the per-direction breakdown and the run-level metrics that would leak", () => {
    const out = filterResultToCursor(result, T + 3 * HOUR);
    expect(out.by_leg).toBeUndefined();
    expect(out.metrics.profit_factor).not.toBe(2.5);
  });

  it("returns an empty-but-valid result before the first fill", () => {
    const out = filterResultToCursor(result, T - HOUR);
    expect(out.markers).toEqual([]);
    expect(out.trades).toEqual([]);
    expect(out.summary.n_trades).toBe(0);
  });

  // --- the one-bar lookahead the naive `time <= cursor` predicate admits -----
  //
  // `cursorMs` is the CLOSE of the newest revealed bar (see replayBars), while
  // every backend time on a result is a bar OPEN. So `time <= cursorMs` lets
  // through exactly the bar the cursor is about to reveal: the fill that has not
  // printed yet, the trade that closes NEXT, the equity point one step ahead.
  describe("the boundary bar", () => {
    it("hides a marker stamped exactly at the cursor (that bar is not revealed yet)", () => {
      // Cursor T+2h => the newest revealed bar OPENS at T+1h. The sell marker is
      // stamped T+2h, on the bar that has yet to print.
      const out = filterResultToCursor(result, T + 2 * HOUR);
      expect(out.markers.map((m) => m.time)).toEqual([S(T)]);
    });

    it("hides a trade whose exit is stamped exactly at the cursor", () => {
      const out = filterResultToCursor(result, T + 2 * HOUR);
      expect(out.trades).toEqual([]);
      expect(out.summary.net_pnl).toBe(0);
    });

    it("hides an equity point stamped exactly at the cursor", () => {
      const out = filterResultToCursor(result, T + 2 * HOUR);
      expect(out.equity.map((p) => p.time)).toEqual([S(T), S(T + HOUR)]);
    });

    it("reveals the same marker one step later", () => {
      const out = filterResultToCursor(result, T + 3 * HOUR);
      expect(out.markers.map((m) => m.time)).toEqual([S(T), S(T + 2 * HOUR)]);
    });
  });

  // A backtest COARSER than the replay chart: a 1H fill stamped 10:00 was decided
  // on the whole 10:00-11:00 hour, so a 15m cursor stepping past 10:00 must not
  // reveal it 45 minutes early. Same shape as mtfCoordinator's clampHtfBars.
  it("waits for the backtest's OWN bar to close, not the chart's", () => {
    const at1015 = filterResultToCursor(result, T + HOUR / 4);
    expect(at1015.markers).toEqual([]);
    const at1100 = filterResultToCursor(result, T + HOUR);
    expect(at1100.markers.map((m) => m.time)).toEqual([S(T)]);
  });

  // --- fields that ride the spread ------------------------------------------

  it("drops every whole-run field that would spoil the outcome", () => {
    const rich = {
      ...result,
      period: { fromMs: T, toMs: T + 7 * HOUR },
      analysis: { exit_reasons: [] },
      cost_sensitivity: { multiples: [1, 2, 3], net_pnl: [6, 2, -1], breakeven_multiple: 2.5 },
      baselines: { buy_hold: { return_pct: 12 } },
      run_id: "abc",
      fileBracketsOverridden: true,
    } as unknown as StoredBacktestResult;
    const out = filterResultToCursor(rich, T + 3 * HOUR);
    expect(out.period).toBeUndefined();
    expect(out.analysis).toBeUndefined();
    expect(out.cost_sensitivity).toBeUndefined();
    expect(out.baselines).toBeUndefined();
    expect(out.run_id).toBeUndefined();
    expect(out.fileBracketsOverridden).toBeUndefined();
  });

  it("keeps only strategy regions that have already ENDED", () => {
    const withRegions = {
      ...result,
      regions: [
        { from_time: S(T), to_time: S(T + HOUR), top: 110, bottom: 100, label: "squeeze" },
        { from_time: S(T + HOUR), to_time: S(T + 6 * HOUR), top: 112, bottom: 104, label: "open" },
        { from_time: S(T + 5 * HOUR), to_time: S(T + 6 * HOUR), top: 115, bottom: 108, label: "later" },
      ],
    } as unknown as StoredBacktestResult;
    const out = filterResultToCursor(withRegions, T + 3 * HOUR);
    expect(out.regions?.map((r) => r.label)).toEqual(["squeeze"]);
  });

  it("carries the identity fields through so the chart can still anchor the slice", () => {
    const out = filterResultToCursor(result, T + 3 * HOUR);
    expect(out.epic).toBe("US100");
    expect(out.resolution).toBe("HOUR");
  });

  // --- requirement: the reveal is MONOTONIC, not merely filtered at one cursor -
  //
  // A single-cursor assertion cannot tell a correct filter from one that happens
  // to be right at that instant. Walk the cursor bar by bar across the whole
  // fixture and assert the two properties that make the reveal honest:
  //   1. nothing EVER disappears as the cursor advances (the revealed set only
  //      grows), and
  //   2. nothing appears BEFORE the bar it belongs to has closed.
  describe("walking the cursor forward", () => {
    // 12 hourly steps: two bars of run-up before the first fill, then past the
    // last trade's exit at T+7h.
    const cursors = [-2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => T + i * HOUR);

    it("never un-reveals a marker, a trade or an equity point", () => {
      let prevMarkers: number[] = [];
      let prevTrades: number[] = [];
      let prevEquity: number[] = [];
      for (const cursor of cursors) {
        const out = filterResultToCursor(result, cursor);
        const markers = out.markers.map((m) => m.time);
        const trades = out.trades.map((t) => t.exit_time);
        const equity = out.equity.map((p) => p.time);
        // Each set is a prefix-superset of the previous one: same order, and
        // every earlier member still present.
        expect(markers.slice(0, prevMarkers.length)).toEqual(prevMarkers);
        expect(trades.slice(0, prevTrades.length)).toEqual(prevTrades);
        expect(equity.slice(0, prevEquity.length)).toEqual(prevEquity);
        prevMarkers = markers;
        prevTrades = trades;
        prevEquity = equity;
      }
      // ...and by the end the whole run is out.
      expect(prevMarkers).toHaveLength(3);
      expect(prevTrades).toHaveLength(2);
    });

    it("never shows anything whose bar has not closed at that cursor", () => {
      const nativeMs = HOUR; // result.resolution === "HOUR"
      for (const cursor of cursors) {
        const out = filterResultToCursor(result, cursor);
        for (const m of out.markers) expect(m.time * 1000 + nativeMs).toBeLessThanOrEqual(cursor);
        for (const t of out.trades) expect(t.exit_time * 1000 + nativeMs).toBeLessThanOrEqual(cursor);
        for (const p of out.equity) expect(p.time * 1000 + nativeMs).toBeLessThanOrEqual(cursor);
      }
    });

    it("reveals a fill five bars out only once the cursor reaches it", () => {
      // The third marker / second trade sit at T+5h and T+7h respectively.
      expect(filterResultToCursor(result, T + 2 * HOUR).markers).toHaveLength(1);
      expect(filterResultToCursor(result, T + 5 * HOUR).markers).toHaveLength(2);
      expect(filterResultToCursor(result, T + 6 * HOUR).markers).toHaveLength(3);
      expect(filterResultToCursor(result, T + 7 * HOUR).trades).toHaveLength(1);
      expect(filterResultToCursor(result, T + 8 * HOUR).trades).toHaveLength(2);
    });

    it("keeps the running summary honest at every step", () => {
      // Before the losing trade closes the running net is the winner alone; only
      // the final step may show the run's real net P&L.
      expect(filterResultToCursor(result, T + 3 * HOUR).summary.net_pnl).toBe(10);
      expect(filterResultToCursor(result, T + 7 * HOUR).summary.net_pnl).toBe(10);
      expect(filterResultToCursor(result, T + 8 * HOUR).summary.net_pnl).toBe(6);
    });
  });
});

// The in-flight trade: entry printed, exit not. Its own describe rather than a
// case inside the slice's, because the point is that it lives OUTSIDE the slice
// — nothing here may reach `trades`, the summary, or the panel's index space.
describe("openTradesAtCursor", () => {
  const open = {
    entry_time: S(T + 5 * HOUR),
    exit_time: S(T + 7 * HOUR),
    pnl: -4,
    leg: "short",
    quantity: 2,
    entry_price: 105,
    stop_initial: 108,
    stop_final: 106, // where the trail had walked to BY THE EXIT: tomorrow's stop
    target: 99,
    reason: "stop",
  };
  const withOpen = { ...result, trades: [result.trades[0], open] } as unknown as StoredBacktestResult;

  it("is empty before the entry's bar has closed", () => {
    expect(openTradesAtCursor(withOpen, T + 5 * HOUR)).toEqual([]);
  });

  it("holds the trade for every cursor between the entry's close and the exit's", () => {
    expect(openTradesAtCursor(withOpen, T + 6 * HOUR)).toHaveLength(1);
    expect(openTradesAtCursor(withOpen, T + 7 * HOUR)).toHaveLength(1);
  });

  it("drops it the moment the exit's bar closes, when the slice picks it up", () => {
    expect(openTradesAtCursor(withOpen, T + 8 * HOUR)).toEqual([]);
    expect(filterResultToCursor(withOpen, T + 8 * HOUR).trades).toHaveLength(2);
  });

  it("carries the entry side of the trade and the INITIAL stop, never the final one", () => {
    const [t] = openTradesAtCursor(withOpen, T + 6 * HOUR);
    expect(t).toEqual({
      index: 1,
      leg: "short",
      quantity: 2,
      entryTime: S(T + 5 * HOUR),
      entryPrice: 105,
      stop: 108,
      target: 99,
    });
    // Everything that describes how the trade ENDS is absent, not merely unused.
    expect(Object.keys(t)).not.toContain("exit_price");
    expect(Object.keys(t)).not.toContain("pnl");
    expect(Object.keys(t)).not.toContain("reason");
  });

  it("rides the slice as its own field, counted by nothing", () => {
    const out = filterResultToCursor(withOpen, T + 6 * HOUR);
    expect(out.openTrades).toHaveLength(1);
    // The whole reason it is not in `trades`: an open trade has no P&L, so it
    // must not move the running summary or the metrics beside it.
    expect(out.trades).toHaveLength(1);
    expect(out.summary.n_trades).toBe(1);
    expect(out.summary.net_pnl).toBe(10); // the closed winner alone
  });

  it("never overlaps the slice: a trade is open or closed, never both", () => {
    for (let h = 0; h <= 9; h++) {
      const cursor = T + h * HOUR;
      const closed = filterResultToCursor(withOpen, cursor).trades.map((t) => t.entry_time);
      const opened = openTradesAtCursor(withOpen, cursor).map((t) => t.entryTime);
      expect(opened.filter((e) => closed.includes(e))).toEqual([]);
    }
  });
});
