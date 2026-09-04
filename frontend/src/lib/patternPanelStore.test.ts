import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  dismissPatternPanel,
  getPatternPanelState,
  resetPatternPanel,
  runPatternSearch,
  setPatternForwardBars,
  setPatternMode,
  setPatternScope,
  setPatternSeriesProvider,
  subscribePatternPanel,
} from "./patternPanelStore";
import * as api from "./patternSearch";
import { barsInRange, type MatchSource } from "./patternSearch";
import { clearPatternTargets } from "./patternTargets";

const mkBars = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    ts: 1_700_000_000 + i * 300, o: 10 + i, h: 11 + i, l: 9 + i, c: 10.5 + i,
  }));

// 80 bars for the ordinary flows; the cap tests build their own 1100.
const bars = mkBars(80);

const result = (scanned: number): api.PatternSearchResult => ({
  matches: [], scanned, series: { oldestTs: 1, newestTs: 2, bars: 80 },
  elapsedMs: 3, cold: false,
});

// The workspace's searchable series, as App enumerates them: origin first is
// NOT assumed — the store finds the origin by cellId.
const SELF: MatchSource = { cellId: "cell-1", tabId: "tab-1", epic: "US100", resolution: "MINUTE_5", label: "5m" };
const GOLD: MatchSource = { cellId: "cell-2", tabId: "tab-2", epic: "GOLD", resolution: "MINUTE_15", label: "15m" };

/** What a cell's drag gesture sends: the bars inside the dragged range. */
const run = (fromMs: number, toMs: number, all = bars) =>
  runPatternSearch({
    origin: { cellId: "cell-1", epic: "US100", resolution: "MINUTE_5", label: "5m" },
    broker: "capital",
    priceSide: "bid",
    bars: barsInRange(all, fromMs, toMs),
    range: { fromMs, toMs },
  });

const settled = () => vi.waitFor(() => expect(getPatternPanelState().loading).toBe(false));

beforeEach(() => {
  vi.restoreAllMocks();
  // The store and the target registry are module-level on purpose, so tests
  // must reset them or one test's state leaks into the next.
  resetPatternPanel();
  clearPatternTargets();
  setPatternSeriesProvider(() => [SELF]);
});

