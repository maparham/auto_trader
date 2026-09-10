import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { clearHtfCache } from "./htfBarCache";
import type { Chart, KLineData } from "klinecharts";

// The indicator templates pulled in via customIndicators read klinecharts
// enums at module load; stub the runtime surface like the other tests do.
vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));

// The pane's price side, which fetchHtfBars reads from the saved settings (the
// imperative-reader idiom App documents). Node has no localStorage here, so the
// setting is mocked at its reader rather than written to storage.
const side = vi.hoisted(() => ({ value: "mid" }));
vi.mock("../theme", async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    loadSettings: () => ({
      ...(real.loadSettings as () => object)(),
      priceSide: side.value,
    }),
  };
});

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

const { applyMaTimeframe, applySlopeTimeframe, applyTrendlinesTimeframe, refreshMtfIndicators, setChartIntervalMs } =
  await import("./mtfCoordinator");
const { TRENDLINES_DEFAULTS, MAX_PAIR_PIVOTS } = await import("./indicators/trendlinesOutputs");
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
  patch: {
    name: string;
    paneId?: string;
    extendData?: { mtf?: Record<string, unknown> };
    calcParams?: number[];
  };
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
  // HTF bars are now fetched once per (epic, timeframe, side, edge) and shared
  // (see htfBarCache). That cache lives at module scope and ages out by wall
  // clock, which fake timers freeze -- so without this a walk from an earlier
  // test would still be "fresh" here and satisfy this one's fetch.
  clearHtfCache();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("declared chart interval stamp", () => {
  it("stamps the registered chartMs into the stash; unregistered charts stash none", async () => {
    fetchRangeStrict.mockImplementation((_e, _tf, fromSec, toSec) =>
      Promise.resolve(htfPage(fromSec as number, toSec as number)),
    );
    // Registered: alignHtfToChart's same-TF test reads this instead of
    // inferring the interval from candle gaps (which anomalous data defeats).
    const a = fakeChart();
    setChartIntervalMs(a.chart, 300_000);
    await applyEma(a.chart, "MINUTE_15");
    expect((a.overrides.at(-1)!.patch.extendData?.mtf as { chartMs?: number }).chartMs).toBe(300_000);
    // Unregistered (or cleared): the stash omits it and inference stands in.
    const b = fakeChart();
    setChartIntervalMs(b.chart, 300_000);
    setChartIntervalMs(b.chart, null);
    await applyEma(b.chart, "MINUTE_15");
    expect((b.overrides.at(-1)!.patch.extendData?.mtf as { chartMs?: number }).chartMs).toBeUndefined();
  });
});

