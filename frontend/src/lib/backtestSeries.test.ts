import { describe, it, expect, vi } from "vitest";
import type { KLineData } from "klinecharts";
import type { BacktestConfig, SeriesRecipe, Operand } from "./backtestConfig";
import type { FetchTimeframe } from "./backtestSeries";

// customIndicators.ts reads LineType at module load (AVWAP line style table);
// stub klinecharts' runtime surface like overlays.test.ts does.
vi.mock("klinecharts", () => ({
  LineType: { Solid: "solid", Dashed: "dashed" },
  IndicatorSeries: { Normal: "normal", Price: "price" },
  registerIndicator: () => {},
}));

const { buildSeries } = await import("./backtestSeries");
const { maSeries, sma } = await import("./mtf");
const { computeRsi, computeLr, computePrevHl, vwapFrom } = await import("./customIndicators");
const { recipeKey, seriesName } = await import("./backtestConfig");

// The base run is on 1-minute bars (candles() stamps every 60_000ms); no rule
// here references a higher timeframe, so fetchTimeframe is never called.
const BASE = "MINUTE";
const noFetch = async (): Promise<KLineData[]> => [];

function candles(closes: number[], volumes?: number[]): KLineData[] {
  return closes.map((c, i) => ({
    timestamp: i * 60_000,
    open: c,
    high: c,
    low: c,
    close: c,
    volume: volumes?.[i] ?? 0,
  }));
}

function cfg(overrides: Partial<BacktestConfig>): BacktestConfig {
  return {
    range: { mode: "bars", bars: 500 },
    longEntry: { combine: "AND", rules: [] },
    longExit: { combine: "AND", rules: [] },
    shortEntry: { combine: "AND", rules: [] },
    shortExit: { combine: "AND", rules: [] },
    longEnabled: true,
    shortEnabled: true,
    costs: { quantity: 1, commissionPerSide: 0, slippage: 0, startingCash: 10_000 },
    ...overrides,
  };
}

