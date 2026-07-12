import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Chart, KLineData } from "klinecharts";

// The indicator templates pulled in via customIndicators read klinecharts
// enums at module load; stub the runtime surface like the other tests do.
vi.mock("klinecharts", () => ({
  LineType: { Solid: "solid", Dashed: "dashed" },
  IndicatorSeries: { Normal: "normal", Price: "price" },
  registerIndicator: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));

// Controlled HTF fetch: each test swaps the implementation.
const fetchRangeStrict = vi.fn<(...args: unknown[]) => Promise<KLineData[]>>();
vi.mock("./feed", () => ({
  fetchRangeStrict: (...args: unknown[]) => fetchRangeStrict(...args),
  RESOLUTION_SECONDS: { MINUTE_5: 300, MINUTE_15: 900 },
}));

const { applyMaTimeframe } = await import("./mtfCoordinator");

const HTF_MS = 900_000;
const bar = (t: number): KLineData =>
  ({ timestamp: t, open: 1, high: 1, low: 1, close: 1, volume: 1 }) as KLineData;

// Enough 15m bars to cover any requested [fromSec, toSec] window, so the pager
// terminates after one page.
const htfPage = (fromSec: number, toSec: number): KLineData[] => {
  const out: KLineData[] = [];
  for (let t = fromSec * 1000; t <= toSec * 1000; t += HTF_MS) out.push(bar(t));
  return out;
};

interface Override {
  patch: { name: string; extendData?: { mtf?: Record<string, unknown> } };
  paneId: string;
}

function fakeChart(extendData: object = {}) {
  const overrides: Override[] = [];
  let indicator: { extendData: object } | null = { extendData };
  const chart = {
    getDataList: () => [bar(10_000_000_000), bar(10_000_300_000)],
    getIndicatorByPaneId: () => indicator,
    overrideIndicator: (patch: Override["patch"], paneId: string) => {
      overrides.push({ patch, paneId });
      if (indicator) indicator = { extendData: patch.extendData ?? {} };
    },
  } as unknown as Chart;
  return {
    chart,
    overrides,
    removeIndicator: () => (indicator = null),
    // Simulate delete + re-add: a fresh instance under the same name.
    replaceIndicator: (extendData: object) => (indicator = { extendData }),
  };
}

const applyEma = (chart: Chart, timeframe: string | null) =>
  applyMaTimeframe(chart, "EPIC", "ema1", "candle_pane", { kind: "ema", length: 2, options: {} }, timeframe);

beforeEach(() => {
  vi.useFakeTimers();
  fetchRangeStrict.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("applyMaTimeframe fetch-failure retry", () => {
  it("falls back to chart-timeframe rendering on failure, then retries and stashes the series", async () => {
    // Broker down (e.g. 503 while MT5 rebuilds a wedged connection).
    fetchRangeStrict.mockRejectedValue(new Error("candles fetch failed: 503"));
    const { chart, overrides } = fakeChart();
    await applyEma(chart, "MINUTE_15");

    // Not blank: the timeframe-only shape renders on the chart timeframe
    // (same as a persisted MTF indicator before its reload refetch).
    expect(overrides).toHaveLength(1);
    expect(overrides[0].patch.extendData?.mtf).toEqual({ timeframe: "MINUTE_15" });

    // Broker heals; the scheduled retry fetches and stashes the real series.
    fetchRangeStrict.mockImplementation((_e, _tf, fromSec, toSec) =>
      Promise.resolve(htfPage(fromSec as number, toSec as number)),
    );
    await vi.advanceTimersByTimeAsync(4_000);
    const last = overrides.at(-1)!.patch.extendData?.mtf as { htfSeries?: unknown[]; htfStarts?: number[] };
    expect(last.htfStarts?.length).toBeGreaterThan(0);
    expect(last.htfSeries?.length).toBe(last.htfStarts?.length);
  });

  it("keeps an already-stashed series for the same timeframe but still writes fresh config", async () => {
    fetchRangeStrict.mockRejectedValue(new Error("candles fetch failed: 503"));
    const mtf = { timeframe: "MINUTE_15", htfStarts: [1], htfSeries: [1], htfMs: HTF_MS };
    const { chart, overrides } = fakeChart({ mtf });
    await applyMaTimeframe(
      chart,
      "EPIC",
      "ema1",
      "candle_pane",
      { kind: "ema", length: 2, options: { source: "open" } },
      "MINUTE_15",
    );
    // Stale beats blank: the stashed series survives — but the merged
    // extendData (the user's config edit) must be written, not dropped.
    expect(overrides).toHaveLength(1);
    const ext = overrides[0].patch.extendData as { mtf?: unknown; source?: string };
    expect(ext.mtf).toEqual(mtf);
    expect(ext.source).toBe("open");
  });

  it("two charts with the same indicator name keep independent retry chains", async () => {
    fetchRangeStrict.mockRejectedValue(new Error("candles fetch failed: 503"));
    const a = fakeChart();
    const b = fakeChart();
    await applyEma(a.chart, "MINUTE_15");
    await applyEma(b.chart, "MINUTE_15");
    // Chart A goes back to the chart timeframe — that must not cancel B's retry.
    await applyEma(a.chart, null);
    const callsBefore = fetchRangeStrict.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchRangeStrict.mock.calls.length).toBeGreaterThan(callsBefore); // B retried
  });

  it("a retry never re-applies to a re-added indicator that no longer wants the timeframe", async () => {
    fetchRangeStrict.mockRejectedValue(new Error("candles fetch failed: 503"));
    const { chart, overrides, replaceIndicator } = fakeChart();
    await applyEma(chart, "MINUTE_15");
    // Delete + re-add: the fresh first instance re-mints the same name but has
    // no mtf set (chart timeframe). The stale retry must drop, not convert it.
    replaceIndicator({});
    const writes = overrides.length;
    const calls = fetchRangeStrict.mock.calls.length;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetchRangeStrict.mock.calls.length).toBe(calls);
    expect(overrides.length).toBe(writes);
  });

  it("a newer apply supersedes the pending retry", async () => {
    fetchRangeStrict.mockRejectedValue(new Error("candles fetch failed: 503"));
    const { chart } = fakeChart();
    await applyEma(chart, "MINUTE_15");
    const callsAfterFailure = fetchRangeStrict.mock.calls.length;

    await applyEma(chart, null); // user switches back to the chart timeframe
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetchRangeStrict.mock.calls.length).toBe(callsAfterFailure); // timer never fired
  });

  it("stops retrying once the indicator is gone", async () => {
    fetchRangeStrict.mockRejectedValue(new Error("candles fetch failed: 503"));
    const { chart, removeIndicator } = fakeChart();
    await applyEma(chart, "MINUTE_15");
    const callsAfterFailure = fetchRangeStrict.mock.calls.length;

    removeIndicator();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetchRangeStrict.mock.calls.length).toBe(callsAfterFailure);
  });
});
