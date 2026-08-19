// Trendlines under a timeframe pin: the detector runs on the HIGHER timeframe's
// own bars (in the coordinator), and everything here is what the chart does with
// the result — align the operand series onto chart bars without lookahead, and
// draw lines whose indices count HTF bars onto a pane whose x axis counts chart
// bars.
import type { KLineData } from "klinecharts";
import { describe, expect, it } from "vitest";
import {
  alignMtfTrendlines,
  lineKey,
  TRENDLINES_TEMPLATE,
  type TrendLine,
  type TrendlinesCalcPoint,
  type TrendlinesMtf,
} from "./trendlines";

const T0 = 1_700_000_000_000;
const CHART_MS = 900_000; // 15m chart bars
const HTF_MS = 3_600_000; // 1h pin, i.e. 4 chart bars per HTF bar

const bar = (t: number, price = 100): KLineData =>
  ({ timestamp: t, open: price, high: price, low: price, close: price, volume: 1 }) as KLineData;

/** 40 chart bars: ten whole HTF bars' worth. */
const chartBars = (n = 40): KLineData[] =>
  Array.from({ length: n }, (_, i) => bar(T0 + i * CHART_MS));

const htfStarts = (n = 10): number[] =>
  Array.from({ length: n }, (_, i) => T0 + i * HTF_MS);

/** A resistance line on the HTF bars: 110 at HTF bar 1, falling 2 per HTF bar. */
const htfLine: TrendLine = {
  side: "resistance",
  i1: 1,
  p1: 110,
  i2: 3,
  p2: 106,
  touches: 2,
  touchIdxs: [1, 3],
  lastTouchIdx: 3,
  brokenIdx: null,
};

const stash = (over: Partial<TrendlinesMtf> = {}): TrendlinesMtf => ({
  timeframe: "HOUR",
  htfStarts: htfStarts(),
  htfMs: HTF_MS,
  htfResistance: htfStarts().map((_, i) => 110 - 2 * (i - 1)),
  htfLines: [htfLine],
  htfAtr: 2,
  ...over,
});

// Every gate wide open except the ones the fixture needs, so a line two HTF
// bars long is major: the defaults ask for 20 bars of span, which no small
// fixture can reach in HTF bars.
const PARAMS = [1, 0.25, 0.75, 2, 1, 250, 30, 20, 0, 0, 20, 0, 0, 0, 0, 0];

describe("alignMtfTrendlines", () => {
  it("hands each chart bar the newest HTF bar that had CLOSED by then", () => {
    const bars = chartBars(12);
    const out = alignMtfTrendlines(bars, stash());
    // HTF bar 0 opens at T0 and closes an hour later, i.e. at chart bar 4. The
    // first four chart bars are inside it and must see nothing: a value there
    // would be this bar's own future.
    expect(out.slice(0, 4).map((p) => p.tl_resistance)).toEqual([
      undefined, undefined, undefined, undefined,
    ]);
    expect(out[4].tl_resistance).toBe(112); // HTF bar 0's value
    expect(out[7].tl_resistance).toBe(112); // still inside HTF bar 1
    expect(out[8].tl_resistance).toBe(110); // HTF bar 1 has closed
  });

  it("carries the lines, the HTF ATR and the HTF bar the last row read", () => {
    const out = alignMtfTrendlines(chartBars(), stash());
    const last = out[out.length - 1];
    expect(last.lines).toEqual([htfLine]);
    // The merge and near-price tolerances are ATR-denominated, so this must be
    // the HIGHER timeframe's ATR, not the chart's.
    expect(last.atr).toBe(2);
    // Chart bar 39 opens at T0 + 9.75h, so HTF bar 8 (closing at T0 + 9h) is
    // the newest closed one; bar 9 closes in this bar's future.
    expect(last.lineIdx).toBe(8);
    // No row but the last carries the list, exactly as the chart-TF path does.
    expect(out[0].lines).toBeUndefined();
  });

  it("draws nothing before the first HTF bar closes", () => {
    // Two chart bars: the pin is set but no HTF bar has completed inside the
    // loaded window, so there is no bar to measure the lines at.
    const out = alignMtfTrendlines(chartBars(2), stash());
    expect(out[out.length - 1].lineIdx).toBe(-1);
  });
});

describe("TRENDLINES_TEMPLATE.calc under a pin", () => {
  it("reads the stash instead of running the detector on the chart bars", () => {
    // Flat bars: the detector finds no pivots at all, so any line in the result
    // can only have come from the higher timeframe.
    const bars = chartBars();
    const out = TRENDLINES_TEMPLATE.calc!(bars, {
      calcParams: PARAMS,
      extendData: { mtf: stash() },
    } as never) as TrendlinesCalcPoint[];
    expect(out[out.length - 1].lines).toEqual([htfLine]);
    expect(out[out.length - 1].tl_resistance).toBe(96); // HTF bar 8
  });

  it("ignores a stash with no series behind it", () => {
    // A pin whose fetch has not landed yet stores the timeframe alone. Falling
    // through to the chart-TF detector is what keeps the pane painted meanwhile.
    const out = TRENDLINES_TEMPLATE.calc!(chartBars(), {
      calcParams: PARAMS,
      extendData: { mtf: { timeframe: "HOUR" } },
    } as never) as TrendlinesCalcPoint[];
    expect(out[out.length - 1].lineIdx).toBe(39);
  });
});

