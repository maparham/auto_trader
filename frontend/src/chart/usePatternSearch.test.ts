// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { usePatternSearch } from "./usePatternSearch";
import * as api from "../lib/patternSearch";

// 80 bars, so a drag can exceed the 64-bar cap the backend enforces.
const bars = Array.from({ length: 80 }, (_, i) => ({
  ts: 1_700_000_000 + i * 300, o: 10 + i, h: 11 + i, l: 9 + i, c: 10.5 + i,
}));

const result = (scanned: number): api.PatternSearchResult => ({
  matches: [], scanned, series: { oldestTs: 1, newestTs: 2, bars: 80 },
  elapsedMs: 3, cold: false,
});

const args = {
  epic: "US100", broker: "capital", priceSide: "bid", resolution: "MINUTE_5",
  getBars: () => bars,
};

beforeEach(() => vi.restoreAllMocks());

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

  it("caps the query at 64 candles, keeping the most recent ones", async () => {
    const spy = vi.spyOn(api, "searchPatterns").mockResolvedValue(result(1));
    const { result: hook } = renderHook(() => usePatternSearch(args));
    // The whole 80-bar fixture. The backend's schema rejects more than 64, so
    // an uncapped request is a 422 rather than a slow search.
    act(() => hook.current.run(1_700_000_000_000, 1_700_000_000_000 + 79 * 300_000));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const sent = spy.mock.calls[0][0];
    expect(sent.query).toHaveLength(64);
    // The NEWEST 64, not the oldest: slice(-MAX_BARS), not slice(0, MAX_BARS).
    expect(sent.query[63].ts).toBe(bars[79].ts);
    expect(sent.queryFromTs).toBe(bars[16].ts);
  });

  it("reports the cap when the drag covered more candles than were searched", async () => {
    // The band stays painted over the whole drag, so without this the panel
    // shows one window and the results describe another.
    vi.spyOn(api, "searchPatterns").mockResolvedValue(result(1));
    const { result: hook } = renderHook(() => usePatternSearch(args));
    act(() => hook.current.run(1_700_000_000_000, 1_700_000_000_000 + 79 * 300_000));
    expect(hook.current.truncatedTo).toBe(64);
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

  it("defaults to whole candles and a 20-bar aftermath", async () => {
    const spy = vi.spyOn(api, "searchPatterns").mockResolvedValue(result(1));
    const { result: hook } = renderHook(() => usePatternSearch(args));
    expect(hook.current.mode).toBe("ohlc");
    expect(hook.current.forwardBars).toBe(20);
    act(() => hook.current.run(1_700_000_000_000, 1_700_003_000_000));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0][0].mode).toBe("ohlc");
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
    // a stale closure would re-search on "ohlc" and still look like a re-run.
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
