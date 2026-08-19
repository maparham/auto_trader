import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Chart, KLineData } from "klinecharts";

// The indicator templates pulled in via customIndicators read klinecharts
// enums at module load; stub the runtime surface like the other tests do.
vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));

// Controlled HTF fetch: each test swaps the implementation.
const fetchRangeStrict = vi.fn<(...args: unknown[]) => Promise<KLineData[]>>();
const RES_SECONDS: Record<string, number> = { MINUTE_5: 300, MINUTE_15: 900, MONTH: 2_592_000 };
vi.mock("./feed", () => ({
  fetchRangeStrict: (...args: unknown[]) => fetchRangeStrict(...args),
  RESOLUTION_SECONDS: RES_SECONDS,
  // The real one, not a stub: the pinned slope path's whole correctness is that
  // it uses THIS number rather than measuring the fetched bars, so a stub would
  // make the assertion below vacuous.
  nominalBarHours: (res: string) => (RES_SECONDS[res] ? RES_SECONDS[res] / 3600 : null),
}));

const { applyMaTimeframe, applySlopeTimeframe } = await import("./mtfCoordinator");
const { slopeLineSeries } = await import("./indicators/slope");

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
  patch: { name: string; paneId?: string; extendData?: { mtf?: Record<string, unknown> } };
  paneId: string;
}

function fakeChart(extendData: object = {}) {
  const overrides: Override[] = [];
  let indicator: { extendData: object } | null = { extendData };
  const chart = {
    getDataList: () => [bar(10_000_000_000), bar(10_000_300_000)],
    // v10: getIndicators({ paneId, name }) returns a flat array; the migration
    // helper getIndicator picks [0]. The mock ignores the filter (one instance).
    getIndicators: () => (indicator ? [indicator] : []),
    overrideIndicator: (patch: Override["patch"]) => {
      // overrideExtend sends a CLEARING call first (every object-valued key set
      // to null), because klinecharts merges extendData index by index and a
      // shorter array would otherwise never shrink. Those calls carry no value
      // and are not what these assertions are about, so they are not recorded.
      const ext = (patch.extendData ?? {}) as Record<string, unknown>;
      const keys = Object.keys(ext);
      if (keys.length > 0 && keys.every((k) => ext[k] === null)) return;
      overrides.push({ patch, paneId: patch.paneId ?? "" });
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

describe("applySlopeTimeframe bar width", () => {
  // Monthly opens across a February: the SMALLEST gap is 28 days (672h), while
  // the resolution's NOMINAL width is 30 days (720h). The rule path has no bars
  // to measure and always computes the nominal number (evaluate.py's pinned
  // branch passes `_tf_hours(tf_res)`), so measuring here — which is what this
  // path used to do — makes the plotted line and the rule that reads it two
  // different series, silently, by ~7%.
  const MONTH_OPENS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((m) =>
    Date.UTC(2026, m, 1),
  );
  const monthBar = (t: number, i: number): KLineData =>
    ({ timestamp: t, open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i * 1.7, volume: 1000 }) as KLineData;
  const HTF = MONTH_OPENS.map(monthBar);

  const slopeCfg = {
    maType: "sma" as const,
    lengths: [3],
    slopeN: 1,
    // pctHr is the only unit bar width scales — pctBar/priceBar would pass
    // whatever number this path picked.
    units: "pctHr" as const,
    options: {},
  };

  function monthChart() {
    const overrides: Override[] = [];
    let indicator: { extendData: object } | null = { extendData: {} };
    const chart = {
      getDataList: () => [monthBar(MONTH_OPENS[0], 0), monthBar(MONTH_OPENS[11], 11)],
      getIndicators: () => (indicator ? [indicator] : []),
      overrideIndicator: (patch: Override["patch"]) => {
        overrides.push({ patch, paneId: patch.paneId ?? "" });
        if (indicator) indicator = { extendData: patch.extendData ?? {} };
      },
    } as unknown as Chart;
    return { chart, overrides };
  }

  it("computes the pinned slope at the timeframe's NOMINAL width, not the bars' smallest gap", async () => {
    let served = false;
    fetchRangeStrict.mockImplementation(() => {
      if (served) return Promise.resolve([]);
      served = true;
      return Promise.resolve(HTF);
    });
    const { chart, overrides } = monthChart();
    await applySlopeTimeframe(chart, "EPIC", "slope1", "pane1", slopeCfg, "MONTH");

    const mtf = overrides.at(-1)!.patch.extendData?.mtf as {
      htfSeriesByLine?: Array<Array<number | undefined>>;
      htfStarts?: number[];
    };
    expect(mtf.htfStarts).toEqual(MONTH_OPENS);

    const nominal = slopeLineSeries(HTF, "sma", 3, 1, "pctHr", undefined, undefined, 720);
    const inferred = slopeLineSeries(HTF, "sma", 3, 1, "pctHr", undefined, undefined, 672);
    expect(mtf.htfSeriesByLine![0]).toEqual(nominal);

    // And the two really are different, so the assertion above isn't passing by
    // coincidence — 720/672 - 1, about 7%.
    const pairs = nominal
      .map((v, i) => [v, inferred[i]] as const)
      .filter(([a, b]) => a != null && b != null);
    expect(pairs.length).toBeGreaterThan(5);
    for (const [a, b] of pairs) expect(b! / a!).toBeCloseTo(720 / 672, 9);
  });
});
