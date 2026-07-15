import { describe, it, expect, vi } from "vitest";
import type { KLineData } from "klinecharts";

// SLOPE_TEMPLATE reads LineType/IndicatorSeries at module load; stub klinecharts'
// runtime surface like the other indicator tests do.
vi.mock("klinecharts", () => ({
  LineType: { Solid: "solid", Dashed: "dashed" },
  IndicatorSeries: { Normal: "normal", Price: "price" },
  registerIndicator: () => {},
}));

const { inferBarHours, slopeWithUnits, computeSlope, SLOPE_TEMPLATE, smoothSeries, slopeLineSeries, slopeMaLines, accelSeries, SLOPE_ACCEL_TEMPLATE, accelLineSeries } =
  await import("./slope");

const bar = (t: number, c: number): KLineData =>
  ({ timestamp: t, open: c, high: c, low: c, close: c, volume: 1 }) as KLineData;

describe("inferBarHours", () => {
  it("returns hours from the smallest positive timestamp gap", () => {
    const c = [bar(0, 1), bar(300_000, 1), bar(900_000, 1)]; // 5-min min gap
    expect(inferBarHours(c)).toBeCloseTo(1 / 12, 10);
  });
  it("falls back to 1 for a single bar", () => {
    expect(inferBarHours([bar(0, 1)])).toBe(1);
  });
});

describe("slopeWithUnits", () => {
  const raw = [100, 101, 102, 103]; // +1 per bar off a 100 base
  it("pctBar = percent change per bar", () => {
    // (102-100)/100/2*100 = 1
    expect(slopeWithUnits(raw, 2, 1 / 12, "pctBar")[2]).toBeCloseTo(1, 10);
  });
  it("pctHr divides pctBar-run by elapsed hours", () => {
    // pctBar 1 over 2 bars * (1/12 h each) => 1 / (2 * 1/12) *? -> reuse formula
    // (102-100)/100/(2 * 1/12)*100 = 12
    expect(slopeWithUnits(raw, 2, 1 / 12, "pctHr")[2]).toBeCloseTo(12, 10);
  });
  it("priceBar = raw price change per bar", () => {
    // (102-100)/2 = 1
    expect(slopeWithUnits(raw, 2, 1 / 12, "priceBar")[2]).toBeCloseTo(1, 10);
  });
  it("undefined for the first n bars and where prev is 0", () => {
    expect(slopeWithUnits(raw, 2, 1, "pctBar")[1]).toBeUndefined();
    expect(slopeWithUnits([0, 1, 2], 1, 1, "pctBar")[1]).toBeUndefined(); // prev===0
  });
});

describe("computeSlope", () => {
  it("slopes the SMA of close over n bars", () => {
    const c = [bar(0, 10), bar(60_000, 12), bar(120_000, 14), bar(180_000, 16)];
    // sma length 1 = close itself; priceBar slope n=1 = adjacent diff = 2
    const pts = computeSlope(c, "sma", 1, 1, "priceBar", {}, 1);
    expect(pts[3].slope).toBeCloseTo(2, 10);
    expect(pts[0].slope).toBeUndefined();
  });
});

describe("SLOPE_TEMPLATE", () => {
  const bar2 = (t: number, c: number): KLineData =>
    ({ timestamp: t, open: c, high: c, low: c, close: c, volume: 1 }) as KLineData;
  it("is a sub-pane single-line indicator", () => {
    expect(SLOPE_TEMPLATE.series).toBe("normal");
    expect(SLOPE_TEMPLATE.figures?.[0]?.key).toBe("slope0");
  });
  it("calc reads maType/units from extendData and slopes the MA", () => {
    const c = [bar2(0, 10), bar2(60_000, 12), bar2(120_000, 14)];
    const out = SLOPE_TEMPLATE.calc!(c, {
      calcParams: [1],
      extendData: { maType: "sma", units: "priceBar", slopePeriod: 1 },
    } as never) as Array<{ slope0?: number }>;
    expect(out[2].slope0).toBeCloseTo(2, 10); // adjacent diff of a length-1 SMA
  });
});

