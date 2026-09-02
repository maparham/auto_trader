// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { usePatternSearch, clearParkedPatternSearches } from "./usePatternSearch";
import * as api from "../lib/patternSearch";
import { clearPatternTargets } from "../lib/patternTargets";

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
// NOT assumed — the hook finds itself by cellId.
const SELF = { cellId: "cell-1", tabId: "tab-1", epic: "US100", resolution: "MINUTE_5", label: "5m" };
const GOLD = { cellId: "cell-2", tabId: "tab-2", epic: "GOLD", resolution: "MINUTE_15", label: "15m" };

const args = {
  cellId: "cell-1",
  epic: "US100", broker: "capital", priceSide: "bid", resolution: "MINUTE_5",
  getBars: () => bars,
  getSeries: () => [SELF],
};

beforeEach(() => {
  vi.restoreAllMocks();
  // The park cache and the target registry are module-level on purpose, so
  // tests must clear them or one test's state leaks into the next.
  clearParkedPatternSearches();
  clearPatternTargets();
});

describe("usePatternSearch", () => {
  it("sends only the bars inside the picked range", async () => {
    const spy = vi.spyOn(api, "searchPatterns").mockResolvedValue(result(1));
    const { result: hook } = renderHook(() => usePatternSearch(args));
    act(() => hook.current.run(1_700_000_000_000, 1_700_001_500_000));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0][0].query).toHaveLength(6);
    expect(spy.mock.calls[0][0].queryFromTs).toBe(1_700_000_000);
  });

  it("exposes the range it searched so the band can stay painted", async () => {
    vi.spyOn(api, "searchPatterns").mockResolvedValue(result(1));
    const { result: hook } = renderHook(() => usePatternSearch(args));
    act(() => hook.current.run(1_700_000_000_000, 1_700_001_500_000));
    await waitFor(() => expect(hook.current.range).not.toBeNull());
    expect(hook.current.range).toEqual({ fromMs: 1_700_000_000_000, toMs: 1_700_001_500_000 });
  });

  it("refuses a range covering fewer than three candles without calling the server", async () => {
    const spy = vi.spyOn(api, "searchPatterns").mockResolvedValue(result(1));
    const { result: hook } = renderHook(() => usePatternSearch(args));
    act(() => hook.current.run(1_700_000_000_000, 1_700_000_200_000));
    // Both assertions synchronous, and the server one FIRST. Behind a waitFor on
    // the error, removing the guard makes the waitFor time out and this line
    // never runs, so the "without calling the server" half proves nothing.
    expect(spy).not.toHaveBeenCalled();
    expect(hook.current.error).toMatch(/at least 3 candles/);
    expect(hook.current.loading).toBe(false);
  });

  it("caps the query at 1024 candles, keeping the most recent ones", async () => {
    const spy = vi.spyOn(api, "searchPatterns").mockResolvedValue(result(1));
    const long = mkBars(1100);
    const { result: hook } = renderHook(() =>
      usePatternSearch({ ...args, getBars: () => long }),
    );
    // The whole 1100-bar drag. The backend's schema rejects more than 1024, so
    // an uncapped request is a 422 rather than a slow search.
    act(() => hook.current.run(1_700_000_000_000, 1_700_000_000_000 + 1099 * 300_000));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const sent = spy.mock.calls[0][0];
    expect(sent.query).toHaveLength(1024);
    // The NEWEST 1024, not the oldest: slice(-MAX_BARS), not slice(0, MAX_BARS).
    expect(sent.query[1023].ts).toBe(long[1099].ts);
    expect(sent.queryFromTs).toBe(long[76].ts);
  });

  it("reports the cap when the drag covered more candles than were searched", async () => {
    // The band stays painted over the whole drag, so without this the panel
    // shows one window and the results describe another.
    vi.spyOn(api, "searchPatterns").mockResolvedValue(result(1));
    const long = mkBars(1100);
    const { result: hook } = renderHook(() =>
      usePatternSearch({ ...args, getBars: () => long }),
    );
    act(() => hook.current.run(1_700_000_000_000, 1_700_000_000_000 + 1099 * 300_000));
    expect(hook.current.truncatedTo).toBe(1024);
  });

  it("reports no truncation for a selection inside the cap", async () => {
    vi.spyOn(api, "searchPatterns").mockResolvedValue(result(1));
    const { result: hook } = renderHook(() => usePatternSearch(args));
    act(() => hook.current.run(1_700_000_000_000, 1_700_000_000_000 + 40 * 300_000));
    expect(hook.current.truncatedTo).toBeNull();
  });

  it("a too-short drag supersedes a search still in flight", async () => {
    // Without the request-id bump in the guard, the earlier valid search
    // resolves and replaces this error with results for the previous range.
    let resolveFirst: (r: api.PatternSearchResult) => void = () => {};
    vi.spyOn(api, "searchPatterns").mockImplementationOnce(
      () => new Promise((r) => { resolveFirst = r; }),
    );
    const { result: hook } = renderHook(() => usePatternSearch(args));
    act(() => hook.current.run(1_700_000_000_000, 1_700_003_000_000));
    act(() => hook.current.run(1_700_000_000_000, 1_700_000_200_000));
    expect(hook.current.error).toMatch(/at least 3 candles/);
    act(() => resolveFirst(result(999)));
    await new Promise((r) => setTimeout(r, 0));
    expect(hook.current.result).toBeNull();
    expect(hook.current.error).toMatch(/at least 3 candles/);
    expect(hook.current.loading).toBe(false);
  });

  it("keeps the latest result when responses arrive out of order", async () => {
    let resolveFirst: (r: api.PatternSearchResult) => void = () => {};
    const spy = vi.spyOn(api, "searchPatterns")
      .mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }))
      .mockResolvedValueOnce(result(222));
    const { result: hook } = renderHook(() => usePatternSearch(args));
    act(() => hook.current.run(1_700_000_000_000, 1_700_003_000_000));
    act(() => hook.current.run(1_700_000_000_000, 1_700_004_000_000));
    await waitFor(() => expect(hook.current.result?.scanned).toBe(222));
    act(() => resolveFirst(result(111)));
    await new Promise((r) => setTimeout(r, 0));
    expect(hook.current.result?.scanned).toBe(222);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("surfaces the server's message", async () => {
    vi.spyOn(api, "searchPatterns").mockRejectedValue(new Error("no stored history"));
    const { result: hook } = renderHook(() => usePatternSearch(args));
    act(() => hook.current.run(1_700_000_000_000, 1_700_003_000_000));
    await waitFor(() => expect(hook.current.error).toBe("no stored history"));
    expect(hook.current.loading).toBe(false);
  });

  it("defaults to shape matching and a 20-bar aftermath", async () => {
    const spy = vi.spyOn(api, "searchPatterns").mockResolvedValue(result(1));
    const { result: hook } = renderHook(() => usePatternSearch(args));
    expect(hook.current.mode).toBe("shape");
    expect(hook.current.forwardBars).toBe(20);
    act(() => hook.current.run(1_700_000_000_000, 1_700_003_000_000));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0][0].mode).toBe("shape");
    expect(spy.mock.calls[0][0].forwardBars).toBe(20);
  });

  it("re-runs the last range on the new metric, so the change is visible at once", async () => {
    const spy = vi.spyOn(api, "searchPatterns").mockResolvedValue(result(1));
    const { result: hook } = renderHook(() => usePatternSearch(args));
    act(() => hook.current.run(1_700_000_000_000, 1_700_003_000_000));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    act(() => hook.current.setMode("close"));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    // The NEW mode, not the one from before the change: `run` reading it out of
    // a stale closure would re-search on "shape" and still look like a re-run.
    expect(spy.mock.calls[1][0].mode).toBe("close");
    expect(spy.mock.calls[1][0].queryFromTs).toBe(spy.mock.calls[0][0].queryFromTs);
    expect(hook.current.mode).toBe("close");
  });

  it("re-runs the last range on the new horizon", async () => {
    const spy = vi.spyOn(api, "searchPatterns").mockResolvedValue(result(1));
    const { result: hook } = renderHook(() => usePatternSearch(args));
    act(() => hook.current.run(1_700_000_000_000, 1_700_003_000_000));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    act(() => hook.current.setForwardBars(50));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(spy.mock.calls[1][0].forwardBars).toBe(50);
    expect(hook.current.forwardBars).toBe(50);
  });

  it("changing a control before any range is picked searches nothing", async () => {
    const spy = vi.spyOn(api, "searchPatterns").mockResolvedValue(result(1));
    const { result: hook } = renderHook(() => usePatternSearch(args));
    act(() => hook.current.setMode("close"));
    act(() => hook.current.setForwardBars(50));
    expect(spy).not.toHaveBeenCalled();
    expect(hook.current.mode).toBe("close");
    expect(hook.current.forwardBars).toBe(50);
  });

  it("keeps the controls after a dismiss: they are how you search, not a result", async () => {
    vi.spyOn(api, "searchPatterns").mockResolvedValue(result(1));
    const { result: hook } = renderHook(() => usePatternSearch(args));
    act(() => hook.current.run(1_700_000_000_000, 1_700_003_000_000));
    await waitFor(() => expect(hook.current.result).not.toBeNull());
    act(() => hook.current.setMode("close"));
    await waitFor(() => expect(hook.current.mode).toBe("close"));
    act(() => hook.current.dismiss());
    expect(hook.current.mode).toBe("close");
    expect(hook.current.forwardBars).toBe(20);
  });

  it("a control change after a dismiss searches nothing: the range went with it", async () => {
    const spy = vi.spyOn(api, "searchPatterns").mockResolvedValue(result(1));
    const { result: hook } = renderHook(() => usePatternSearch(args));
    act(() => hook.current.run(1_700_000_000_000, 1_700_003_000_000));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    act(() => hook.current.dismiss());
    act(() => hook.current.setMode("close"));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  // The park/adopt pair is ChartCore's series-change protocol: the reset
  // effect's cleanup parks the live search under the series it belongs to,
  // and the next effect run adopts the new series, restoring anything parked
  // for it. Found matches must survive a tab switch; only the panel's own
  // close (dismiss) may destroy them.
  describe("parking across series switches", () => {
    const run = async (hook: { current: ReturnType<typeof usePatternSearch> }) => {
      act(() => hook.current.run(1_700_000_000_000, 1_700_003_000_000));
      await waitFor(() => expect(hook.current.result).not.toBeNull());
    };

    it("restores a parked result, its range and truncation on return to the series", async () => {
      vi.spyOn(api, "searchPatterns").mockResolvedValue(result(7));
      const { result: hook, rerender } = renderHook((a) => usePatternSearch(a), {
        initialProps: args,
      });
      act(() => hook.current.adoptSeries(true));
      await run(hook);
      act(() => hook.current.parkLive());
      rerender({ ...args, epic: "GOLD" });
      act(() => expect(hook.current.adoptSeries(true)).toBeNull());
      expect(hook.current.result).toBeNull();
      act(() => hook.current.parkLive());
      rerender(args);
      let restored: { fromMs: number; toMs: number } | null = null;
      act(() => { restored = hook.current.adoptSeries(true); });
      // The band range comes back so the caller can repaint the selection.
      expect(restored).toEqual({ fromMs: 1_700_000_000_000, toMs: 1_700_003_000_000 });
      expect(hook.current.result?.scanned).toBe(7);
      expect(hook.current.range).toEqual({ fromMs: 1_700_000_000_000, toMs: 1_700_003_000_000 });
    });

    it("restores the controls the parked search was run with", async () => {
      const spy = vi.spyOn(api, "searchPatterns").mockResolvedValue(result(1));
      const { result: hook, rerender } = renderHook((a) => usePatternSearch(a), {
        initialProps: args,
      });
      act(() => hook.current.adoptSeries(true));
      await run(hook);
      act(() => hook.current.setMode("close"));
      act(() => hook.current.setForwardBars(50));
      await waitFor(() => expect(spy).toHaveBeenCalledTimes(3));
      act(() => hook.current.parkLive());
      rerender({ ...args, epic: "GOLD" });
      act(() => hook.current.adoptSeries(true));
      act(() => hook.current.parkLive());
      rerender(args);
      act(() => hook.current.adoptSeries(true));
      // The result shown was computed with these; showing it under the
      // defaults would caption close/50 numbers as shape/20.
      expect(hook.current.mode).toBe("close");
      expect(hook.current.forwardBars).toBe(50);
    });

    it("dismiss forgets the series for good: nothing to restore on return", async () => {
      vi.spyOn(api, "searchPatterns").mockResolvedValue(result(1));
      const { result: hook, rerender } = renderHook((a) => usePatternSearch(a), {
        initialProps: args,
      });
      act(() => hook.current.adoptSeries(true));
      await run(hook);
      act(() => hook.current.parkLive());
      rerender({ ...args, epic: "GOLD" });
      act(() => hook.current.adoptSeries(true));
      act(() => hook.current.parkLive());
      rerender(args);
      act(() => hook.current.adoptSeries(true));
      expect(hook.current.result).not.toBeNull();
      act(() => hook.current.dismiss());
      act(() => hook.current.parkLive());
      rerender({ ...args, epic: "GOLD" });
      act(() => hook.current.adoptSeries(true));
      act(() => hook.current.parkLive());
      rerender(args);
      act(() => expect(hook.current.adoptSeries(true)).toBeNull());
      expect(hook.current.result).toBeNull();
    });

    it("a search still in flight when the series changes cannot write into the new one", async () => {
      let resolveFirst: (r: api.PatternSearchResult) => void = () => {};
      vi.spyOn(api, "searchPatterns").mockImplementationOnce(
        () => new Promise((r) => { resolveFirst = r; }),
      );
      const { result: hook, rerender } = renderHook((a) => usePatternSearch(a), {
        initialProps: args,
      });
      act(() => hook.current.adoptSeries(true));
      act(() => hook.current.run(1_700_000_000_000, 1_700_003_000_000));
      act(() => hook.current.parkLive());
      rerender({ ...args, epic: "GOLD" });
      act(() => hook.current.adoptSeries(true));
      act(() => resolveFirst(result(111)));
      await new Promise((r) => setTimeout(r, 0));
      // GOLD must not show US100's late-arriving matches.
      expect(hook.current.result).toBeNull();
      expect(hook.current.loading).toBe(false);
    });

    it("an unavailable cell restores nothing but keeps the parked search", async () => {
      vi.spyOn(api, "searchPatterns").mockResolvedValue(result(1));
      const { result: hook } = renderHook(() => usePatternSearch(args));
      act(() => hook.current.adoptSeries(true));
      await run(hook);
      // Entering replay gates the cell: the panel goes down, the data does not.
      act(() => hook.current.parkLive());
      act(() => expect(hook.current.adoptSeries(false)).toBeNull());
      expect(hook.current.result).toBeNull();
      act(() => hook.current.parkLive());
      let restored: { fromMs: number; toMs: number } | null = null;
      act(() => { restored = hook.current.adoptSeries(true); });
      expect(restored).not.toBeNull();
      expect(hook.current.result).not.toBeNull();
    });
  });

  describe("all scope: searching every chart in every tab", () => {
    const workspace = (...extra: (typeof SELF)[]) => ({
      ...args,
      getSeries: () => [SELF, ...extra],
    });

    it("defaults to all-charts scope", () => {
      const { result: hook } = renderHook(() => usePatternSearch(args));
      expect(hook.current.scope).toBe("all");
    });

    it("fans out one search per workspace chart, same query bars, each chart's own series", async () => {
      const spy = vi.spyOn(api, "searchPatterns").mockResolvedValue(result(1));
      const { result: hook } = renderHook(() => usePatternSearch(workspace(GOLD)));
      act(() => hook.current.run(1_700_000_000_000, 1_700_001_500_000));
      await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
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
      const dupe = { ...SELF, cellId: "cell-3", tabId: "tab-3" };
      const { result: hook } = renderHook(() => usePatternSearch(workspace(dupe)));
      act(() => hook.current.run(1_700_000_000_000, 1_700_001_500_000));
      await waitFor(() => expect(hook.current.result).not.toBeNull());
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
      const many = Array.from({ length: 9 }, (_, i) => ({
        cellId: `c${i}`, tabId: `t${i}`, epic: `EPIC${i}`, resolution: "HOUR", label: "1H",
      }));
      const { result: hook } = renderHook(() => usePatternSearch(workspace(...many)));
      act(() => hook.current.run(1_700_000_000_000, 1_700_001_500_000));
      await waitFor(() => expect(hook.current.result).not.toBeNull());
      expect(hook.current.result!.sources).toHaveLength(10);
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
      const { result: hook } = renderHook(() => usePatternSearch(workspace(GOLD)));
      act(() => hook.current.run(1_700_000_000_000, 1_700_001_500_000));
      await waitFor(() => expect(hook.current.result).not.toBeNull());
      const res = hook.current.result!;
      expect(res.matches.map((m) => m.source?.epic)).toEqual(["GOLD", "US100"]);
      expect(res.scanned).toBe(150);
      expect("sources" in res && res.sources.map((s) => s.epic)).toEqual(["US100", "GOLD"]);
    });

    it("a failed sibling series does not kill the search", async () => {
      vi.spyOn(api, "searchPatterns").mockImplementation(async (req) => {
        if (req.epic === "GOLD") throw new Error("no stored history");
        return result(100);
      });
      const { result: hook } = renderHook(() => usePatternSearch(workspace(GOLD)));
      act(() => hook.current.run(1_700_000_000_000, 1_700_001_500_000));
      await waitFor(() => expect(hook.current.result).not.toBeNull());
      expect(hook.current.error).toBeNull();
      const res = hook.current.result!;
      expect("sources" in res && res.sources.find((s) => s.epic === "GOLD")?.error).toBe(
        "no stored history",
      );
    });

    it("errors only when every series failed", async () => {
      vi.spyOn(api, "searchPatterns").mockRejectedValue(new Error("down"));
      const { result: hook } = renderHook(() => usePatternSearch(workspace(GOLD)));
      act(() => hook.current.run(1_700_000_000_000, 1_700_001_500_000));
      await waitFor(() => expect(hook.current.error).toBe("down"));
      expect(hook.current.result).toBeNull();
      expect(hook.current.loading).toBe(false);
    });

    it("cell scope searches only this chart, and flipping scope re-runs the last range", async () => {
      const spy = vi.spyOn(api, "searchPatterns").mockResolvedValue(result(1));
      const { result: hook } = renderHook(() => usePatternSearch(workspace(GOLD)));
      act(() => hook.current.setScope("cell"));
      act(() => hook.current.run(1_700_000_000_000, 1_700_001_500_000));
      await waitFor(() => expect(hook.current.result).not.toBeNull());
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0].epic).toBe("US100");
      act(() => hook.current.setScope("all"));
      await waitFor(() => expect(spy).toHaveBeenCalledTimes(3));
      expect(hook.current.scope).toBe("all");
    });

    it("a one-chart workspace in all scope behaves like a plain search", async () => {
      const spy = vi.spyOn(api, "searchPatterns").mockResolvedValue(result(1));
      const { result: hook } = renderHook(() => usePatternSearch(args));
      act(() => hook.current.run(1_700_000_000_000, 1_700_001_500_000));
      await waitFor(() => expect(hook.current.result).not.toBeNull());
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("parks and restores the scope with the result", async () => {
      vi.spyOn(api, "searchPatterns").mockResolvedValue(result(1));
      const { result: hook, rerender } = renderHook((a) => usePatternSearch(a), {
        initialProps: workspace(GOLD),
      });
      act(() => hook.current.adoptSeries(true));
      act(() => hook.current.setScope("cell"));
      act(() => hook.current.run(1_700_000_000_000, 1_700_003_000_000));
      await waitFor(() => expect(hook.current.result).not.toBeNull());
      act(() => hook.current.parkLive());
      rerender({ ...workspace(GOLD), epic: "SILVER" });
      act(() => hook.current.adoptSeries(true));
      act(() => hook.current.setScope("all"));
      act(() => hook.current.parkLive());
      rerender(workspace(GOLD));
      act(() => hook.current.adoptSeries(true));
      // The restored result was computed under cell scope; showing it captioned
      // as a layout-wide search would misread it.
      expect(hook.current.scope).toBe("cell");
    });
  });

  it("dismiss clears the result, the error and the range", async () => {
    vi.spyOn(api, "searchPatterns").mockResolvedValue(result(1));
    const { result: hook } = renderHook(() => usePatternSearch(args));
    act(() => hook.current.run(1_700_000_000_000, 1_700_003_000_000));
    await waitFor(() => expect(hook.current.result).not.toBeNull());
    act(() => hook.current.dismiss());
    expect(hook.current.result).toBeNull();
    expect(hook.current.range).toBeNull();
    expect(hook.current.error).toBeNull();
    expect(hook.current.truncatedTo).toBeNull();
  });
});
