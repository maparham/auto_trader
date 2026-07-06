import { describe, it, expect, vi } from "vitest";
import type { KLineData } from "klinecharts";
import type { BacktestConfig } from "./backtestConfig";

// customIndicators.ts reads LineType at module load (AVWAP line style table);
// stub klinecharts' runtime surface like overlays.test.ts does.
vi.mock("klinecharts", () => ({
  LineType: { Solid: "solid", Dashed: "dashed" },
  IndicatorSeries: { Normal: "normal", Price: "price" },
  registerIndicator: () => {},
}));

const { buildSeries } = await import("./backtestSeries");

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
