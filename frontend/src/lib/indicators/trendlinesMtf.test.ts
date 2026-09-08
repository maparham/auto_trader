// Trendlines under a timeframe pin: the detector runs on the HIGHER timeframe's
// own bars (in the coordinator), and everything here is what the chart does with
// the result — align the operand series onto chart bars without lookahead, and
// draw lines whose indices count HTF bars onto a pane whose x axis counts chart
// bars.
import type { KLineData } from "klinecharts";
import { describe, expect, it } from "vitest";
import {
  alignMtfTrendlines,
  trendlineDrawEdge,
  lineKey,
  TL_PIVOT_ARM,
  TRENDLINES_TEMPLATE,
  type TrendLine,
  type TrendlinesCalcPoint,
  type TrendlinesMtf,
  type TrendPivots,
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
  firstTouchIdx: 1,
};

/** One resistance pivot at HTF bar 1, which turned at 110 — a price no CHART
 * bar ever traded at (they are all 100), so a mark painted at the chart bar's
 * own high would be visibly wrong. */
const HTF_PIVOTS: TrendPivots = {
  resistance: [1],
  support: [],
  highs: htfStarts().map((_, i) => (i === 1 ? 110 : 100)),
  lows: htfStarts().map(() => 100),
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

  it("admits a flagged forming entry from its open, so values reach the newest chart bar", () => {
    // The last HTF entry (index 9, opening at T0+9h) is the FORMING bucket:
    // chart bars 36-39 sit inside it and must read ITS value, not bar 8's.
    const out = alignMtfTrendlines(chartBars(), stash({ formingIdx: 9 }));
    const resAt9 = 110 - 2 * (9 - 1); // the series value stashed for entry 9
    expect(out[36].tl_resistance).toBe(resAt9);
    expect(out[39].tl_resistance).toBe(resAt9);
    // History keeps waitClose: bar 8 still reads HTF bar 1, not bar 2.
    expect(out[8].tl_resistance).toBe(110);
    // The draw path measures at the forming bar — the whole point: line ends
    // reach the newest candle.
    expect(out[out.length - 1].lineIdx).toBe(9);
  });

  it("trendlineDrawEdge runs a forming pin's edge to the newest chart bar, fractionally", () => {
    // 40 chart bars; the newest (index 39, opening T0+9.75h) sits inside the
    // forming HTF entry 9 (opens T0+9h): the draw edge is its LINE-SPACE
    // position, 9.75 HTF bars, so a "lastbar" line ends at the newest candle
    // rather than at the forming bucket's open.
    const toLine = (j: number) => (j * CHART_MS) / HTF_MS; // aligned fixture: exact
    expect(trendlineDrawEdge(9, 9, toLine, 40)).toBeCloseTo(9.75, 10);
    // Waiting mode (no formingIdx): the closed-bar edge stands.
    expect(trendlineDrawEdge(undefined, 8, toLine, 40)).toBe(8);
    // Never pulls backwards: a lastIdx already past the newest bar wins.
    expect(trendlineDrawEdge(9, 12, toLine, 40)).toBe(12);
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
function draw(
  bars: KLineData[],
  mtf: TrendlinesMtf,
  over: Record<string, unknown> = {},
) {
  const segments: Seg[] = [];
  const rings: Array<{ x: number; y: number }> = [];
  const dots: Array<{ x: number; y: number }> = [];
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
    arc: (x: number, y: number, r: number) => {
      if (r === 2) rings.push({ x, y });
      if (r === 2.5) dots.push({ x, y }); // TL_BREAK_RADIUS
    },
  };
  const ext = { mtf, dedupe: false, nearPrice: false, ...over };
  const result = TRENDLINES_TEMPLATE.calc!(bars, { calcParams: PARAMS, extendData: ext } as never);
  TRENDLINES_TEMPLATE.draw!({
    ctx,
    chart: { getDataList: () => bars, getSize: () => ({ width: 0 }) },
    indicator: { result, calcParams: PARAMS, extendData: ext, paneId: "candle_pane", name: "TRENDLINES" },
    bounding: { width: 400, height: 400 },
    xAxis: { convertToPixel: (i: number) => i },
    yAxis: { convertToPixel: (p: number) => 400 - p },
  } as never);
  return { segments, rings, dots };
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

  it("marks a pivot at the HTF bar's own price, not the chart bar's", () => {
    // Every chart bar here trades at 100 and HTF bar 1 turned at 110, so a
    // draw path that looked the price up in the chart's dataList at index 1
    // would land 10 points away — which is exactly why a mark carries its own
    // price instead of only an index.
    const { segments } = draw(
      chartBars(),
      stash({ htfPivots: HTF_PIVOTS }),
    );
    // One line (the fixture's) plus the caret's two arms.
    const arms = segments.filter(
      (s) => s.x0 !== s.x1 && Math.abs(s.x1 - s.x0) <= TL_PIVOT_ARM,
    );
    expect(arms).toHaveLength(2);
    // HTF bar 1 is chart bar 4, and the caret sits ABOVE the high it marks
    // (smaller y under this viewport).
    for (const a of arms) {
      expect(Math.abs(a.x0 - 4)).toBeLessThanOrEqual(TL_PIVOT_ARM);
      expect(Math.min(a.y0, a.y1)).toBeLessThan(400 - 110);
    }
  });

  it("paints no marks when Show pivots is off", () => {
    const mtf = stash({ htfPivots: HTF_PIVOTS });
    expect(draw(chartBars(), mtf, { showPivots: false }).segments).toHaveLength(1);
  });
});

describe("TRENDLINES_TEMPLATE.draw snaps HTF extremes onto their chart bars", () => {
  // An HTF bar spans several chart bars, and its high/low usually trades hours
  // after the bar OPENS. Mapping a pivot to the HTF bar's start put the caret
  // (and the line anchors) at the open's chart bar, floating far off any
  // candle. The snap moves them to the chart bar that traded the extreme.
  it("puts an HTF pivot caret on the chart bar that traded the extreme", () => {
    const bars = chartBars();
    // HTF bar 1 spans chart bars 4..7; its 110 high trades at chart bar 6.
    bars[6] = bar(T0 + 6 * CHART_MS, 110);
    const { segments } = draw(bars, stash({ htfPivots: HTF_PIVOTS }));
    const arms = segments.filter(
      (s) => s.x0 !== s.x1 && Math.abs(s.x1 - s.x0) <= TL_PIVOT_ARM,
    );
    expect(arms).toHaveLength(2);
    // The tip of each arm sits exactly on the pivot's x.
    for (const a of arms) expect(a.x0).toBeCloseTo(6, 6);
  });

  it("puts line anchors and touch rings on the chart bars that traded the extremes", () => {
    const bars = chartBars();
    bars[6] = bar(T0 + 6 * CHART_MS, 110); // HTF bar 1's high (anchor 1)
    bars[13] = bar(T0 + 13 * CHART_MS, 106); // HTF bar 3's high (anchor 2)
    const { segments, rings } = draw(bars, stash());
    expect(segments[0].x0).toBeCloseTo(6, 6);
    expect(segments[0].y0).toBeCloseTo(400 - 110, 6);
    expect(rings.map((r) => Math.round(r.x))).toEqual([6, 13]);
  });

  it("puts the break dot on the chart bar that traded the piercing extreme", () => {
    // The break test pierces on the BAR'S EXTREME (high for resistance), so
    // the chart candle carrying the HTF bar's high is the candle that broke
    // the line. HTF bar 5 spans chart bars 20..23 and its high trades at
    // chart bar 22; the dot used to sit at the span's open, chart bar 20.
    const bars = chartBars();
    bars[6] = bar(T0 + 6 * CHART_MS, 110); // anchor 1's extreme
    bars[13] = bar(T0 + 13 * CHART_MS, 106); // anchor 2's extreme
    bars[22] = bar(T0 + 22 * CHART_MS, 108); // the pierce, well above the line
    const broken: TrendLine = { ...htfLine, brokenIdx: 5 };
    const { dots } = draw(bars, stash({ htfLines: [broken] }));
    expect(dots).toHaveLength(1);
    expect(dots[0].x).toBeCloseTo(22, 6);
  });

  it("falls back to the HTF bar's start when its span is not fully loaded", () => {
    // 39 chart bars: HTF bar 9's span (chart bars 36..39) misses its last bar,
    // so the true extreme may be unloaded and the caret stays at the start.
    const bars = chartBars(39);
    bars[37] = bar(T0 + 37 * CHART_MS, 120);
    const pivots: TrendPivots = {
      resistance: [9],
      support: [],
      highs: htfStarts().map((_, i) => (i === 9 ? 120 : 100)),
      lows: htfStarts().map(() => 100),
    };
    const { segments } = draw(bars, stash({ htfPivots: pivots }));
    const arms = segments.filter(
      (s) => s.x0 !== s.x1 && Math.abs(s.x1 - s.x0) <= TL_PIVOT_ARM,
    );
    expect(arms).toHaveLength(2);
    for (const a of arms) expect(a.x0).toBeCloseTo(36, 6);
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

describe("TRENDLINES_TEMPLATE.draw under a pin FINER than the chart", () => {
  // The inverse pin: 15m lines on a 1h chart. A 15m anchor's timestamp lands
  // INSIDE a chart bar, and interpolating puts it between two candles — the
  // anchor must snap to the candle that contains it instead, or the ring
  // hangs in the gap off the candle's wick.
  const LTF_MS = 900_000; // 15m pin on a 1h chart (CHART_MS above is 15m,
  // so build coarser chart bars here instead)
  const hourBars = (n = 10): KLineData[] =>
    Array.from({ length: n }, (_, i) => bar(T0 + i * HTF_MS));
  const ltfStarts = (n = 40): number[] =>
    Array.from({ length: n }, (_, i) => T0 + i * LTF_MS);
  /** Anchors at 15m bars 6 and 18: T0+1.5h and T0+4.5h, i.e. the MIDDLES of
   * chart bars 1 and 4. */
  const ltfLine: TrendLine = {
    side: "resistance",
    i1: 6,
    p1: 110,
    i2: 18,
    p2: 106,
    touches: 2,
    touchIdxs: [6, 18],
    lastTouchIdx: 18,
    brokenIdx: null,
    firstTouchIdx: 6,
  };
  const ltfStash = (): TrendlinesMtf => ({
    timeframe: "MINUTE_15",
    htfStarts: ltfStarts(),
    htfMs: LTF_MS,
    htfResistance: ltfStarts().map((_, i) => 110 - (i - 6) / 3),
    htfLines: [ltfLine],
    htfAtr: 2,
  });

  it("snaps an intra-bar anchor onto the chart bar that contains it", () => {
    const { segments } = draw(hourBars(), ltfStash());
    expect(segments).toHaveLength(1);
    // T0+1.5h sits inside chart bar 1; interpolation alone would say 1.5.
    expect(segments[0].x0).toBe(1);
  });

  it("rings each touch on a candle, not between two", () => {
    const { rings } = draw(hourBars(), ltfStash());
    expect(rings.map((r) => r.x)).toEqual([1, 4]);
  });

  it("still extends the ray past the newest chart bar", () => {
    const { segments } = draw(hourBars(), ltfStash());
    expect(segments[0].x1).toBeGreaterThan(9);
  });
});
