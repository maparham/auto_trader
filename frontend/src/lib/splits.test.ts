import { afterEach, describe, expect, it, vi } from "vitest";
import { _resetSplitsCache, fetchSplits, splitBarIndex, splitDateText, splitLabel } from "./splits";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// BKNG's 25:1 split, stamped by Yahoo at 09:30 New York on 2026-04-06.
const SPLIT_MS = 1775482200_000;
const APR2 = 1775088000_000;
const APR6 = 1775433600_000;
const APR7 = 1775520000_000;
const bars = (ts: number[]) => ts.map((timestamp) => ({ timestamp }));

describe("splitLabel", () => {
  it("reads forward, reverse and fractional ratios", () => {
    expect(splitLabel(25)).toBe("25:1");
    expect(splitLabel(2)).toBe("2:1");
    expect(splitLabel(1 / 6)).toBe("1:6");
    expect(splitLabel(0.1)).toBe("1:10");
    expect(splitLabel(1.5)).toBe("3:2");
  });
});

describe("splitDateText", () => {
  it("formats the UTC date without a time", () => {
    expect(splitDateText(SPLIT_MS)).toBe("6 Apr 2026");
  });
});

describe("splitBarIndex", () => {
  const days = bars([APR2, APR6, APR7]);

  it("lands on the bar whose span holds the split", () => {
    expect(splitBarIndex(days, SPLIT_MS, DAY)).toBe(1);
  });

  it("uses the next bar when the split falls in a gap between bars", () => {
    // Hourly bars 00:00 and 20:00: a 13:30 split sits in the gap.
    expect(splitBarIndex(bars([APR6, APR6 + 20 * HOUR]), SPLIT_MS, HOUR)).toBe(1);
  });

  it("is -1 outside the loaded bars", () => {
    expect(splitBarIndex(days, APR2 - 10 * DAY, DAY)).toBe(-1);
    expect(splitBarIndex(days, APR7 + 3 * DAY, DAY)).toBe(-1);
    expect(splitBarIndex([], SPLIT_MS, DAY)).toBe(-1);
  });
});

describe("fetchSplits", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    _resetSplitsCache();
  });

  it("maps the payload to ms and memoizes per broker and epic", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL) =>
      new Response(JSON.stringify({ epic: "BKNG", splits: [{ time: 1775482200, ratio: 25 }] })),
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchSplits("BKNG", "capital")).toEqual([{ timeMs: SPLIT_MS, ratio: 25 }]);
    await fetchSplits("BKNG", "capital");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/market/BKNG/splits?broker=capital");
  });

  it("answers [] on failure and does not cache it", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchSplits("BKNG", "capital")).toEqual([]);
    await fetchSplits("BKNG", "capital");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("projectSplitMarkers", () => {
  const ts = bars([APR2, APR6, APR7]);
  const toX = (t: number) => (t - APR2) / DAY * 10; // 10px per day

  it("projects visible splits onto their bar and labels them", async () => {
    const { projectSplitMarkers } = await import("./splits");
    const out = projectSplitMarkers([{ timeMs: SPLIT_MS, ratio: 25 }], ts, DAY, { from: 0, to: 2 }, toX, 100);
    expect(out).toEqual([
      { key: `split:${SPLIT_MS}`, x: 40, label: "25:1", date: "6 Apr 2026" },
    ]);
  });

  it("culls splits outside the visible range or off the pane", async () => {
    const { projectSplitMarkers } = await import("./splits");
    const s = [{ timeMs: SPLIT_MS, ratio: 25 }];
    expect(projectSplitMarkers(s, ts, DAY, { from: 2, to: 2 }, toX, 100)).toEqual([]);
    expect(projectSplitMarkers(s, ts, DAY, { from: 0, to: 2 }, toX, 30)).toEqual([]);
    expect(projectSplitMarkers([], ts, DAY, { from: 0, to: 2 }, toX, 100)).toEqual([]);
  });
});

describe("maxBarMs", () => {
  it("is the timeframe span, stretched to the longest calendar month or year", async () => {
    const { maxBarMs } = await import("./splits");
    expect(maxBarMs("HOUR")).toBe(HOUR);
    expect(maxBarMs("DAY")).toBe(DAY);
    expect(maxBarMs("MONTH")).toBe(31 * DAY);
    expect(maxBarMs("YEAR")).toBeGreaterThanOrEqual(366 * DAY);
  });
});