describe("buildSeries", () => {
  it("keys the output by the seriesName contract", async () => {
    const bars = candles([1, 2, 3, 4, 5]);
    const config = cfg({
      longEntry: {
        combine: "AND",
        rules: [
          {
            left: { kind: "indicator", indicator: "EMA", length: 3 },
            op: "gt",
            right: { kind: "indicator", indicator: "RSI", length: 14 },
          },
        ],
      },
    });
    const series = await buildSeries(bars, config, BASE, noFetch);
    expect(Object.keys(series).sort()).toEqual(["EMA_3", "RSI_14"]);
  });

  it("every series has the same length as the candles, with null warmup", async () => {
    const bars = candles([1, 2, 3, 4, 5]);
    const config = cfg({
      longEntry: {
        combine: "AND",
        rules: [
          {
            left: { kind: "indicator", indicator: "SMA", length: 3 },
            op: "gt",
            right: { kind: "const", value: 0 },
          },
        ],
      },
    });
    const series = await buildSeries(bars, config, BASE, noFetch);
    expect(series["SMA_3"]).toHaveLength(5);
    expect(series["SMA_3"][0]).toBeNull();
    expect(series["SMA_3"][1]).toBeNull();
    expect(series["SMA_3"][2]).not.toBeNull();
  });

  it("uses .val for RSI (not .rsi, which is omitted when the line is hidden)", async () => {
    const bars = candles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    const config = cfg({
      longEntry: {
        combine: "AND",
        rules: [
          {
            left: { kind: "indicator", indicator: "RSI", length: 14 },
            op: "gt",
            right: { kind: "const", value: 0 },
          },
        ],
      },
    });
    const series = await buildSeries(bars, config, BASE, noFetch);
    // RSI(14) needs 15 bars of run-up; the 16th (index 15) should be defined.
    expect(series["RSI_14"][15]).not.toBeNull();
    expect(typeof series["RSI_14"][15]).toBe("number");
  });

  it("VOL reads raw volume, VOLMA smooths it", async () => {
    const bars = candles([1, 1, 1, 1], [10, 20, 30, 40]);
    const config = cfg({
      longEntry: {
        combine: "OR",
        rules: [
          { left: { kind: "indicator", indicator: "VOL" }, op: "gt", right: { kind: "const", value: 0 } },
          {
            left: { kind: "indicator", indicator: "VOLMA", length: 2 },
            op: "gt",
            right: { kind: "const", value: 0 },
          },
        ],
      },
    });
    const series = await buildSeries(bars, config, BASE, noFetch);
    expect(series["VOL"]).toEqual([10, 20, 30, 40]);
    expect(series["VOLMA_2"][0]).toBeNull();
    expect(series["VOLMA_2"][1]).toBe(15);
  });

  it("AVWAP anchors at the chosen bar; before-anchor bars are null", async () => {
    // candles() stamps timestamps at i * 60_000, so anchor 60_000 = index 1.
    const bars = candles([10, 10, 10], [5, 5, 5]);
    const config = cfg({
      longEntry: {
        combine: "AND",
        rules: [
          { left: { kind: "indicator", indicator: "AVWAP", anchor: 60_000 }, op: "gt", right: { kind: "const", value: 0 } },
        ],
      },
    });
    const series = await buildSeries(bars, config, BASE, noFetch);
    expect(series["AVWAP_60000"]).toHaveLength(3);
    expect(series["AVWAP_60000"][0]).toBeNull(); // before the anchor
    expect(series["AVWAP_60000"][1]).not.toBeNull();
    expect(series["AVWAP_60000"][2]).not.toBeNull();
  });

  it("AVWAP with an anchor after the range is all null", async () => {
    const bars = candles([10, 10, 10], [5, 5, 5]);
    const config = cfg({
      longEntry: {
        combine: "AND",
        rules: [
          { left: { kind: "indicator", indicator: "AVWAP", anchor: 999_999_999 }, op: "gt", right: { kind: "const", value: 0 } },
        ],
      },
    });
    const series = await buildSeries(bars, config, BASE, noFetch);
    expect(series["AVWAP_999999999"]).toEqual([null, null, null]);
  });

  it("two AVWAPs with different anchors produce two distinct series", async () => {
    const bars = candles([10, 10, 10], [5, 5, 5]);
    const config = cfg({
      longEntry: {
        combine: "AND",
        rules: [
          { left: { kind: "indicator", indicator: "AVWAP", anchor: 0 }, op: "gt", right: { kind: "const", value: 0 } },
          { left: { kind: "indicator", indicator: "AVWAP", anchor: 60_000 }, op: "gt", right: { kind: "const", value: 0 } },
        ],
      },
    });
    const series = await buildSeries(bars, config, BASE, noFetch);
    // anchor 0 = unplaced -> all null; anchor 60_000 = placed at index 1.
    expect(series["AVWAP_0"]).toEqual([null, null, null]);
    expect(series["AVWAP_60000"][1]).not.toBeNull();
  });

  it("emits an ATR_{n} series when a risk config references ATR", async () => {
    const data = candles([10, 11, 12, 13, 14, 15]);
    const out = await buildSeries(data, cfg({
      longRisk: { stop: { kind: "trailAtr", mult: 2, length: 3 }, target: { kind: "none" } },
    }), BASE, noFetch);
    expect(out["ATR_3"]).toBeDefined();
    expect(out["ATR_3"].length).toBe(data.length);
    expect(out["ATR_3"][0]).toBeNull(); // cold until 3 TRs exist
    expect(out["ATR_3"][2]).not.toBeNull();
  });

  it("emits no ATR series when no risk config references ATR", async () => {
    const data = candles([10, 11, 12]);
    const out = await buildSeries(data, cfg({
      longRisk: { stop: { kind: "pct", value: 2 }, target: { kind: "none" } },
    }), BASE, noFetch);
    expect(Object.keys(out).some((k) => k.startsWith("ATR_"))).toBe(false);
  });

  it("emits ATR_{n} for scaling spacing", async () => {
    const data = candles([10, 11, 12, 13]);
    const out = await buildSeries(data, cfg({
      longScaling: { maxConcurrent: 3, spacing: { kind: "atr", mult: 2, length: 3 } },
    }), BASE, noFetch);
    expect(out["ATR_3"]).toBeDefined();
  });

  it("computes a sloped operand as percent per hour with a null warm-up", async () => {
    const bars = candles([100, 101, 102.01]);
    const config = cfg({
      longEntry: {
        combine: "AND",
        rules: [
          { left: { kind: "price", field: "close", slope: { len: 1 } }, op: "gt", right: { kind: "const", value: 0 } },
        ],
      },
    });
    // BASE is MINUTE (1/60 h per bar), so a +1%/bar move is 60 %/hr.
    const s = (await buildSeries(bars, config, BASE, noFetch))["close~1"];
    expect(s).toHaveLength(3);
    expect(s[0]).toBeNull(); // no prior bar
    expect(s[1]).toBeCloseTo(60); // (101−100)/100 / (1×(1/60)h) ×100
    expect(s[2]).toBeCloseTo(60); // (102.01−101)/101 / (1×(1/60)h) ×100
  });

  it("a lookback of N leaves N bars of warm-up and divides by the elapsed time N×TF", async () => {
    const bars = candles([100, 110, 121, 133.1]);
    const config = cfg({
      longEntry: {
        combine: "AND",
        rules: [
          { left: { kind: "price", field: "close", slope: { len: 2 } }, op: "gt", right: { kind: "const", value: 0 } },
        ],
      },
    });
    const s = (await buildSeries(bars, config, BASE, noFetch))["close~2"];
    expect(s[0]).toBeNull();
    expect(s[1]).toBeNull(); // needs v[i−2]
    expect(s[2]).toBeCloseTo(630); // (121−100)/100 / (2×(1/60)h) ×100 = 10.5×60
  });

  it("divides the slope by the operand's timeframe (%/hr, timeframe-aware)", async () => {
    // A 5-minute base run: the time run for a 1-bar lookback is 1/12 h, so a
    // +2.5%/bar move is 2.5 / (1/12) = 30 %/hr.
    const bars = candles([100, 102.5]);
    const config = cfg({
      longEntry: {
        combine: "AND",
        rules: [
          { left: { kind: "price", field: "close", slope: { len: 1 } }, op: "gt", right: { kind: "const", value: 0 } },
        ],
      },
    });
    const s = (await buildSeries(bars, config, "MINUTE_5", noFetch))["close~1"];
    expect(s[1]).toBeCloseTo(30); // (2.5/100) / (1×(1/12)h) ×100
  });

  it("computes a higher-timeframe slope on native candles BEFORE forward-fill (not by diffing the filled array)", async () => {
    // Base: twelve 1-minute bars (t = 0..660k). HTF: three 5-minute bars closing
    // at t = 300k, 600k, 900k with EMA(1)==close values 10, 12, 15. Native slope
    // (len 1, %/hr, TF=1/12 h) is [null, (2/10)/(1/12)×100=240, (3/12)/(1/12)×100=300].
    // Forward-filled with waitClose:
    //   t<600k → null (only htf bar 0 closed, whose slope is null),
    //   t∈[600k,900k) → 240 (htf bar 1's slope).
    // The WRONG impl (slope of the already-forward-filled EMA array) would read 0
    // inside each held HTF value and spike/zero at the boundary — so s[11]===0 and
    // s[6]===0. The correct impl holds 240 across t≥600k and keeps s[6] null.
    const base = candles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const htf: KLineData[] = [
      { timestamp: 0, open: 10, high: 10, low: 10, close: 10, volume: 0 },
      { timestamp: 300_000, open: 12, high: 12, low: 12, close: 12, volume: 0 },
      { timestamp: 600_000, open: 15, high: 15, low: 15, close: 15, volume: 0 },
    ];
    const fetchTimeframe = async (): Promise<KLineData[]> => htf;
    const config = cfg({
      longEntry: {
        combine: "AND",
        rules: [
          {
            left: { kind: "indicator", indicator: "EMA", length: 1, timeframe: "MINUTE_5", slope: { len: 1 } },
            op: "gt",
            right: { kind: "const", value: 0 },
          },
        ],
      },
    });
    const s = (await buildSeries(base, config, BASE, fetchTimeframe))["EMA_1~1@MINUTE_5"];
    expect(s).toHaveLength(base.length);
    expect(s[6]).toBeNull(); // htf bar 0 closed, its slope is null — NOT 0
    expect(s[10]).toBeCloseTo(240); // t=600k: htf bar 1's native slope (÷(1/12)h), held
    expect(s[11]).toBeCloseTo(240); // still held — NOT a 0 from diffing the fill
  });

  it("a higher-timeframe operand keys as INDICATOR@TF, fetches that timeframe, and forward-fills onto the base bars without lookahead", async () => {
    // Base: six 1-minute bars (t = 0,60k,120k,180k,240k,300k). The rule wants a
    // 5-minute EMA, so the run must fetch HOUR_5-equivalent... here MINUTE_5.
    const base = candles([1, 2, 3, 4, 5, 6]);
    // Two 5-minute bars: the first opens at t=0 (closes at 300k), the second
    // opens at t=300k. With waitClose alignment, base bars strictly before 300k
    // can see NO closed 5m bar yet, so they stay null; the bar at t=300k is the
    // first that can read the first 5m bar's value.
    const htf: KLineData[] = [
      { timestamp: 0, open: 10, high: 10, low: 10, close: 10, volume: 0 },
      { timestamp: 300_000, open: 20, high: 20, low: 20, close: 20, volume: 0 },
    ];
    let requested = "";
    const fetchTimeframe = async (resolution: string): Promise<KLineData[]> => {
      requested = resolution;
      return htf;
    };
    const config = cfg({
      longEntry: {
        combine: "AND",
        rules: [
          {
            left: { kind: "indicator", indicator: "EMA", length: 1, timeframe: "MINUTE_5" },
            op: "gt",
            right: { kind: "const", value: 0 },
          },
        ],
      },
    });
    const series = await buildSeries(base, config, BASE, fetchTimeframe);
    expect(requested).toBe("MINUTE_5");
    const s = series["EMA_1@MINUTE_5"];
    expect(s).toBeDefined();
    expect(s).toHaveLength(base.length); // 1:1 with base bars
    // EMA(1) == close, so the aligned value is the last CLOSED 5m close.
    // Bars before the first 5m close (t < 300k) have no usable value → null.
    expect(s.slice(0, 5)).toEqual([null, null, null, null, null]);
    expect(s[5]).toBe(10); // t=300k: first 5m bar has now closed
  });
});