describe("multi-line SLOPE", () => {
  const bar3 = (t: number, c: number): KLineData =>
    ({ timestamp: t, open: c, high: c, low: c, close: c, volume: 1 }) as KLineData;
  it("calc returns slope0..slopeK, one per calcParams length", () => {
    const c = [10, 11, 12, 13, 14].map((v, i) => bar3(i * 60_000, v));
    const out = SLOPE_TEMPLATE.calc!(c, {
      calcParams: [1, 2], // two MA lengths
      extendData: { maType: "sma", units: "priceBar", slopePeriod: 1 },
    } as never) as Array<Record<string, number | undefined>>;
    expect("slope0" in out[4] && "slope1" in out[4]).toBe(true);
    expect(out[4].slope0).toBeCloseTo(1, 10); // sma len1 → +1/bar priceBar slope
  });
  it("regenerateFigures emits one titled line figure per length", () => {
    const figs = SLOPE_TEMPLATE.regenerateFigures!([9, 21, 50]);
    const lineFigs = figs.filter((f) => f.title !== "");
    expect(lineFigs.map((f) => f.key)).toEqual(["slope0", "slope1", "slope2"]);
    expect(figs.every((f) => f.type === "line")).toBe(true);
    // every slope figure is titled (by its length) so the legend shows all values
    expect(lineFigs.map((f) => f.title)).toEqual(["Slope 9: ", "Slope 21: ", "Slope 50: "]);
    // + empty-title threshold figures (legend-skipped, drive auto-scale only)
    expect(figs.filter((f) => f.title === "").map((f) => f.key)).toEqual(["thHi", "thLo"]);
  });
});

describe("threshold constants", () => {
  const b = (t: number, c: number): KLineData =>
    ({ timestamp: t, open: c, high: c, low: c, close: c, volume: 1 }) as KLineData;
  const c = [10, 11, 12].map((v, i) => b(i * 60_000, v));
  it("emits thHi/thLo = ±level on every point when threshold.on", () => {
    const out = SLOPE_TEMPLATE.calc!(c, {
      calcParams: [1],
      extendData: {
        maType: "sma",
        units: "priceBar",
        slopePeriod: 1,
        threshold: { on: true, level: 0.5 },
      },
    } as never) as Array<Record<string, number | undefined>>;
    expect(out.every((p) => p.thHi === 0.5 && p.thLo === -0.5)).toBe(true);
  });
  it("omits thHi/thLo when threshold is off or absent", () => {
    const off = SLOPE_TEMPLATE.calc!(c, {
      calcParams: [1],
      extendData: { maType: "sma", units: "priceBar", slopePeriod: 1, threshold: { on: false, level: 0.5 } },
    } as never) as Array<Record<string, number | undefined>>;
    expect("thHi" in off[0] || "thLo" in off[0]).toBe(false);
    const none = SLOPE_TEMPLATE.calc!(c, {
      calcParams: [1],
      extendData: { maType: "sma", units: "priceBar", slopePeriod: 1 },
    } as never) as Array<Record<string, number | undefined>>;
    expect("thHi" in none[0] || "thLo" in none[0]).toBe(false);
  });
  it("uses |level| so a negative stored level still yields symmetric lines", () => {
    const out = SLOPE_TEMPLATE.calc!(c, {
      calcParams: [1],
      extendData: { maType: "sma", units: "priceBar", slopePeriod: 1, threshold: { on: true, level: -0.3 } },
    } as never) as Array<Record<string, number | undefined>>;
    expect(out[0].thHi).toBeCloseTo(0.3, 10);
    expect(out[0].thLo).toBeCloseTo(-0.3, 10);
  });
});

describe("smoothSeries", () => {
  it("none returns input unchanged", () => {
    const v = [1, 2, 3];
    expect(smoothSeries(v, { type: "none", length: 3 })).toEqual(v);
    expect(smoothSeries(v, undefined)).toEqual(v);
  });
  it("sma length 2 averages the last 2 defined values", () => {
    // sma over [10,20,30] len2 => [undefined,15,25] (first bar has no full window)
    expect(smoothSeries([10, 20, 30], { type: "sma", length: 2 })).toEqual([undefined, 15, 25]);
  });
  it("passes undefined gaps through (leading warm-up preserved)", () => {
    const out = smoothSeries([undefined, 10, 20], { type: "sma", length: 2 });
    expect(out[0]).toBeUndefined();
  });
});