describe("patternPanelStore", () => {
  it("sends only the bars inside the picked range", async () => {
    const spy = vi.spyOn(api, "searchPatterns").mockResolvedValue(result(1));
    run(1_700_000_000_000, 1_700_001_500_000);
    await settled();
    expect(spy.mock.calls[0][0].query).toHaveLength(6);
    expect(spy.mock.calls[0][0].queryFromTs).toBe(1_700_000_000);
  });

  it("exposes the range it searched so the band can stay painted", async () => {
    vi.spyOn(api, "searchPatterns").mockResolvedValue(result(1));
    run(1_700_000_000_000, 1_700_001_500_000);
    await settled();
    expect(getPatternPanelState().range).toEqual({ fromMs: 1_700_000_000_000, toMs: 1_700_001_500_000 });
  });

  it("records the origin series, enriched with its tab from the workspace list", async () => {
    vi.spyOn(api, "searchPatterns").mockResolvedValue(result(1));
    run(1_700_000_000_000, 1_700_001_500_000);
    await settled();
    // The drag gesture does not know the tab its cell lives on; the provider does.
    expect(getPatternPanelState().origin).toEqual(SELF);
  });

  it("refuses a range covering fewer than three candles without calling the server", () => {
    const spy = vi.spyOn(api, "searchPatterns").mockResolvedValue(result(1));
    run(1_700_000_000_000, 1_700_000_200_000);
    expect(spy).not.toHaveBeenCalled();
    expect(getPatternPanelState().error).toMatch(/at least 3 candles/);
    expect(getPatternPanelState().loading).toBe(false);
  });

  it("caps the query at 1024 candles, keeping the most recent ones", async () => {
    const spy = vi.spyOn(api, "searchPatterns").mockResolvedValue(result(1));
    const long = mkBars(1100);
    // The whole 1100-bar drag. The backend's schema rejects more than 1024, so
    // an uncapped request is a 422 rather than a slow search.
    run(1_700_000_000_000, 1_700_000_000_000 + 1099 * 300_000, long);
    await settled();
    const sent = spy.mock.calls[0][0];
    expect(sent.query).toHaveLength(1024);
    // The NEWEST 1024, not the oldest: slice(-MAX_BARS), not slice(0, MAX_BARS).
    expect(sent.query[1023].ts).toBe(long[1099].ts);
    expect(sent.queryFromTs).toBe(long[76].ts);
    expect(getPatternPanelState().truncatedTo).toBe(1024);
  });

  it("reports no truncation for a selection inside the cap", async () => {
    vi.spyOn(api, "searchPatterns").mockResolvedValue(result(1));
    run(1_700_000_000_000, 1_700_000_000_000 + 40 * 300_000);
    await settled();
    expect(getPatternPanelState().truncatedTo).toBeNull();
  });

  it("a too-short drag supersedes a search still in flight", async () => {
    // Without the request-id bump in the guard, the earlier valid search
    // resolves and replaces this error with results for the previous range.
    let resolveFirst: (r: api.PatternSearchResult) => void = () => {};
    vi.spyOn(api, "searchPatterns").mockImplementationOnce(
      () => new Promise((r) => { resolveFirst = r; }),
    );
    run(1_700_000_000_000, 1_700_003_000_000);
    run(1_700_000_000_000, 1_700_000_200_000);
    expect(getPatternPanelState().error).toMatch(/at least 3 candles/);
    resolveFirst(result(999));
    await new Promise((r) => setTimeout(r, 0));
    expect(getPatternPanelState().result).toBeNull();
    expect(getPatternPanelState().error).toMatch(/at least 3 candles/);
    expect(getPatternPanelState().loading).toBe(false);
  });

  it("keeps the latest result when responses arrive out of order", async () => {
    let resolveFirst: (r: api.PatternSearchResult) => void = () => {};
    const spy = vi.spyOn(api, "searchPatterns")
      .mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }))
      .mockResolvedValueOnce(result(222));
    run(1_700_000_000_000, 1_700_003_000_000);
    run(1_700_000_000_000, 1_700_004_000_000);
    await vi.waitFor(() => expect(getPatternPanelState().result?.scanned).toBe(222));
    resolveFirst(result(111));
    await new Promise((r) => setTimeout(r, 0));
    expect(getPatternPanelState().result?.scanned).toBe(222);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("surfaces the server's message", async () => {
    vi.spyOn(api, "searchPatterns").mockRejectedValue(new Error("no stored history"));
    run(1_700_000_000_000, 1_700_003_000_000);
    await vi.waitFor(() => expect(getPatternPanelState().error).toBe("no stored history"));
    expect(getPatternPanelState().loading).toBe(false);
  });

  it("notifies subscribers with a fresh snapshot on every change", async () => {
    vi.spyOn(api, "searchPatterns").mockResolvedValue(result(1));
    const seen: boolean[] = [];
    const off = subscribePatternPanel(() => seen.push(getPatternPanelState().loading));
    run(1_700_000_000_000, 1_700_003_000_000);
    await settled();
    off();
    // At least the loading flip and the result landing, in order.
    expect(seen[0]).toBe(true);
    expect(seen[seen.length - 1]).toBe(false);
  });

  it("defaults to shape matching and a 20-bar aftermath", async () => {
    const spy = vi.spyOn(api, "searchPatterns").mockResolvedValue(result(1));
    expect(getPatternPanelState().mode).toBe("shape");
    expect(getPatternPanelState().forwardBars).toBe(20);
    run(1_700_000_000_000, 1_700_003_000_000);
    await settled();
    expect(spy.mock.calls[0][0].mode).toBe("shape");
    expect(spy.mock.calls[0][0].forwardBars).toBe(20);
  });

  it("re-runs the last query on the new metric, so the change is visible at once", async () => {
    const spy = vi.spyOn(api, "searchPatterns").mockResolvedValue(result(1));
    run(1_700_000_000_000, 1_700_003_000_000);
    await settled();
    setPatternMode("close");
    await settled();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1][0].mode).toBe("close");
    expect(spy.mock.calls[1][0].queryFromTs).toBe(spy.mock.calls[0][0].queryFromTs);
    expect(getPatternPanelState().mode).toBe("close");
  });

  it("re-runs the last query on the new horizon", async () => {
    const spy = vi.spyOn(api, "searchPatterns").mockResolvedValue(result(1));
    run(1_700_000_000_000, 1_700_003_000_000);
    await settled();
    setPatternForwardBars(50);
    await settled();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1][0].forwardBars).toBe(50);
    expect(getPatternPanelState().forwardBars).toBe(50);
  });

  it("a control change re-runs the ORIGINAL query even if the origin chart moved on", async () => {
    // The panel is workspace-level: the chart the query was dragged on may have
    // switched symbol or timeframe since. The query bars were captured at drag
    // time and stay valid on their own, so the re-run must not re-read anything
    // from the (changed) chart.
    const spy = vi.spyOn(api, "searchPatterns").mockResolvedValue(result(1));
    run(1_700_000_000_000, 1_700_003_000_000);
    await settled();
    setPatternMode("dtw");
    await settled();
    expect(spy.mock.calls[1][0].epic).toBe("US100");
    expect(spy.mock.calls[1][0].query).toEqual(spy.mock.calls[0][0].query);
  });

  it("changing a control before any search does nothing but remember it", () => {
    const spy = vi.spyOn(api, "searchPatterns").mockResolvedValue(result(1));
    setPatternMode("close");
    setPatternForwardBars(50);
    expect(spy).not.toHaveBeenCalled();
    expect(getPatternPanelState().mode).toBe("close");
    expect(getPatternPanelState().forwardBars).toBe(50);
  });

  it("keeps the controls after a dismiss: they are how you search, not a result", async () => {
    vi.spyOn(api, "searchPatterns").mockResolvedValue(result(1));
    run(1_700_000_000_000, 1_700_003_000_000);
    await settled();
    setPatternMode("close");
    await settled();
    dismissPatternPanel();
    expect(getPatternPanelState().mode).toBe("close");
    expect(getPatternPanelState().forwardBars).toBe(20);
  });

  it("a control change after a dismiss searches nothing: the query went with it", async () => {
    const spy = vi.spyOn(api, "searchPatterns").mockResolvedValue(result(1));
    run(1_700_000_000_000, 1_700_003_000_000);
    await settled();
    dismissPatternPanel();
    setPatternMode("close");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("a search still in flight when the panel is dismissed cannot resurrect it", async () => {
    let resolveFirst: (r: api.PatternSearchResult) => void = () => {};
    vi.spyOn(api, "searchPatterns").mockImplementationOnce(
      () => new Promise((r) => { resolveFirst = r; }),
    );
    run(1_700_000_000_000, 1_700_003_000_000);
    dismissPatternPanel();
    resolveFirst(result(111));
    await new Promise((r) => setTimeout(r, 0));
    expect(getPatternPanelState().result).toBeNull();
    expect(getPatternPanelState().loading).toBe(false);
  });

  describe("all scope: searching every chart in every tab", () => {
    const workspace = (...extra: MatchSource[]) =>
      setPatternSeriesProvider(() => [SELF, ...extra]);

    it("defaults to all-charts scope", () => {
      expect(getPatternPanelState().scope).toBe("all");
    });

    it("fans out one search per workspace chart, same query bars, each chart's own series", async () => {
      const spy = vi.spyOn(api, "searchPatterns").mockResolvedValue(result(1));
      workspace(GOLD);
      run(1_700_000_000_000, 1_700_001_500_000);
      await settled();
      const reqs = spy.mock.calls.map((c) => c[0]);
      expect(reqs.map((r) => `${r.epic}|${r.resolution}`).sort()).toEqual([
        "GOLD|MINUTE_15", "US100|MINUTE_5",
      ]);
      // The query is the ORIGIN chart's drag on both requests.
      expect(new Set(reqs.map((r) => r.queryFromTs)).size).toBe(1);
      expect(reqs[0].query).toEqual(reqs[1].query);
    });

    it("searches a series only once when two cells show the same symbol and timeframe", async () => {
      const spy = vi.spyOn(api, "searchPatterns").mockResolvedValue(result(1));
      workspace({ ...SELF, cellId: "cell-3", tabId: "tab-3" });
      run(1_700_000_000_000, 1_700_001_500_000);
      await settled();
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("runs at most four searches concurrently", async () => {
      let inFlight = 0;
      let peak = 0;
      vi.spyOn(api, "searchPatterns").mockImplementation(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return result(1);
      });
      workspace(
        ...Array.from({ length: 9 }, (_, i) => ({
          cellId: `c${i}`, tabId: `t${i}`, epic: `EPIC${i}`, resolution: "HOUR", label: "1H",
        })),
      );
      run(1_700_000_000_000, 1_700_001_500_000);
      await vi.waitFor(() => expect(getPatternPanelState().result).not.toBeNull());
      expect(getPatternPanelState().result!.sources).toHaveLength(10);
      expect(peak).toBeLessThanOrEqual(4);
      expect(peak).toBeGreaterThan(1);
    });

    it("tags merged matches with their chart and lists per-series sources", async () => {
      const match = {
        ts: 5, endTs: 6, distance: 0.5, bars: mkBars(3), forward: [],
        forwardComplete: false, forwardPct: null,
      };
      vi.spyOn(api, "searchPatterns").mockImplementation(async (req) =>
        req.epic === "GOLD"
          ? { ...result(50), matches: [{ ...match, distance: 0.1 }] }
          : { ...result(100), matches: [match] },
      );
      workspace(GOLD);
      run(1_700_000_000_000, 1_700_001_500_000);
      await settled();
      const res = getPatternPanelState().result!;
      expect(res.matches.map((m) => m.source?.epic)).toEqual(["GOLD", "US100"]);
      expect(res.scanned).toBe(150);
      expect(res.sources.map((s) => s.epic)).toEqual(["US100", "GOLD"]);
    });

    it("a failed sibling series does not kill the search", async () => {
      vi.spyOn(api, "searchPatterns").mockImplementation(async (req) => {
        if (req.epic === "GOLD") throw new Error("no stored history");
        return result(100);
      });
      workspace(GOLD);
      run(1_700_000_000_000, 1_700_001_500_000);
      await settled();
      expect(getPatternPanelState().error).toBeNull();
      const res = getPatternPanelState().result!;
      expect(res.sources.find((s) => s.epic === "GOLD")?.error).toBe("no stored history");
    });

    it("errors only when every series failed", async () => {
      vi.spyOn(api, "searchPatterns").mockRejectedValue(new Error("down"));
      workspace(GOLD);
      run(1_700_000_000_000, 1_700_001_500_000);
      await vi.waitFor(() => expect(getPatternPanelState().error).toBe("down"));
      expect(getPatternPanelState().result).toBeNull();
      expect(getPatternPanelState().loading).toBe(false);
    });

    it("cell scope searches only this chart, and flipping scope re-runs the last query", async () => {
      const spy = vi.spyOn(api, "searchPatterns").mockResolvedValue(result(1));
      workspace(GOLD);
      setPatternScope("cell");
      run(1_700_000_000_000, 1_700_001_500_000);
      await settled();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0].epic).toBe("US100");
      setPatternScope("all");
      await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(3));
      expect(getPatternPanelState().scope).toBe("all");
    });

    it("a one-chart workspace in all scope behaves like a plain search", async () => {
      const spy = vi.spyOn(api, "searchPatterns").mockResolvedValue(result(1));
      run(1_700_000_000_000, 1_700_001_500_000);
      await settled();
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  it("a new search from another chart clears the previous origin's bands", async () => {
    // The old origin's band-sync effect keys on its own series and the store
    // origin is no longer it, so nothing on the cell's side would ever clear
    // the band a superseded search left painted there.
    vi.spyOn(api, "searchPatterns").mockResolvedValue(result(1));
    const { registerPatternTarget } = await import("./patternTargets");
    const oldOrigin = {
      cellId: "cell-1", epic: "US100", resolution: "MINUTE_5", label: "5m",
      showMatch: () => {}, clearMatchBands: vi.fn(), clearSelectionBand: vi.fn(),
    };
    const next = {
      cellId: "cell-2", epic: "GOLD", resolution: "MINUTE_15", label: "15m",
      showMatch: () => {}, clearMatchBands: vi.fn(), clearSelectionBand: vi.fn(),
    };
    registerPatternTarget(oldOrigin);
    registerPatternTarget(next);
    run(1_700_000_000_000, 1_700_003_000_000);
    await settled();
    runPatternSearch({
      origin: { cellId: "cell-2", epic: "GOLD", resolution: "MINUTE_15", label: "15m" },
      broker: "capital", priceSide: "bid",
      bars,
      range: { fromMs: 1_700_000_000_000, toMs: 1_700_003_000_000 },
    });
    await settled();
    // The superseded origin's selection band goes; the new origin's own band
    // was just painted by the drag and must be left alone.
    expect(oldOrigin.clearSelectionBand).toHaveBeenCalled();
    expect(next.clearSelectionBand).not.toHaveBeenCalled();
    // Stale match bands from the previous result's row jumps go everywhere
    // but the dragging cell (whose gesture already cleared its own).
    expect(oldOrigin.clearMatchBands).toHaveBeenCalled();
  });

  it("a re-drag on the same series leaves the fresh band alone", async () => {
    vi.spyOn(api, "searchPatterns").mockResolvedValue(result(1));
    const { registerPatternTarget } = await import("./patternTargets");
    const origin = {
      cellId: "cell-1", epic: "US100", resolution: "MINUTE_5", label: "5m",
      showMatch: () => {}, clearMatchBands: vi.fn(), clearSelectionBand: vi.fn(),
    };
    registerPatternTarget(origin);
    run(1_700_000_000_000, 1_700_003_000_000);
    await settled();
    run(1_700_000_100_000, 1_700_003_100_000);
    await settled();
    expect(origin.clearSelectionBand).not.toHaveBeenCalled();
  });

  it("dismiss clears the result, the error, the range and the origin", async () => {
    vi.spyOn(api, "searchPatterns").mockResolvedValue(result(1));
    run(1_700_000_000_000, 1_700_003_000_000);
    await settled();
    dismissPatternPanel();
    const st = getPatternPanelState();
    expect(st.result).toBeNull();
    expect(st.range).toBeNull();
    expect(st.error).toBeNull();
    expect(st.truncatedTo).toBeNull();
    expect(st.origin).toBeNull();
  });
});