// A copied chart operand (kind "series") must recompute the EXACT curve the chart
// shows, via the same pure functions — so parity is asserted against a direct call.
const nul = (a: Array<number | undefined>) => a.map((v) => (v === undefined ? null : v));

async function seriesFor(
  recipe: SeriesRecipe,
  bars: KLineData[],
  opts: { timeframe?: string; slope?: { len: number }; base?: string; fetch?: FetchTimeframe } = {},
): Promise<Array<number | null>> {
  const op = {
    kind: "series", seriesKey: recipeKey(recipe), label: "chip", recipe,
    ...(opts.timeframe ? { timeframe: opts.timeframe } : {}),
    ...(opts.slope ? { slope: opts.slope } : {}),
  } as Operand;
  const config = cfg({
    longEntry: { combine: "AND", rules: [{ left: op, op: "gt", right: { kind: "const", value: 0 } }] },
  });
  const out = await buildSeries(bars, config, opts.base ?? BASE, opts.fetch ?? noFetch);
  return out[seriesName(op)!];
}

describe("series operand — indicator recipes match the chart template", () => {
  it("EMA reproduces maSeries().base", async () => {
    const bars = candles([1, 2, 3, 4, 5, 6, 7, 8]);
    const got = await seriesFor({ source: "indicator", indicatorType: "EMA", calcParams: [3], line: 0 }, bars);
    expect(got).toEqual(nul(maSeries(bars, "ema", 3, {}).base));
  });

  it("MA reproduces maSeries().base (simple, not smoothed)", async () => {
    const bars = candles([1, 2, 3, 4, 5, 6, 7, 8]);
    const got = await seriesFor({ source: "indicator", indicatorType: "MA", calcParams: [4], line: 0 }, bars);
    expect(got).toEqual(nul(maSeries(bars, "sma", 4, {}).base));
  });

  it("RSI reproduces computeRsi().val", async () => {
    const bars = candles([1, 2, 3, 2, 3, 4, 3, 4, 5, 4, 5, 6, 5, 6, 7, 8]);
    const got = await seriesFor({ source: "indicator", indicatorType: "RSI", calcParams: [14], line: 0 }, bars);
    expect(got).toEqual(nul(computeRsi(bars, 14, {}).map((p) => p.val ?? undefined)));
  });

  it("LR line 0 reproduces computeLr().lr; line picks the selected curve", async () => {
    const bars = candles([1, 3, 2, 4, 6, 5, 7, 9, 8, 10]);
    const lr = computeLr(bars, 5, 2, {});
    const got = await seriesFor({ source: "indicator", indicatorType: "LR", calcParams: [5, 2], line: 0 }, bars);
    expect(got).toEqual(nul(lr.map((p) => (p as Record<string, number | undefined>).lr)));
    const up = await seriesFor({ source: "indicator", indicatorType: "LR", calcParams: [5, 2], line: 1 }, bars);
    expect(up).toEqual(nul(lr.map((p) => (p as Record<string, number | undefined>).up)));
  });

  it("VWAP reproduces vwapFrom(0).vwap; AVWAP starts at its anchor (calcParams[0])", async () => {
    const bars = candles([1, 2, 3, 4, 5], [10, 10, 10, 10, 10]);
    const vwap = await seriesFor({ source: "indicator", indicatorType: "VWAP", calcParams: [], line: 0 }, bars);
    expect(vwap).toEqual(nul(vwapFrom(bars, 0, {}).map((p) => p.vwap ?? undefined)));
    // AVWAP anchored at t=120_000 (bar index 2) accumulates from index 2.
    const av = await seriesFor({ source: "indicator", indicatorType: "AVWAP", calcParams: [120_000], line: 0 }, bars);
    expect(av.slice(0, 2)).toEqual([null, null]);
    expect(av[2]).not.toBeNull();
    // Unplaced anchor (<= 0) => no line.
    const unplaced = await seriesFor({ source: "indicator", indicatorType: "AVWAP", calcParams: [0], line: 0 }, bars);
    expect(unplaced).toEqual([null, null, null, null, null]);
  });

  it("PREV_HL picks the selected boundary line by index", async () => {
    const bars = candles([5, 7, 3, 8, 2, 9, 4, 6]);
    const pts = computePrevHl(bars, {}) as unknown as Array<Record<string, number | undefined>>;
    // line 2 = dayHigh in the template's figure order.
    const dayHigh = await seriesFor({ source: "indicator", indicatorType: "PREV_HL", calcParams: [], line: 2 }, bars);
    expect(dayHigh).toEqual(nul(pts.map((p) => p.dayHigh)));
  });

  it("a picker-built LR 'Upper' operand (line 1) resolves to computeLr().up end-to-end", async () => {
    const { chartOperandSources } = await import("./chartOperand");
    const bars = candles([1, 3, 2, 4, 6, 5, 7, 9, 8, 10]);
    const src = chartOperandSources({ kind: "indicator", paneId: "candle_pane", id: "LR#x", indType: "LR", calcParams: [5, 2], extendData: {} });
    const upper = src.outputs.find((o) => o.operand.label.endsWith("Upper"))!;
    const recipe = (upper.operand as Extract<Operand, { kind: "series" }>).recipe;
    const got = await seriesFor(recipe, bars);
    expect(got).toEqual(nul(computeLr(bars, 5, 2, {}).map((p) => (p as Record<string, number | undefined>).up)));
  });
});