describe("slopeMaLines", () => {
  const candles = [bar(0, 100), bar(60_000, 101), bar(120_000, 102), bar(180_000, 103), bar(240_000, 104)];

  it("returns [] when showMa is off", () => {
    expect(slopeMaLines({ calcParams: [2], extendData: {} }, candles)).toEqual([]);
    expect(slopeMaLines({ calcParams: [2], extendData: { showMa: false } }, candles)).toEqual([]);
  });

  it("returns [] when the indicator is hidden", () => {
    expect(
      slopeMaLines({ calcParams: [2], extendData: { showMa: true }, visible: false }, candles),
    ).toEqual([]);
  });

  it("returns one line per length equal to maSeries base (SMA parity)", () => {
    const lines = slopeMaLines(
      { calcParams: [2, 3], extendData: { showMa: true, maType: "sma" } },
      candles,
    );
    expect(lines.length).toBe(2);
    // SMA(2) of closes 100,101,102,103,104 -> undefined,100.5,101.5,102.5,103.5
    expect(lines[0].values[0]).toBeUndefined();
    expect(lines[0].values[1]).toBeCloseTo(100.5, 10);
    expect(lines[0].values[4]).toBeCloseTo(103.5, 10);
    // SMA(3) -> undefined,undefined,101,102,103
    expect(lines[1].values[2]).toBeCloseTo(101, 10);
  });

  it("applies slope smoothing to the on-chart MA (chart TF)", () => {
    const candles = [bar(0, 100), bar(60_000, 102), bar(120_000, 101), bar(180_000, 105), bar(240_000, 103)];
    const raw = slopeMaLines(
      { calcParams: [2], extendData: { showMa: true, maType: "sma" } },
      candles,
    )[0].values;
    const smoothed = slopeMaLines(
      { calcParams: [2], extendData: { showMa: true, maType: "sma", smoothing: { type: "sma", length: 2 } } },
      candles,
    )[0].values;
    // Smoothing changes the line: the smoothed series must differ from the raw MA where
    // both are defined, and must equal smoothSeries(raw, {sma,2}).
    const expected = smoothSeries(raw, { type: "sma", length: 2 });
    expect(smoothed).toEqual(expected);
    // Sanity: it actually differs from raw at some defined index.
    expect(smoothed.some((v, i) => v !== undefined && raw[i] !== undefined && v !== raw[i])).toBe(true);
  });

  it("resolves color from styles override then palette fallback", () => {
    const lines = slopeMaLines(
      { calcParams: [2, 3], extendData: { showMa: true }, styles: { lines: [{ color: "#123456" }] } },
      candles,
    );
    expect(lines[0].color).toBe("#123456"); // override
    expect(lines[1].color).toBe("#42A5F5"); // SLOPE_PALETTE[1] fallback
  });

  it("matches the slope line's width (override, else 1.5 fallback)", () => {
    const lines = slopeMaLines(
      { calcParams: [2, 3], extendData: { showMa: true }, styles: { lines: [{ size: 3 }] } },
      candles,
    );
    expect(lines[0].width).toBe(3); // override carried to the MA
    expect(lines[1].width).toBe(1.5); // fallback when no per-line size
  });

  it("MTF: aligns the stashed HTF MA base to chart bars (no recompute)", () => {
    // Two HTF bars starting at t=0 and t=120_000 (htfMs=120_000), base values 10 and 20.
    // All chart closes are 1, so a naive maSeries recompute would land near 1.
    // seeing 10/20 instead proves the stashed base is being used, not recomputed.
    const chart = [bar(0, 1), bar(60_000, 1), bar(120_000, 1), bar(180_000, 1), bar(240_000, 1)];
    const lines = slopeMaLines(
      {
        calcParams: [2],
        extendData: {
          showMa: true,
          mtf: {
            timeframe: "1h",
            htfStarts: [0, 120_000],
            htfMaBaseByLine: [[10, 20]],
            htfMs: 120_000,
          },
        },
      },
      chart,
    );
    // No lookahead: an HTF bar's base is only usable once it CLOSES (open + htfMs).
    // HTF bar 0 (open 0) closes at 120_000 -> first appears there; HTF bar 1
    // (open 120_000) closes at 240_000 -> first appears there.
    expect(lines[0].values).toEqual([undefined, undefined, 10, 10, 20]);
  });
});

describe("slopeLineSeries", () => {
  it("MA→slope→smoothing, price/bar, sma len1 = adjacent diff then smoothed", () => {
    const c = [10, 12, 14, 16, 18].map((v, i) => bar(i * 60_000, v));
    // sma len1 MA = close; priceBar slope n=1 = +2 each bar; smoothing none => 2s
    const raw = slopeLineSeries(c, "sma", 1, 1, "priceBar", "close", { type: "none", length: 3 }, 1);
    expect(raw[4]).toBeCloseTo(2, 10);
    // with sma-2 smoothing the 2s stay 2 (constant), but the first slope bar drops
    const sm = slopeLineSeries(c, "sma", 1, 1, "priceBar", "close", { type: "sma", length: 2 }, 1);
    expect(sm[4]).toBeCloseTo(2, 10);
    expect(sm[1]).toBeUndefined(); // slope bar1 exists(2) but sma-2 needs 2 → undefined
  });
});