describe("applyMaTimeframe smoothing", () => {
  it("stashes the HTF smoothing series alongside the base", async () => {
    fetchRangeStrict.mockImplementation((_e, _tf, fromSec, toSec) =>
      Promise.resolve(htfPage(fromSec as number, toSec as number)),
    );
    const { chart, overrides } = fakeChart();
    await applyMaTimeframe(chart, "EPIC", "ema1", "candle_pane",
      { kind: "ema", length: 2, options: { smoothing: { type: "sma", length: 3 } } },
      "MINUTE_15");
    const mtf = overrides.at(-1)!.patch.extendData?.mtf as {
      htfStarts?: number[];
      htfSmoothing?: Array<number | undefined>;
    };
    expect(mtf.htfSmoothing?.length).toBe(mtf.htfStarts?.length);
    expect(mtf.htfSmoothing?.some((v) => typeof v === "number")).toBe(true);
  });

  it("stashes no smoothing series when smoothing is off", async () => {
    fetchRangeStrict.mockImplementation((_e, _tf, fromSec, toSec) =>
      Promise.resolve(htfPage(fromSec as number, toSec as number)),
    );
    const { chart, overrides } = fakeChart();
    await applyEma(chart, "MINUTE_15");
    const mtf = overrides.at(-1)!.patch.extendData?.mtf as { htfSmoothing?: unknown };
    expect(mtf.htfSmoothing).toBeUndefined();
  });

  it("reaches back further by the smoothing window so the left edge is populated", async () => {
    fetchRangeStrict.mockImplementation((_e, _tf, fromSec, toSec) =>
      Promise.resolve(htfPage(fromSec as number, toSec as number)),
    );
    const from = async (smoothLen: number | null): Promise<number> => {
      fetchRangeStrict.mockClear();
      // Each measurement needs its OWN walk to read the reach-back off (the
      // shared cache would serve the shallower config from the deeper one).
      clearHtfCache();
      await applyMaTimeframe(
        fakeChart().chart, "EPIC", "ema1", "candle_pane",
        {
          kind: "ema", length: 2,
          options: smoothLen ? { smoothing: { type: "sma", length: smoothLen } } : {},
        },
        "MINUTE_15",
      );
      return fetchRangeStrict.mock.calls[0][2] as number;
    };
    expect(await from(50)).toBeLessThan(await from(null));
  });
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

describe("applyTrendlinesTimeframe", () => {
  const apply = (chart: Chart, timeframe: string | null) =>
    applyTrendlinesTimeframe(
      chart, "EPIC", "tl1", "candle_pane", { ...TRENDLINES_DEFAULTS }, timeframe,
    );

  it("clears the stash and writes the params when the pin is released", async () => {
    const { chart, overrides } = fakeChart({ mtf: { timeframe: "MINUTE_15", htfStarts: [1] } });
    await apply(chart, null);
    expect(overrides[0].patch.extendData?.mtf).toEqual({ timeframe: null });
    expect(fetchRangeStrict).not.toHaveBeenCalled();
  });

  // EVERY param reaches the pane, not just the ones someone remembered. This
  // builder lists the config fields BY HAND, so a param added to
  // TrendlinesConfig and forgotten here reads undefined at its slot, parses to
  // its default, and the pinned pane silently detects on a setting the user
  // never chose. Length plus the tail value catches both a missed field and one
  // appended in the wrong order.
  it("writes every calcParam slot, so a new param cannot be dropped", async () => {
    const { chart, overrides } = fakeChart({ mtf: { timeframe: "MINUTE_15", htfStarts: [1] } });
    await applyTrendlinesTimeframe(
      chart, "EPIC", "tl1", "candle_pane",
      { ...TRENDLINES_DEFAULTS, maxTouchSpacing: 30, minTouchSpacing: 4 }, null,
    );
    const params = overrides[0].patch.calcParams ?? [];
    expect(params).toHaveLength(Object.keys(TRENDLINES_DEFAULTS).length);
    expect(params).toEqual(
      Object.values({ ...TRENDLINES_DEFAULTS, maxTouchSpacing: 30, minTouchSpacing: 4 }),
    );
  });

  it("stashes the HTF series and lines, from CLOSED bars only", async () => {
    fetchRangeStrict.mockImplementation((_e, _tf, fromSec, toSec) =>
      Promise.resolve(htfPage(fromSec as number, toSec as number)),
    );
    const { chart, overrides } = fakeChart();
    await apply(chart, "MINUTE_15");
    const mtf = overrides.at(-1)!.patch.extendData?.mtf as {
      timeframe: string;
      htfStarts: number[];
      htfMs: number;
      htfResistance: unknown[];
      htfBrokenSupport: unknown[];
      htfLines: unknown[];
    };
    expect(mtf.timeframe).toBe("MINUTE_15");
    expect(mtf.htfMs).toBe(HTF_MS);
    expect(mtf.htfStarts.length).toBeGreaterThan(0);
    // One value per HTF bar, on every one of the four operand series: calc
    // aligns them by index against htfStarts.
    expect(mtf.htfResistance).toHaveLength(mtf.htfStarts.length);
    expect(mtf.htfBrokenSupport).toHaveLength(mtf.htfStarts.length);
    // The forming HTF bar is never usable to an operand, so it must not seed or
    // break a line either. The chart's newest bar is the cut.
    const newest = chart.getDataList().at(-1)!.timestamp;
    expect(Math.max(...mtf.htfStarts) + HTF_MS).toBeLessThanOrEqual(newest);
    // Flat fixture bars: no pivots, so no lines — the shape is what is pinned.
    expect(mtf.htfLines).toEqual([]);
  });

  it("is restored by the refresh pass, so the pin survives a reload", async () => {
    // refreshMtfIndicators is what re-detects every pinned pane on load and on
    // scroll-back; only `mtf.timeframe` is persisted, so a pane it skips comes
    // back on the chart timeframe with no sign that anything was dropped. It
    // branches on indTypeOf, NOT on the instance name, which is why the fixture
    // carries the real `indType` an instance is created with.
    fetchRangeStrict.mockImplementation((_e, _tf, fromSec, toSec) =>
      Promise.resolve(htfPage(fromSec as number, toSec as number)),
    );
    const ind = {
      paneId: "candle_pane",
      name: "TRENDLINES",
      calcParams: [...Object.values(TRENDLINES_DEFAULTS)],
      extendData: { indType: "TRENDLINES", mtf: { timeframe: "MINUTE_15" } },
    };
    const chart = {
      getDataList: () => [bar(10_000_000_000), bar(10_000_300_000)],
      getIndicators: () => [ind],
      overrideIndicator: () => true,
    } as unknown as Chart;
    await refreshMtfIndicators(chart, "EPIC");
    expect(fetchRangeStrict).toHaveBeenCalled();
  });

  it("pins the key ORDER of TRENDLINES_DEFAULTS (insertion order feeds HTF calcParams)", () => {
    // The object's own key order IS the calcParams order here, so a param
    // inserted anywhere but the end would shift every slot after it and the
    // HTF pane would silently detect on the wrong settings.
    expect(Object.values(TRENDLINES_DEFAULTS)).toHaveLength(19);
    expect(Object.values(TRENDLINES_DEFAULTS)[16]).toBe(1); // mixedTouches
    expect(Object.values(TRENDLINES_DEFAULTS)[17]).toBe(0); // maxTouchSpacing
    expect(Object.values(TRENDLINES_DEFAULTS)[18]).toBe(0); // minTouchSpacing
  });

  it("fetches the HTF candles on the PANE'S price side, not a hardcoded mid", async () => {
    // A side is worth half a spread on a moving average and a BOOLEAN here: the
    // break test compares a bar's low against the line, so detecting on mid bars
    // while the pane shows bid ones leaves a line that the visible candles went
    // through drawn solid, and still emitting as live support.
    side.value = "bid";
    fetchRangeStrict.mockImplementation((_e, _tf, fromSec, toSec) =>
      Promise.resolve(htfPage(fromSec as number, toSec as number)),
    );
    await apply(fakeChart().chart, "MINUTE_15");
    expect(fetchRangeStrict.mock.calls[0][4]).toBe("bid");
    side.value = "mid";
  });

  it("reaches FURTHER back with Max Span off than with a span ceiling set", async () => {
    // 0 means "no limit" on Max Span, so the off state is the one with no bound
    // on how old a line's first anchor can be. Reading it as a zero-bar reach
    // would fetch a short window and drop the oldest lines on scroll-back —
    // which reads as an alignment bug, not as a fetch one.
    fetchRangeStrict.mockImplementation((_e, _tf, fromSec, toSec) =>
      Promise.resolve(htfPage(fromSec as number, toSec as number)),
    );
    const from = async (maxSpanBars: number): Promise<number> => {
      fetchRangeStrict.mockClear();
      // Each measurement needs its OWN walk to read the reach-back off. The
      // shared cache would (correctly) serve the shallower second config from
      // the deeper first one, leaving nothing to measure.
      clearHtfCache();
      await applyTrendlinesTimeframe(
        fakeChart().chart, "EPIC", "tl1", "candle_pane",
        { ...TRENDLINES_DEFAULTS, maxSpanBars }, "MINUTE_15",
      );
      return fetchRangeStrict.mock.calls[0][2] as number;
    };
    expect(await from(0)).toBeLessThan(await from(5));
  });

  it("caps the pairing term of the warmup reach at MAX_PAIR_PIVOTS", async () => {
    // pairPivots is a user setting with no upper bound, and with Max Span off
    // it multiplies straight into the warmup reach: 2000 slots demanded ~22k
    // HTF bars, which no broker has, so the coverage guard never passed and
    // every refresh refetched and recomputed forever (the OIL_CRUDE freeze).
    // The warmup is best-effort by contract, so the reach is capped; the
    // detector itself still honors the configured pairing width.
    fetchRangeStrict.mockImplementation((_e, _tf, fromSec, toSec) =>
      Promise.resolve(htfPage(fromSec as number, toSec as number)),
    );
    const from = async (pairPivots: number): Promise<number> => {
      fetchRangeStrict.mockClear();
      clearHtfCache();
      await applyTrendlinesTimeframe(
        fakeChart().chart, "EPIC", "tl1", "candle_pane",
        { ...TRENDLINES_DEFAULTS, pairPivots, maxSpanBars: 0 }, "MINUTE_15",
      );
      return fetchRangeStrict.mock.calls[0][2] as number;
    };
    expect(await from(2_000)).toBe(await from(MAX_PAIR_PIVOTS));
  });

  it("a successful walk is final for its ask: the refresh pass skips instead of refetching a reach the broker cannot serve", async () => {
    // The broker's history simply stops at brokerStart. The walk pages back,
    // hits empty windows, and settles with what exists — so the stashed series
    // can NEVER reach the coverage start the config demands. Before the
    // coveredFromMs stamp, the scroll-back guard read that as "not covered"
    // and refetched + recomputed the identical answer on every trigger.
    const brokerStartSec = 9_500_000;
    fetchRangeStrict.mockImplementation((_e, _tf, fromSec, toSec) =>
      Promise.resolve(
        htfPage(Math.max(fromSec as number, brokerStartSec), toSec as number)
          .filter((b) => b.timestamp >= brokerStartSec * 1000),
      ),
    );
    // maxSpanBars 5000 demands ~4.7e9ms of reach — far past brokerStart.
    const params = Object.values({ ...TRENDLINES_DEFAULTS, maxSpanBars: 5_000 });
    const ind = {
      paneId: "candle_pane",
      name: "TRENDLINES",
      calcParams: params,
      extendData: { indType: "TRENDLINES", mtf: { timeframe: "MINUTE_15" } } as {
        indType: string;
        mtf: Record<string, unknown>;
      },
    };
    const chart = {
      getDataList: () => [bar(10_000_000_000), bar(10_000_300_000)],
      getIndicators: () => [ind],
      overrideIndicator: (patch: Override["patch"]) => {
        const ext = (patch.extendData ?? {}) as Record<string, unknown>;
        const keys = Object.keys(ext);
        if (keys.length > 0 && keys.every((k) => ext[k] === null)) return;
        ind.extendData = patch.extendData as typeof ind.extendData;
      },
    } as unknown as Chart;

    await applyTrendlinesTimeframe(
      chart, "EPIC", "TRENDLINES", "candle_pane",
      { ...TRENDLINES_DEFAULTS, maxSpanBars: 5_000 }, "MINUTE_15",
    );
    const mtf = ind.extendData.mtf as { coveredFromMs?: number; htfStarts?: number[] };
    expect(mtf.htfStarts?.[0]).toBe(brokerStartSec * 1000); // series stops at the broker's floor
    expect(mtf.coveredFromMs).toBeLessThan(brokerStartSec * 1000); // but the ASK went deeper

    // The scroll-back refresh for the same span: nothing deeper can arrive, so
    // no fetch. clearHtfCache first, so a skip cannot be the TTL cache's doing.
    fetchRangeStrict.mockClear();
    clearHtfCache();
    await refreshMtfIndicators(chart, "EPIC", undefined, { fromMs: 10_000_000_000, toMs: 10_000_300_000 });
    expect(fetchRangeStrict).not.toHaveBeenCalled();

    // Sanity: without the stamp (a reloaded stash) the same refresh fetches.
    delete (ind.extendData.mtf as { coveredFromMs?: number }).coveredFromMs;
    await refreshMtfIndicators(chart, "EPIC", undefined, { fromMs: 10_000_000_000, toMs: 10_000_300_000 });
    expect(fetchRangeStrict).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Forming-bar mode ("Wait for timeframe closes" unchecked): waitClose false on
// the stashed mtf makes every apply append ONE folded forming bar and flag it,
// and refreshFormingBar re-folds it from the chart's own candles without a
// refetch. Default (absent/true) behavior is pinned by the tests above.
// ---------------------------------------------------------------------------
const { refreshFormingBar } = await import("./mtfCoordinator");

describe("forming-bar mode (waitClose: false)", () => {
  // Aligned to the 15m grid (htfPage starts at the requested fromSec, which is
  // warmup-derived and not round), so the forming bucket's boundaries are
  // knowable: newest chart bar 10_000_300_000 sits in [9_999_900_000,
  // 10_000_800_000), and a pushed 10_000_600_000 tick lands INSIDE it.
  const alignedPage = (fromSec: number, toSec: number): KLineData[] => {
    const out: KLineData[] = [];
    for (
      let t = Math.floor((fromSec * 1000) / HTF_MS) * HTF_MS;
      t <= toSec * 1000;
      t += HTF_MS
    )
      out.push(bar(t));
    return out;
  };

  // A chart whose candles are distinctive (close 5, high 7) so the folded
  // forming bar is tellable from the flat fetched fixture (all 1s), plus a
  // mutable dataList so a live update can be simulated.
  function livelyChart(extendData: object) {
    const data: KLineData[] = [
      { timestamp: 10_000_000_000, open: 1, high: 7, low: 1, close: 5, volume: 1 } as KLineData,
      { timestamp: 10_000_300_000, open: 5, high: 7, low: 1, close: 5, volume: 1 } as KLineData,
    ];
    const f = fakeChart(extendData);
    (f.chart as { getDataList: () => KLineData[] }).getDataList = () => data;
    return { ...f, data };
  }

  // refreshFormingBar branches on indTypeOf, like refreshMtfIndicators — the
  // fixture carries the real indType an instance is created with.
  const pinned = (waitClose?: boolean) => ({
    indType: "EMA",
    mtf: { timeframe: "MINUTE_15", ...(waitClose === undefined ? {} : { waitClose }) },
  });

  it("applyMaTimeframe appends a folded forming bar, flags it, and stashes the fold inputs", async () => {
    fetchRangeStrict.mockImplementation((_e, _tf, fromSec, toSec) =>
      Promise.resolve(alignedPage(fromSec as number, toSec as number)),
    );
    const { chart, overrides } = livelyChart(pinned(false));
    await applyEma(chart, "MINUTE_15");
    const mtf = overrides.at(-1)!.patch.extendData?.mtf as {
      waitClose?: boolean;
      formingIdx?: number;
      htfStarts: number[];
      htfClosed?: KLineData[];
      htfSeries: Array<number | undefined>;
    };
    expect(mtf.waitClose).toBe(false);
    expect(mtf.formingIdx).toBe(mtf.htfStarts.length - 1);
    // Everything before the forming entry is a CLOSED bar, and the raw closed
    // candles are stashed for the live re-fold.
    expect(mtf.htfClosed).toHaveLength(mtf.htfStarts.length - 1);
    const newest = chart.getDataList().at(-1)!.timestamp;
    for (const t of mtf.htfStarts.slice(0, -1))
      expect(t + HTF_MS).toBeLessThanOrEqual(newest);
    // The forming EMA value read the chart's close-5 candles: it must sit above
    // the all-1s closed tail.
    expect(mtf.htfSeries.at(-1)!).toBeGreaterThan(mtf.htfSeries.at(-2)!);
  });

  it("waitClose absent keeps today's stash byte-for-byte (no forming fields)", async () => {
    fetchRangeStrict.mockImplementation((_e, _tf, fromSec, toSec) =>
      Promise.resolve(alignedPage(fromSec as number, toSec as number)),
    );
    const { chart, overrides } = livelyChart(pinned());
    await applyEma(chart, "MINUTE_15");
    const mtf = overrides.at(-1)!.patch.extendData?.mtf as Record<string, unknown>;
    expect(mtf.formingIdx).toBeUndefined();
    expect(mtf.htfClosed).toBeUndefined();
    expect(mtf.waitClose).toBeUndefined();
  });

  it("applyTrendlinesTimeframe appends the forming bar past the closed cut", async () => {
    fetchRangeStrict.mockImplementation((_e, _tf, fromSec, toSec) =>
      Promise.resolve(alignedPage(fromSec as number, toSec as number)),
    );
    const { chart, overrides } = livelyChart(pinned(false));
    await applyTrendlinesTimeframe(
      chart, "EPIC", "tl1", "candle_pane",
      { ...TRENDLINES_DEFAULTS }, "MINUTE_15",
    );
    const mtf = overrides.at(-1)!.patch.extendData?.mtf as {
      formingIdx?: number;
      htfStarts: number[];
      htfSupport: unknown[];
    };
    const newest = chart.getDataList().at(-1)!.timestamp;
    // Last entry IS the forming bucket (still open at the newest chart bar)…
    expect(mtf.formingIdx).toBe(mtf.htfStarts.length - 1);
    expect(mtf.htfStarts.at(-1)! + HTF_MS).toBeGreaterThan(newest);
    // …and the operand series cover it.
    expect(mtf.htfSupport).toHaveLength(mtf.htfStarts.length);
  });

  it("refreshFormingBar re-folds from the chart's candles without a refetch", async () => {
    fetchRangeStrict.mockImplementation((_e, _tf, fromSec, toSec) =>
      Promise.resolve(alignedPage(fromSec as number, toSec as number)),
    );
    const { chart, overrides, data } = livelyChart(pinned(false));
    await applyEma(chart, "MINUTE_15");
    const before = overrides.at(-1)!.patch.extendData?.mtf as {
      htfSeries: Array<number | undefined>;
      htfStarts: number[];
    };
    fetchRangeStrict.mockClear();
    // A new tick inside the forming bucket moves the close from 5 to 50.
    data.push({
      timestamp: data.at(-1)!.timestamp + 300_000,
      open: 5, high: 50, low: 5, close: 50, volume: 1,
    } as KLineData);
    refreshFormingBar(chart);
    const after = overrides.at(-1)!.patch.extendData?.mtf as {
      htfSeries: Array<number | undefined>;
      htfStarts: number[];
      formingIdx?: number;
    };
    expect(fetchRangeStrict).not.toHaveBeenCalled();
    expect(after.formingIdx).toBe(after.htfStarts.length - 1);
    expect(after.htfSeries.at(-1)!).toBeGreaterThan(before.htfSeries.at(-1)!);
  });

  it("preserves coveredFromMs/coveredToMs across a forming re-fold (no refetch, so the reach is unchanged)", async () => {
    fetchRangeStrict.mockImplementation((_e, _tf, fromSec, toSec) =>
      Promise.resolve(alignedPage(fromSec as number, toSec as number)),
    );
    const { chart, overrides } = livelyChart(pinned(false));
    await applyEma(chart, "MINUTE_15");
    const before = overrides.at(-1)!.patch.extendData?.mtf as {
      coveredFromMs?: number;
      coveredToMs?: number;
    };
    expect(before.coveredFromMs).toBeTypeOf("number");
    expect(before.coveredToMs).toBeTypeOf("number");
    refreshFormingBar(chart);
    const after = overrides.at(-1)!.patch.extendData?.mtf as {
      coveredFromMs?: number;
      coveredToMs?: number;
    };
    // Dropping these on the re-fold makes the coverage guard refetch forever
    // for a pin at the broker's history edge — the OIL_CRUDE/US100 freeze loop.
    expect(after.coveredFromMs).toBe(before.coveredFromMs);
    expect(after.coveredToMs).toBe(before.coveredToMs);
  });

  it("a fetch failure's fallback shape keeps waitClose, so the retry re-enters forming mode", async () => {
    fetchRangeStrict.mockRejectedValue(new Error("candles fetch failed: 503"));
    const { chart, overrides } = livelyChart(pinned(false));
    await applyEma(chart, "MINUTE_15");
    expect(overrides.at(-1)!.patch.extendData?.mtf).toEqual({
      timeframe: "MINUTE_15",
      waitClose: false,
    });
  });

  it("refreshFormingBarThrottled coalesces tick-rate calls to ~1/s", async () => {
    fetchRangeStrict.mockImplementation((_e, _tf, fromSec, toSec) =>
      Promise.resolve(alignedPage(fromSec as number, toSec as number)),
    );
    const { refreshFormingBarThrottled } = await import("./mtfCoordinator");
    const { chart, overrides } = livelyChart(pinned(false));
    await applyEma(chart, "MINUTE_15");
    const n = overrides.length;
    refreshFormingBarThrottled(chart); // leading call runs
    refreshFormingBarThrottled(chart); // inside the window: dropped
    refreshFormingBarThrottled(chart);
    expect(overrides.length).toBe(n + 1);
    vi.advanceTimersByTime(1100);
    refreshFormingBarThrottled(chart); // window elapsed: runs again
    expect(overrides.length).toBe(n + 2);
  });

  it("setMtfWaitClose writes only the flag, keeping the rest of the stash", async () => {
    fetchRangeStrict.mockImplementation((_e, _tf, fromSec, toSec) =>
      Promise.resolve(alignedPage(fromSec as number, toSec as number)),
    );
    const { setMtfWaitClose } = await import("./mtfCoordinator");
    const { chart, overrides } = livelyChart(pinned());
    await applyEma(chart, "MINUTE_15");
    setMtfWaitClose(chart, "candle_pane", "ema1", false);
    const mtf = overrides.at(-1)!.patch.extendData?.mtf as Record<string, unknown>;
    expect(mtf.waitClose).toBe(false);
    expect(mtf.timeframe).toBe("MINUTE_15");
    expect(mtf.htfSeries).toBeDefined(); // stash untouched
    // Back to waiting: the flag comes OFF the stash (absent = wait), so the
    // persisted shape stays the pre-feature one.
    setMtfWaitClose(chart, "candle_pane", "ema1", true);
    const mtf2 = overrides.at(-1)!.patch.extendData?.mtf as Record<string, unknown>;
    expect(mtf2.waitClose).toBeUndefined();
  });

  it("refreshFormingBar is a no-op for a waiting pin", async () => {
    fetchRangeStrict.mockImplementation((_e, _tf, fromSec, toSec) =>
      Promise.resolve(alignedPage(fromSec as number, toSec as number)),
    );
    const { chart, overrides } = livelyChart(pinned());
    await applyEma(chart, "MINUTE_15");
    const n = overrides.length;
    refreshFormingBar(chart);
    expect(overrides.length).toBe(n);
  });
});

// ---------------------------------------------------------------------------
// Viewport-scoped coverage: the two-ended interval contract. See
// docs/superpowers/specs/2026-09-09-viewport-scoped-indicator-coverage-design.md.
// ---------------------------------------------------------------------------
const { resolveAskInterval, setViewportReader } = await import("./mtfCoordinator");

describe("resolveAskInterval", () => {
  const H = HTF_MS;
  it("no previous interval returns the need", () => {
    expect(resolveAskInterval(undefined, { fromMs: 10 * H, toMs: 20 * H }, H))
      .toEqual({ fromMs: 10 * H, toMs: 20 * H });
    expect(resolveAskInterval({}, { fromMs: 10 * H, toMs: 20 * H }, H))
      .toEqual({ fromMs: 10 * H, toMs: 20 * H });
  });

  it("overlapping intervals union (monotone growth, both ends)", () => {
    const prev = { coveredFromMs: 10 * H, coveredToMs: 20 * H };
    expect(resolveAskInterval(prev, { fromMs: 5 * H, toMs: 15 * H }, H))
      .toEqual({ fromMs: 5 * H, toMs: 20 * H });
    expect(resolveAskInterval(prev, { fromMs: 15 * H, toMs: 30 * H }, H))
      .toEqual({ fromMs: 10 * H, toMs: 30 * H });
  });

  it("a disjoint need rebases: the ask is just the need", () => {
    const prev = { coveredFromMs: 100 * H, coveredToMs: 120 * H };
    expect(resolveAskInterval(prev, { fromMs: 10 * H, toMs: 20 * H }, H))
      .toEqual({ fromMs: 10 * H, toMs: 20 * H });
  });

  it("derives the previous interval from htfStarts when the stamps are absent", () => {
    const prev = { htfStarts: [10 * H, 11 * H, 12 * H], htfMs: H };
    // Touches [10H, 13H]: union.
    expect(resolveAskInterval(prev, { fromMs: 13 * H, toMs: 20 * H }, H))
      .toEqual({ fromMs: 10 * H, toMs: 20 * H });
  });
});

describe("viewport-scoped coverage interval", () => {
  it("a successful apply stamps BOTH ends of the ask; a failed one stamps neither", async () => {
    fetchRangeStrict.mockImplementation((_e, _tf, fromSec, toSec) =>
      Promise.resolve(htfPage(fromSec as number, toSec as number)),
    );
    const ok = fakeChart();
    await applyEma(ok.chart, "MINUTE_15");
    const mtf = ok.overrides.at(-1)!.patch.extendData?.mtf as {
      coveredFromMs?: number;
      coveredToMs?: number;
    };
    expect(mtf.coveredFromMs).toBeTypeOf("number");
    expect(mtf.coveredToMs).toBe(10_000_300_000); // the chart's newest bar
    clearHtfCache();
    fetchRangeStrict.mockRejectedValue(new Error("candles fetch failed: 503"));
    const bad = fakeChart();
    await applyEma(bad.chart, "MINUTE_15");
    const badMtf = bad.overrides.at(-1)!.patch.extendData?.mtf as {
      coveredFromMs?: number;
      coveredToMs?: number;
    };
    expect(badMtf.coveredFromMs).toBeUndefined();
    expect(badMtf.coveredToMs).toBeUndefined();
  });

  it("the refresh guard skips a stash covered on both ends and refetches one short on the right", async () => {
    fetchRangeStrict.mockImplementation((_e, _tf, fromSec, toSec) =>
      Promise.resolve(htfPage(fromSec as number, toSec as number)),
    );
    const ind = {
      paneId: "candle_pane",
      name: "ema1",
      calcParams: [2],
      extendData: {
        indType: "EMA",
        mtf: {
          timeframe: "MINUTE_15",
          htfStarts: [9_999_000_000, 9_999_900_000],
          htfMs: HTF_MS,
          coveredFromMs: 9_000_000_000,
          coveredToMs: 10_000_300_000,
        },
      },
    };
    const chart = {
      getDataList: () => [bar(10_000_000_000), bar(10_000_300_000)],
      getIndicators: () => [ind],
      overrideIndicator: (patch: Override["patch"]) => {
        ind.extendData = patch.extendData as typeof ind.extendData;
      },
    } as unknown as Chart;
    // Need inside the covered interval on both ends: no fetch.
    await refreshMtfIndicators(chart, "EPIC", undefined, {
      fromMs: 10_000_000_000,
      toMs: 10_000_300_000,
    });
    expect(fetchRangeStrict).not.toHaveBeenCalled();
    // Need reaching further right than the covered ask (plus the one-bucket
    // slack): refetch.
    await refreshMtfIndicators(chart, "EPIC", undefined, {
      fromMs: 10_000_000_000,
      toMs: 10_000_300_000 + 2 * HTF_MS,
    });
    expect(fetchRangeStrict).toHaveBeenCalled();
  });

  it("with no viewport reader, the fallback covers the full loaded span (old contract)", async () => {
    fetchRangeStrict.mockImplementation((_e, _tf, fromSec, toSec) =>
      Promise.resolve(htfPage(fromSec as number, toSec as number)),
    );
    const { chart, overrides } = fakeChart();
    await applyEma(chart, "MINUTE_15");
    const mtf = overrides.at(-1)!.patch.extendData?.mtf as { coveredFromMs?: number };
    // The ask reached back past the oldest loaded bar (warmup included).
    expect(mtf.coveredFromMs).toBeLessThan(10_000_000_000);
  });

  it("a registered viewport reader scopes the ask to the view, not the loaded span", async () => {
    fetchRangeStrict.mockImplementation((_e, _tf, fromSec, toSec) =>
      Promise.resolve(htfPage(fromSec as number, toSec as number)),
    );
    const { chart, overrides } = fakeChart();
    setViewportReader(chart, () => ({
      fromMs: 10_000_200_000,
      toMs: 10_000_300_000,
    }));
    await applyEma(chart, "MINUTE_15");
    setViewportReader(chart, null);
    const mtf = overrides.at(-1)!.patch.extendData?.mtf as {
      coveredFromMs?: number;
      coveredToMs?: number;
    };
    // Ask derives from the view's left end, not the (deeper) oldest loaded bar.
    const deepAsk = 10_000_000_000;
    expect(mtf.coveredFromMs).toBeGreaterThan(deepAsk - 100 * HTF_MS);
    expect(mtf.coveredFromMs).toBeLessThan(10_000_200_000);
    expect(mtf.coveredToMs).toBe(10_000_300_000);
  });

  it("refreshFormingBar leaves a DETACHED stash alone (interval behind the live edge)", async () => {
    fetchRangeStrict.mockImplementation((_e, _tf, fromSec, toSec) =>
      Promise.resolve(htfPage(fromSec as number, toSec as number)),
    );
    const stash = {
      indType: "EMA",
      mtf: {
        timeframe: "MINUTE_15",
        waitClose: false,
        htfMs: HTF_MS,
        htfStarts: [9_000_000_000],
        htfSeries: [1],
        htfClosed: [bar(9_000_000_000)],
        coveredToMs: 9_000_900_000, // years behind the 10_000_300_000 live edge
      },
    };
    const { chart, overrides } = fakeChart(stash);
    refreshFormingBar(chart);
    expect(overrides).toHaveLength(0); // untouched: no fold onto old geometry
    expect(fetchRangeStrict).not.toHaveBeenCalled();
  });
});

const { stampTrendlinesFloors } = await import("./mtfCoordinator");

describe("stampTrendlinesFloors", () => {
  const CHART_MS = 300_000;
  function tlChart(extendData: object) {
    const f = fakeChart(extendData);
    setChartIntervalMs(f.chart, CHART_MS);
    return f;
  }
  const view = { fromMs: 10_000_000_000, toMs: 10_000_300_000 };

  it("stamps a floor on a chart-TF trendlines instance, warmup left of the view", () => {
    const { chart, overrides } = tlChart({ indType: "TRENDLINES" });
    setViewportReader(chart, () => ({ ...view }));
    stampTrendlinesFloors(chart);
    setViewportReader(chart, null);
    const ext = overrides.at(-1)!.patch.extendData as { tlFloorTs?: number };
    expect(ext.tlFloorTs).toBeTypeOf("number");
    expect(ext.tlFloorTs!).toBeLessThan(view.fromMs);
  });

  it("does not touch a pinned instance", () => {
    const { chart, overrides } = tlChart({
      indType: "TRENDLINES",
      mtf: { timeframe: "MINUTE_15" },
    });
    setViewportReader(chart, () => ({ ...view }));
    stampTrendlinesFloors(chart);
    setViewportReader(chart, null);
    expect(overrides).toHaveLength(0);
  });

  it("skips re-stamping inside the hysteresis band, rebases after a far right jump", () => {
    const { chart, overrides } = tlChart({ indType: "TRENDLINES" });
    let v = { ...view };
    setViewportReader(chart, () => ({ ...v }));
    stampTrendlinesFloors(chart);
    const stamps = overrides.length;
    // A small wobble right: inside FLOOR_REBASE_SCREENS view-widths, no stamp.
    v = { fromMs: view.fromMs + 100_000, toMs: view.toMs + 100_000 };
    stampTrendlinesFloors(chart);
    expect(overrides.length).toBe(stamps);
    // A far jump right: rebase forward (drops deep-history compute cost).
    const span = view.toMs - view.fromMs;
    const firstFloor = (overrides.at(-1)!.patch.extendData as { tlFloorTs?: number })
      .tlFloorTs!;
    // Far enough right that wantedFloor clears the hysteresis band even with
    // the warmup subtracted (warmup is fixed; the jump distance is not).
    v = { fromMs: view.fromMs + 4_000 * span, toMs: view.toMs + 4_000 * span };
    stampTrendlinesFloors(chart);
    setViewportReader(chart, null);
    expect(overrides.length).toBe(stamps + 1);
    const ext = overrides.at(-1)!.patch.extendData as { tlFloorTs?: number };
    expect(ext.tlFloorTs!).toBeGreaterThan(firstFloor);
  });

  it("moves the floor LEFT whenever the view outruns it", () => {
    const { chart, overrides } = tlChart({ indType: "TRENDLINES" });
    let v = { ...view };
    setViewportReader(chart, () => ({ ...v }));
    stampTrendlinesFloors(chart);
    const first = (overrides.at(-1)!.patch.extendData as { tlFloorTs?: number })
      .tlFloorTs!;
    v = { fromMs: view.fromMs - 5_000_000, toMs: view.toMs };
    stampTrendlinesFloors(chart);
    setViewportReader(chart, null);
    const second = (overrides.at(-1)!.patch.extendData as { tlFloorTs?: number })
      .tlFloorTs!;
    expect(second).toBeLessThan(first);
  });
});