describe("series operand — drawing recipes as a per-bar price series", () => {
  // Candle timestamps are i*60_000; anchors chosen on that grid.
  const bars = candles([0, 0, 0, 0, 0, 0]); // t = 0,60k,120k,180k,240k,300k

  it("segment: linear inside [t0,t1], null outside", async () => {
    const got = await seriesFor(
      { source: "drawing", drawingKind: "segment", anchors: [{ timestamp: 60_000, value: 10 }, { timestamp: 180_000, value: 30 }] },
      bars,
    );
    // i0 (t=0) before start -> null; i1=10, i2=20, i3=30; i4,i5 after end -> null
    expect(got).toEqual([null, 10, 20, 30, null, null]);
  });

  it("rayLine: null before the origin, linear from t0 forward", async () => {
    const got = await seriesFor(
      { source: "drawing", drawingKind: "rayLine", anchors: [{ timestamp: 60_000, value: 10 }, { timestamp: 120_000, value: 20 }] },
      bars,
    );
    // slope = 10 per 60k. i0 before origin -> null; then 10,20,30,40,50
    expect(got).toEqual([null, 10, 20, 30, 40, 50]);
  });

  it("straightLine: defined for all bars (both directions)", async () => {
    const got = await seriesFor(
      { source: "drawing", drawingKind: "straightLine", anchors: [{ timestamp: 60_000, value: 10 }, { timestamp: 120_000, value: 20 }] },
      bars,
    );
    expect(got).toEqual([0, 10, 20, 30, 40, 50]);
  });

  it("horizontalStraightLine / priceLine: flat constant at anchors[0].value", async () => {
    const flat = await seriesFor(
      { source: "drawing", drawingKind: "horizontalStraightLine", anchors: [{ timestamp: 999, value: 42 }] },
      bars,
    );
    expect(flat).toEqual([42, 42, 42, 42, 42, 42]);
  });
});