describe("accelSeries", () => {
  it("is undefined for the first n2 bars", () => {
    const out = accelSeries([1, 2, 3, 4], 2, 1, false);
    expect(out[0]).toBeUndefined();
    expect(out[1]).toBeUndefined();
    expect(out[2]).toBe(1); // (3-1)/2
    expect(out[3]).toBe(1); // (4-2)/2
  });

  it("uses an absolute difference, so a zero-crossing slope stays finite", () => {
    // A percentage-style (v-prev)/|prev| would divide by 0 here and blow up.
    const out = accelSeries([-1, 0, 1], 1, 1, false);
    expect(out[1]).toBe(1);
    expect(out[2]).toBe(1);
    expect(Number.isFinite(out[2]!)).toBe(true);
  });

  it("divides by barHours when perHour is true", () => {
    // slope goes 0 -> 4 over n2=2 bars of 2h each = 4 hours -> 1 per hour
    const out = accelSeries([0, 2, 4], 2, 2, true);
    expect(out[2]).toBe(1);
  });

  it("does not divide by barHours when perHour is false", () => {
    const out = accelSeries([0, 2, 4], 2, 2, false);
    expect(out[2]).toBe(2); // (4-0)/2 bars
  });

  it("propagates undefined gaps", () => {
    const out = accelSeries([1, undefined, 3, 4], 1, 1, false);
    expect(out[1]).toBeUndefined();
    expect(out[2]).toBeUndefined(); // prev is undefined
    expect(out[3]).toBe(1);
  });

  it("returns all-undefined for a non-positive period instead of reading the future", () => {
    expect(accelSeries([1, 2, 3], -2, 1, false)).toEqual([undefined, undefined, undefined]);
    expect(accelSeries([1, 2, 3], 0, 1, false)).toEqual([undefined, undefined, undefined]);
  });
});

describe("SLOPE_ACCEL_TEMPLATE", () => {
  it("labels figures as Accel per configured length", () => {
    const figs = SLOPE_ACCEL_TEMPLATE.regenerateFigures!([9, 21]) as Array<{ key: string; title: string }>;
    expect(figs[0]).toMatchObject({ key: "slope0", title: "Accel 9: " });
    expect(figs[1]).toMatchObject({ key: "slope1", title: "Accel 21: " });
    // Threshold auto-scale figures are appended, title-less.
    expect(figs.slice(2).map((f) => f.key)).toEqual(["thHi", "thLo"]);
  });

  it("computes acceleration, not slope", () => {
    const candles = Array.from({ length: 40 }, (_, i) => ({
      timestamp: i * 3_600_000,
      open: 100 + i, high: 100 + i, low: 100 + i, close: 100 + i, volume: 1,
    }));
    const ind = { calcParams: [5], extendData: { slopePeriod: 2, accelPeriod: 2, units: "pctBar" } };
    const out = SLOPE_ACCEL_TEMPLATE.calc(candles as never, ind as never) as Array<Record<string, number | undefined>>;
    const expected = accelLineSeries(candles as never, "ema", 5, 2, 2, "pctBar", undefined, undefined, undefined, 1);
    expect(out.map((p) => p.slope0)).toEqual(expected);
  });
});

describe("accel on native HTF bars", () => {
  it("accel on native HTF bars differs from diffing the aligned slope", () => {
    // Alignment forward-fills, so diffing AFTER aligning reads 0 inside a bucket.
    const nativeSlope = [1, 2, 3, 4];
    const nativeAccel = accelSeries(nativeSlope, 1, 1, false);
    expect(nativeAccel).toEqual([undefined, 1, 1, 1]);
    // The same series aligned onto 2 chart bars per HTF bar, then diffed.
    const aligned = [1, 1, 2, 2, 3, 3, 4, 4];
    const wrong = accelSeries(aligned, 1, 1, false);
    expect(wrong).toEqual([undefined, 0, 1, 0, 1, 0, 1, 0]);
    // The zeros are the bug this stash exists to avoid.
    expect(wrong).not.toEqual([undefined, 1, 1, 1, 1, 1, 1, 1]);
  });
});

describe("slopeLineSeries maType", () => {
  const vb = (t: number, c: number, v: number): KLineData =>
    ({ timestamp: t * 60_000, open: c, high: c, low: c, close: c, volume: v }) as KLineData;
  const candles = [vb(0, 10, 1), vb(1, 20, 2), vb(2, 30, 3), vb(3, 40, 4), vb(4, 50, 5)];
  it("computes the slope of an EVWMA base when maType is evwma", async () => {
    const { maSeries } = await import("../mtf");
    const base = maSeries(candles, "evwma", 2).base;
    const line = slopeLineSeries(candles, "evwma", 2, 1, "priceBar", undefined, undefined, 1);
    // priceBar slope over 1 bar is just the base's first difference.
    expect(line[3]).toBeCloseTo((base[3] as number) - (base[2] as number), 10);
    expect(line[1]).toBeUndefined(); // base[0] is undefined during warm-up
  });
});