interface Seg { x0: number; y0: number; x1: number; y1: number }

/** Draw with an identity viewport: x pixel = CHART bar index, y = 400 - price,
 * so a recorded segment reads back as (chart bar, price) and every mark lands
 * inside the pane (the draw path drops marks outside it). */
function draw(bars: KLineData[], mtf: TrendlinesMtf) {
  const segments: Seg[] = [];
  const rings: Array<{ x: number; y: number }> = [];
  let cur = { x: 0, y: 0 };
  let width = 1;
  const ctx = {
    font: "", textBaseline: "", textAlign: "", strokeStyle: "", fillStyle: "",
    globalAlpha: 1,
    get lineWidth() { return width; },
    set lineWidth(v: number) { width = v; },
    save: () => {}, restore: () => {}, beginPath: () => {}, stroke: () => {},
    setLineDash: () => {}, fill: () => {},
    moveTo: (x: number, y: number) => { cur = { x, y }; },
    lineTo: (x: number, y: number) => {
      // The handle glyph strokes heavier than the line; only the lines matter here.
      if (width === 1) segments.push({ x0: cur.x, y0: cur.y, x1: x, y1: y });
      cur = { x, y };
    },
    measureText: (t: string) => ({ width: t.length * 6 }),
    fillText: () => {},
    arc: (x: number, y: number, r: number) => { if (r === 2) rings.push({ x, y }); },
  };
  const ext = { mtf, dedupe: false, nearPrice: false };
  const result = TRENDLINES_TEMPLATE.calc!(bars, { calcParams: PARAMS, extendData: ext } as never);
  TRENDLINES_TEMPLATE.draw!({
    ctx,
    chart: { getDataList: () => bars, getSize: () => ({ width: 0 }) },
    indicator: { result, calcParams: PARAMS, extendData: ext, paneId: "candle_pane", name: "TRENDLINES" },
    bounding: { width: 400, height: 400 },
    xAxis: { convertToPixel: (i: number) => i },
    yAxis: { convertToPixel: (p: number) => 400 - p },
  } as never);
  return { segments, rings };
}

describe("TRENDLINES_TEMPLATE.draw under a pin", () => {
  it("puts an HTF anchor on the chart bar that shares its timestamp", () => {
    const { segments } = draw(chartBars(), stash());
    expect(segments).toHaveLength(1);
    // HTF bar 1 opens at T0 + 1h, which is chart bar 4 — NOT chart bar 1, which
    // is what reading the index straight off the line would give.
    expect(segments[0].x0).toBeCloseTo(4, 6);
    expect(segments[0].y0).toBeCloseTo(400 - 110, 6);
  });

  it("extends past the newest chart bar rather than stopping at it", () => {
    // A ray's far end is maxProjBars HTF bars into the future, i.e. well beyond
    // the loaded chart data. Clamping it onto the last bar would rotate the
    // line, which is why the index map extrapolates instead.
    const { segments } = draw(chartBars(), stash());
    expect(segments[0].x1).toBeGreaterThan(39);
  });

  it("rings each touch ON the drawn segment", () => {
    const { segments, rings } = draw(chartBars(), stash());
    const s = segments[0];
    expect(rings).toHaveLength(2);
    for (const r of rings) {
      const y = s.y0 + ((s.y1 - s.y0) * (r.x - s.x0)) / (s.x1 - s.x0);
      expect(r.y).toBeCloseTo(y, 6);
    }
    // The touches are HTF bars 1 and 3, four chart bars apart.
    expect(rings.map((r) => Math.round(r.x))).toEqual([4, 12]);
  });

  it("draws nothing while no HTF bar has closed", () => {
    expect(draw(chartBars(2), stash()).segments).toHaveLength(0);
  });
});

describe("lineKey under a pin", () => {
  it("keys off the HTF bar timestamps, not the chart bars at those indices", () => {
    const bars = chartBars();
    const starts = htfStarts();
    expect(lineKey(htfLine, bars, starts)).toBe(
      `resistance:${starts[1]}:${starts[3]}`,
    );
    // Without the HTF timestamps the same line keys off chart bars 1 and 3,
    // which is a different line entirely — and a pin that silently rebinds.
    expect(lineKey(htfLine, bars)).not.toBe(lineKey(htfLine, bars, starts));
  });
});