describe("series operand — MTF and slope compose", () => {
  it("a sloped series keys ~len and slopes the native curve", async () => {
    // A rising straight line -> a positive %/hr slope on every warm bar (the
    // slope is taken on the drawing's own per-bar values, not a flat series).
    const bars = candles([0, 0, 0, 0, 0, 0]);
    const recipe: SeriesRecipe = {
      source: "drawing", drawingKind: "straightLine",
      anchors: [{ timestamp: 0, value: 100 }, { timestamp: 60_000, value: 101 }],
    };
    const got = await seriesFor(recipe, bars, { slope: { len: 1 } });
    // key carries the ~1 suffix
    const key = seriesName({ kind: "series", seriesKey: recipeKey(recipe), label: "x", recipe, slope: { len: 1 } } as Operand);
    expect(key).toMatch(/~1$/);
    expect(got[0]).toBeNull(); // first bar: no v[i-1]
    const defined = got.slice(1);
    expect(defined.every((v) => v !== null && Number.isFinite(v) && (v as number) > 0)).toBe(true);
  });

  it("an MTF indicator recipe fetches the higher timeframe and forward-fills onto base bars", async () => {
    const base = candles(new Array(10).fill(10)); // 1-min bars, t=0..540k
    const htf: KLineData[] = [
      { timestamp: 0, open: 10, high: 10, low: 10, close: 10, volume: 0 },
      { timestamp: 300_000, open: 20, high: 20, low: 20, close: 20, volume: 0 },
    ];
    let requested = "";
    const fetch: FetchTimeframe = async (r) => { requested = r; return htf; };
    // EMA(1) == close, so the HTF value is just the last closed 5m close.
    const got = await seriesFor(
      { source: "indicator", indicatorType: "EMA", calcParams: [1], line: 0 },
      base,
      { timeframe: "MINUTE_5", fetch },
    );
    expect(requested).toBe("MINUTE_5");
    expect(got.slice(0, 5)).toEqual([null, null, null, null, null]); // before first 5m close
    expect(got[5]).toBe(10); // first 5m bar closed at t=300k
  });
});
