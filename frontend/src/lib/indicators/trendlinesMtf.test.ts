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
  trendlineIdxMap,
  crossingChartIdx,
  pinnedEndY,
  lineKey,
  TL_PIVOT_ARM,
  TRENDLINES_TEMPLATE,
  type TrendLine,
  type TrendlinesCalcPoint,
  type TrendlinesMtf,
  type TrendPivots,
} from "./trendlines";
import { findTrendlineSegment } from "./trendlineMarks";
import { parseTrendlinesConfig } from "./trendlinesOutputs";

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

/** A descending line on the HTF bars: 110 at HTF bar 1, falling 2 per HTF bar,
 * anchored on two highs. */
const htfLine: TrendLine = {
  i1: 1,
  p1: 110,
  k1: "high",
  i2: 3,
  p2: 106,
  k2: "high",
  touches: 2,
  touchIdxs: [1, 3],
  touchKinds: ["high", "high"],
  lastTouchIdx: 3,
  crossings: 0,
  crossIdxs: [],
  lastSign: 0,
  maxTouchGap: 2,
  minTouchGap: 2,
  maxTouchIdx: 3,
};

/** One high pivot at HTF bar 1, which turned at 110, a price no CHART bar
 * ever traded at (they are all 100), so a mark painted at the chart bar's
 * own high would be visibly wrong. */
const HTF_PIVOTS: TrendPivots = {
  idxs: [1],
  kinds: ["high"],
  highs: htfStarts().map((_, i) => (i === 1 ? 110 : 100)),
  lows: htfStarts().map(() => 100),
};

const stash = (over: Partial<TrendlinesMtf> = {}): TrendlinesMtf => ({
  timeframe: "HOUR",
  htfStarts: htfStarts(),
  htfMs: HTF_MS,
  htfOutputs: ["tl_1"],
  htfPoints: htfStarts().map((_, i) => ({ tl_1: 110 - 2 * (i - 1) })),
  htfLines: [htfLine],
  htfAtr: 2,
  ...over,
});

// Every gate wide open except the ones the fixture needs, so a line two HTF
// bars long is major: the defaults ask for 20 bars of span, which no small
// fixture can reach in HTF bars.
const PARAMS = [1, 0.75, 2, 1, 250, 20, 0, 0, 20, 0, 0, 0, 0];

describe("alignMtfTrendlines", () => {
  it("hands each chart bar the newest HTF bar that had CLOSED by then", () => {
    const bars = chartBars(12);
    const out = alignMtfTrendlines(bars, stash());
    // HTF bar 0 opens at T0 and closes an hour later, i.e. at chart bar 4. The
    // first four chart bars are inside it and must see nothing: a value there
    // would be this bar's own future.
    expect(out.slice(0, 4).map((p) => p.tl_1)).toEqual([
      undefined, undefined, undefined, undefined,
    ]);
    expect(out[4].tl_1).toBe(112); // HTF bar 0's value
    expect(out[7].tl_1).toBe(112); // still inside HTF bar 1
    expect(out[8].tl_1).toBe(110); // HTF bar 1 has closed
  });

  it("aligns every output the stash names, not just the first", () => {
    const bars = chartBars(12);
    const twoOutputs = stash({
      htfOutputs: ["tl_1", "tl_nearest"],
      htfPoints: htfStarts().map((_, i) => ({
        tl_1: 110 - 2 * (i - 1),
        tl_nearest: 200 + i,
      })),
    });
    const out = alignMtfTrendlines(bars, twoOutputs);
    // HTF bar 0's row (index 0) is the newest closed one at chart bar 4.
    expect(out[4].tl_1).toBe(112);
    expect(out[4].tl_nearest).toBe(200);
    // HTF bar 1 closes at chart bar 8.
    expect(out[8].tl_1).toBe(110);
    expect(out[8].tl_nearest).toBe(201);
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
    expect(out[36].tl_1).toBe(resAt9);
    expect(out[39].tl_1).toBe(resAt9);
    // History keeps waitClose: bar 8 still reads HTF bar 1, not bar 2.
    expect(out[8].tl_1).toBe(110);
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

  it("re-selects the newest row at the chart's latest close, as the draw does", () => {
    // Max Distance 10%. The line is at 96 on HTF bar 8, which the newest chart
    // bar reads. The stash emitted it at the HTF close (100: 4 away, inside).
    const cfg = parseTrendlinesConfig([...PARAMS, 0, 0, 0, 0, 0, 0, 0, 10]);
    const withClose = (close: number) => {
      const bars = chartBars();
      bars[bars.length - 1] = { ...bars[bars.length - 1], close };
      return alignMtfTrendlines(bars, stash(), cfg);
    };
    // Live price 80: the line is 16 away, past 10% of 80, so it is not drawn
    // and must not be emitted either.
    const far = withClose(80);
    expect(far[far.length - 1].tl_1).toBeUndefined();
    expect(far[far.length - 1].tl_nearest).toBeUndefined();
    expect(far[far.length - 1].lines).toEqual([htfLine]);
    // Live price 95: inside again.
    const near = withClose(95);
    expect(near[near.length - 1].tl_1).toBe(96);
    expect(near[near.length - 1].tl_nearest).toBe(96);
    // Older rows keep the HTF bar's own values.
    expect(far[8].tl_1).toBe(110);
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
    expect(out[out.length - 1].tl_1).toBe(96); // HTF bar 8
  });

  it("emits nothing while the pin's stash has not landed", () => {
    // A pin whose fetch has not landed yet stores the timeframe alone. Running
    // the chart-TF detector meanwhile flashed a pane of chart-timeframe lines
    // under the pin's label on every tab switch, gone once the stash arrived.
    const out = TRENDLINES_TEMPLATE.calc!(chartBars(), {
      calcParams: PARAMS,
      extendData: { mtf: { timeframe: "HOUR" } },
    } as never) as TrendlinesCalcPoint[];
    expect(out).toHaveLength(40);
    expect(out.every((r) => Object.keys(r).length === 0)).toBe(true);
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
  let start = { x: 0, y: 0 };
  let width = 1;
  const ctx = {
    font: "", textBaseline: "", textAlign: "", strokeStyle: "", fillStyle: "",
    globalAlpha: 1,
    get lineWidth() { return width; },
    set lineWidth(v: number) { width = v; },
    save: () => {}, restore: () => {}, beginPath: () => {}, stroke: () => {},
    setLineDash: () => {}, fill: () => {},
    rect: () => {}, clip: () => {},
    moveTo: (x: number, y: number) => { cur = { x, y }; start = { x, y }; },
    lineTo: (x: number, y: number) => {
      // The handle glyph strokes heavier than the line; only the lines matter here.
      if (width === 1) segments.push({ x0: cur.x, y0: cur.y, x1: x, y1: y });
      cur = { x, y };
    },
    // The pivot marks are FILLED triangles, so their closing edge exists only
    // as a closePath. Recorded like any other edge, or a caret would read as
    // two edges here and three on the canvas.
    closePath: () => {
      if (width === 1) segments.push({ x0: cur.x, y0: cur.y, x1: start.x, y1: start.y });
      cur = { ...start };
    },
    measureText: (t: string) => ({ width: t.length * 6 }),
    fillText: () => {},
    strokeText: () => {},
    // Touch rings only (radius TL_TOUCH_RADIUS); the crossing dot is wider.
    arc: (x: number, y: number, r: number) => {
      if (r === 2) rings.push({ x, y });
      else dots.push({ x, y });
    },
  };
  // `xShift` scrolls the view: chart bar i sits at pixel i - xShift.
  const shift = typeof over.xShift === "number" ? over.xShift : 0;
  const ext = { mtf, dedupe: false, nearPrice: false, ...over };
  const result = TRENDLINES_TEMPLATE.calc!(bars, { calcParams: PARAMS, extendData: ext } as never);
  const chart = { getDataList: () => bars, getSize: () => ({ width: 0 }) };
  TRENDLINES_TEMPLATE.draw!({
    ctx,
    chart,
    indicator: { result, calcParams: PARAMS, extendData: ext, paneId: "candle_pane", name: "TRENDLINES" },
    bounding: { width: 400, height: 400 },
    xAxis: { convertToPixel: (i: number) => i - shift, convertFromPixel: (x: number) => x + shift },
    yAxis: { convertToPixel: (p: number) => 400 - p, convertFromPixel: (y: number) => 400 - y },
  } as never);
  return { segments, rings, dots, chart };
}

/** The horizontal pieces of a stepped stroke (risers and carets excluded). */
const flats = (segs: Seg[]) => segs.filter((s) => s.y0 === s.y1 && s.x1 > s.x0);
/** The price a stepped stroke shows over chart position x. */
const stepPriceAt = (segs: Seg[], x: number): number | undefined => {
  const f = flats(segs).find((s) => s.x0 <= x && x <= s.x1);
  return f ? 400 - f.y0 : undefined;
};

describe("TRENDLINES_TEMPLATE.draw under a pin", () => {
  it("draws a coarser pin as one step per HTF bar", () => {
    const { segments } = draw(chartBars(), stash());
    const f = flats(segments);
    // HTF bar 1 is chart bars 4..7, so its step runs from 3.5 to 7.5 at the
    // line's value there (110), then each HTF bar steps down by 2.
    expect(f[0]).toEqual({ x0: 3.5, x1: 7.5, y0: 400 - 110, y1: 400 - 110 });
    expect(f[1]).toEqual({ x0: 7.5, x1: 11.5, y0: 400 - 108, y1: 400 - 108 });
    // A vertical riser joins them.
    expect(segments).toContainEqual({ x0: 7.5, y0: 400 - 110, x1: 7.5, y1: 400 - 108 });
  });

  it("anchor steps equal p1 and p2", () => {
    const { segments } = draw(chartBars(), stash());
    for (const x of [4, 5, 6, 7]) expect(stepPriceAt(segments, x)).toBe(110);
    for (const x of [12, 13, 14, 15]) expect(stepPriceAt(segments, x)).toBe(106);
  });

  it("same price at the same moment on two chart timeframes", () => {
    // The same 1h pin on a 15m chart and on a 30m chart.
    const fine = chartBars();
    const coarse = Array.from({ length: 20 }, (_, i) => bar(T0 + i * 2 * CHART_MS));
    const a = draw(fine, stash()).segments;
    const b = draw(coarse, stash({ chartMs: 2 * CHART_MS })).segments;
    for (let i = 4; i < 40; i++) {
      const k = Math.floor(i / 2); // the 30m candle holding 15m candle i
      expect(stepPriceAt(a, i)).toBeDefined();
      expect(stepPriceAt(a, i)).toBe(stepPriceAt(b, k));
    }
  });

  it("lastbar mode adds the forming step through the newest candle", () => {
    for (const waitClose of [true, false]) {
      const { segments } = draw(chartBars(), stash({ waitClose }), { extend: "lastbar" });
      const f = flats(segments);
      const end = f[f.length - 1];
      // Chart bars 36..39 are HTF bar 9, the one the newest candle is in.
      expect(end.x1).toBe(39.5);
      expect(400 - end.y0).toBe(110 - 2 * (9 - 1));
    }
  });

  it("keeps a double-clicked line's extension when its solid part is scrolled off", () => {
    const key = lineKey(htfLine, chartBars(), htfStarts());
    // The segment stops at chart bar 15; the view starts at chart bar 20.
    const { segments } = draw(chartBars(), stash(), { extend: "segment", extendedLines: [key], xShift: 20 });
    expect(flats(segments).some((f) => f.x1 > 0)).toBe(true);
  });

  it("segment mode ends with the last touch's HTF bar", () => {
    const { segments } = draw(chartBars(), stash(), { extend: "segment" });
    const f = flats(segments);
    expect(f[f.length - 1].x1).toBe(15.5);
  });

  it("anchor before loaded history", () => {
    // History starts at chart bar 8 (HTF bar 2): anchor 1's bar is not loaded.
    const bars = chartBars().slice(8);
    const { segments } = draw(bars, stash());
    // Chart bars 0..3 of this list are HTF bar 2, at the line's value there.
    for (const x of [0, 1, 2, 3]) expect(stepPriceAt(segments, x)).toBe(108);
  });

  it("crossing mark needs a close across its own step", () => {
    // Closes sit at 100.5 throughout. HTF bar 5's step is 102 and bar 6's is
    // 100, so the HTF close changes side at bar 6 only because the line
    // stepped down: no chart candle crossed its own step, so no mark.
    const bars = chartBars().map((b) => bar(b.timestamp, 100.5));
    const crossed = { ...htfLine, crossings: 1, crossIdxs: [6], lastSign: 1 };
    const { dots } = draw(bars, stash({ htfLines: [crossed] }), { showCrossings: true });
    expect(dots).toHaveLength(0);
  });

  it("extends past the newest chart bar rather than stopping at it", () => {
    // A ray's far end is maxProjBars HTF bars into the future, i.e. well beyond
    // the loaded chart data. Clamping it onto the last bar would rotate the
    // line, which is why the index map extrapolates instead.
    const { segments } = draw(chartBars(), stash());
    expect(Math.max(...segments.map((g) => g.x1))).toBeGreaterThan(39);
  });

  it("rings each touch ON its step", () => {
    const { segments, rings } = draw(chartBars(), stash());
    expect(rings).toHaveLength(2);
    for (const r of rings) expect(400 - r.y).toBe(stepPriceAt(segments, r.x));
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
      { showPivots: true, showLinePivots: false },
    );
    // One line (the fixture's) plus the caret's two slanted edges. The base
    // edge spans BOTH arms, so this filter keeps only the slanted pair.
    const arms = segments.filter(
      (s) => s.x0 !== s.x1 && s.y0 !== s.y1 && Math.abs(s.x1 - s.x0) <= TL_PIVOT_ARM,
    );
    expect(arms).toHaveLength(2);
    // HTF bar 1 is chart bar 4, and the caret sits ABOVE the high it marks
    // (smaller y under this viewport).
    for (const a of arms) {
      expect(Math.abs(a.x0 - 4)).toBeLessThanOrEqual(TL_PIVOT_ARM);
      expect(Math.min(a.y0, a.y1)).toBeLessThan(400 - 110);
    }
  });

  it("paints no marks with both pivot-mark settings off", () => {
    const mtf = stash({ htfPivots: HTF_PIVOTS });
    const off = { showPivots: false, showLinePivots: false };
    const { segments } = draw(chartBars(), mtf, off);
    expect(segments.filter((s) => s.x0 !== s.x1 && s.y0 !== s.y1)).toHaveLength(0);
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
    const { segments } = draw(bars, stash({ htfPivots: HTF_PIVOTS }), {
      showPivots: true,
      showLinePivots: false,
    });
    const arms = segments.filter(
      (s) => s.x0 !== s.x1 && s.y0 !== s.y1 && Math.abs(s.x1 - s.x0) <= TL_PIVOT_ARM,
    );
    expect(arms).toHaveLength(2);
    // The tip is shared by both slanted edges — one leaves it, the closing one
    // returns to it — so test the endpoint that IS the tip, not always x0.
    for (const a of arms)
      expect(Math.min(Math.abs(a.x0 - 6), Math.abs(a.x1 - 6))).toBeCloseTo(0, 6);
  });

  it("puts line anchors and touch rings on the chart bars that traded the extremes", () => {
    const bars = chartBars();
    bars[6] = bar(T0 + 6 * CHART_MS, 110); // HTF bar 1's high (anchor 1)
    bars[13] = bar(T0 + 13 * CHART_MS, 106); // HTF bar 3's high (anchor 2)
    const { segments, rings } = draw(bars, stash());
    expect(stepPriceAt(segments, 6)).toBe(110);
    expect(rings.map((r) => Math.round(r.x))).toEqual([6, 13]);
    // Each ring sits on its own pivot's price: the step of its HTF bar.
    expect(rings.map((r) => 400 - r.y)).toEqual([110, 106]);
  });

  it("keeps both anchors' steps when an HTF bar holds fewer chart bars", () => {
    // HTF bar 2 lost half its session (chart bars 8 and 9), as when a
    // market's hours change: anchor 2 (HTF bar 3) opens on chart bar 10.
    const bars = chartBars().filter((_, i) => i !== 8 && i !== 9);
    const { segments } = draw(bars, stash());
    expect(stepPriceAt(segments, 4)).toBe(110);
    expect(stepPriceAt(segments, 8)).toBe(108); // HTF bar 2's two candles
    for (const x of [10, 11, 12, 13]) expect(stepPriceAt(segments, x)).toBe(106);
  });

  it("falls back to the HTF bar's start when its span is not fully loaded", () => {
    // 39 chart bars: HTF bar 9's span (chart bars 36..39) misses its last bar,
    // so the true extreme may be unloaded and the caret stays at the start.
    const bars = chartBars(39);
    bars[37] = bar(T0 + 37 * CHART_MS, 120);
    const pivots: TrendPivots = {
      idxs: [9],
      kinds: ["high"],
      highs: htfStarts().map((_, i) => (i === 9 ? 120 : 100)),
      lows: htfStarts().map(() => 100),
    };
    const { segments } = draw(bars, stash({ htfPivots: pivots }), {
      showPivots: true,
      showLinePivots: false,
    });
    const arms = segments.filter(
      (s) => s.x0 !== s.x1 && s.y0 !== s.y1 && Math.abs(s.x1 - s.x0) <= TL_PIVOT_ARM,
    );
    expect(arms).toHaveLength(2);
    for (const a of arms)
      expect(Math.min(Math.abs(a.x0 - 36), Math.abs(a.x1 - 36))).toBeCloseTo(0, 6);
  });
});

describe("lineKey under a pin", () => {
  it("keys off the HTF bar timestamps, not the chart bars at those indices", () => {
    const bars = chartBars();
    const starts = htfStarts();
    expect(lineKey(htfLine, bars, starts)).toBe(
      `${starts[1]}:${starts[3]}`,
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
    i1: 6,
    p1: 110,
    k1: "high",
    i2: 18,
    p2: 106,
    k2: "high",
    touches: 2,
    touchIdxs: [6, 18],
    touchKinds: ["high", "high"],
    lastTouchIdx: 18,
    crossings: 0,
    crossIdxs: [],
    lastSign: 0,
    maxTouchGap: 12,
    minTouchGap: 12,
    maxTouchIdx: 18,
  };
  const ltfStash = (): TrendlinesMtf => ({
    timeframe: "MINUTE_15",
    htfStarts: ltfStarts(),
    htfMs: LTF_MS,
    htfOutputs: ["tl_1"],
    htfPoints: ltfStarts().map((_, i) => ({ tl_1: 110 - (i - 6) / 3 })),
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

// A stash persisted before `touchKinds` existed (Sept 2026, "sideless
// trendlines") restores lines that carry touchIdxs and no touchKinds at all.
// The draw path reads the kinds to snap an HTF extreme onto its chart candle;
// reading them off `undefined` threw, and ONE throw here aborts the whole
// pane's draw loop, so the chart stopped repainting entirely (pan and zoom
// moved the time axis and nothing else) and a reload restored the same stash.
// A missing kind is not worth a frame for: fall back to the plain time mapping.
describe("TRENDLINES_TEMPLATE.draw with a pre-touchKinds stash", () => {
  const kindless = (): TrendlinesMtf => {
    const line = { ...htfLine } as Partial<TrendLine>;
    delete line.touchKinds;
    return stash({ htfLines: [line as TrendLine] });
  };

  it("draws the line instead of throwing", () => {
    expect(() => draw(chartBars(), kindless())).not.toThrow();
    expect(flats(draw(chartBars(), kindless()).segments).length).toBeGreaterThan(0);
  });

  it("still rings every touch, on the unsnapped bar", () => {
    const { rings } = draw(chartBars(), kindless(), { showPivots: false });
    expect(rings).toHaveLength(htfLine.touchIdxs.length);
  });
});

describe("trendlineIdxMap.toChartClose", () => {
  // 15m chart, 1h pin: HTF bar j opens at chart bar 4j and closes at 4j+3.
  const mtf = (nHtf: number): TrendlinesMtf => ({
    timeframe: "HOUR_1",
    htfMs: HTF_MS,
    htfStarts: Array.from({ length: nHtf }, (_, i) => T0 + i * HTF_MS),
  });

  it("lands on the HTF bar's last chart bar, where toChart lands on its first", () => {
    const { toChart, toChartClose } = trendlineIdxMap(chartBars(40), mtf(10));
    expect(toChart(2)).toBe(8);
    expect(toChartClose(2)).toBe(11);
    expect(toChartClose(0)).toBe(3);
  });

  it("closes the forming HTF bar at the newest loaded bar", () => {
    // 38 chart bars: HTF bar 9 has only two candles so far.
    const { toChartClose } = trendlineIdxMap(chartBars(38), mtf(10));
    expect(toChartClose(9)).toBe(37);
  });

  it("is the identity with no pin, and follows toChart under a finer one", () => {
    const plain = trendlineIdxMap(chartBars(8), undefined);
    expect(plain.toChartClose(5)).toBe(5);
    const finer = trendlineIdxMap(chartBars(8), {
      timeframe: "MIN_5",
      htfMs: 300_000,
      htfStarts: Array.from({ length: 24 }, (_, i) => T0 + i * 300_000),
    });
    expect(finer.toChartClose(7)).toBe(finer.toChart(7));
  });
});

describe("trendlineIdxMap past the pin's newest bar (same timeframe)", () => {
  // A 1D pin on a 1D chart. Trendlines computes on CLOSED pin bars, so on a
  // Monday the pin ends on Friday while the chart already holds Monday's
  // forming candle. Monday is one bar on, not three calendar days: counted as
  // three, the stroke's end took the line's price two bars too far along and
  // the whole line tilted off its anchors (NVDA, Aug 26 low).
  const DAY = 86_400_000;
  const MON = Date.UTC(2026, 10, 2); // Mon 2 Nov 2026
  const weekdays = (n: number): number[] => {
    const out: number[] = [];
    for (let t = MON; out.length < n; t += DAY) {
      const wd = new Date(t).getUTCDay();
      if (wd !== 0 && wd !== 6) out.push(t);
    }
    return out;
  };
  const days = weekdays(6); // Mon..Fri, then next Mon
  const chart = days.map((t) => ({ timestamp: t, open: 1, high: 1, low: 1, close: 1 }) as KLineData);
  const mtf: TrendlinesMtf = { timeframe: "DAY", htfMs: DAY, htfStarts: days.slice(0, 5) };

  it("maps the chart's Monday candle to the bar after Friday", () => {
    const { toLine, toChart } = trendlineIdxMap(chart, mtf);
    expect(toLine(5)).toBeCloseTo(5, 9);
    expect(toChart(5)).toBeCloseTo(5, 9);
  });

  it("keeps the drawn end on the line's own bar count", () => {
    const { toLine } = trendlineIdxMap(chart, mtf);
    expect(trendlineDrawEdge(undefined, 4, toLine, chart.length, true)).toBeCloseTo(5, 9);
  });

  it("maps Monday's candle to the next bar of a FINER pin, not 13 bars on", () => {
    // A 4h pin on the same 1D chart: six closed 4h bars a weekday, the last
    // at Friday 20:00. Monday's daily candle opens where the next 4h bar
    // will, one pin bar on; calendar time made it 52h / 4h = 13.
    const H4 = 4 * 3_600_000;
    const starts = days.slice(0, 5).flatMap((d) => Array.from({ length: 6 }, (_, k) => d + k * H4));
    const finer: TrendlinesMtf = { timeframe: "HOUR_4", htfMs: H4, htfStarts: starts };
    const { toLine, toChart } = trendlineIdxMap(chart, finer);
    expect(toLine(5)).toBeCloseTo(30, 9);
    expect(toChart(30)).toBe(5);
    expect(trendlineDrawEdge(undefined, 29, toLine, chart.length, true)).toBeCloseTo(30, 9);
  });

  const H1 = 3_600_000;
  // NVDA-like session: seven 1h bars a weekday, 14:00..20:00.
  const session = days.slice(0, 5).flatMap((d) => Array.from({ length: 7 }, (_, k) => d + (14 + k) * H1));
  const hourly: TrendlinesMtf = { timeframe: "HOUR", htfMs: H1, htfStarts: session };

  it("counts a session market's own bars per candle, not 24 a day", () => {
    const { toLine, toChart } = trendlineIdxMap(chart, hourly);
    // Monday's candle opens on the bar after Friday 20:00 ...
    expect(toLine(5)).toBeCloseTo(35, 9);
    expect(toChart(35)).toBe(5);
    // ... and each later candle is one session (7 bars) on.
    expect(toLine(7)).toBeCloseTo(49, 9);
    expect(toChart(49)).toBeCloseTo(7, 9);
  });

  it("never runs backwards between the pin's last bar and the next candle", () => {
    for (const pin of [hourly, mtf]) {
      const { toLine } = trendlineIdxMap(chart, pin);
      let prev = -Infinity;
      for (let j = 3; j <= 7; j += 0.05) {
        const v = toLine(j);
        expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
        prev = v;
      }
    }
  });

  it("puts next week's candle one daily bar after Friday on a 1W chart", () => {
    const WEEK = 7 * DAY;
    const weeks = [0, 1, 2, 3].map((w) => MON + w * WEEK);
    const wChart = weeks.map((t) => ({ timestamp: t, open: 1, high: 1, low: 1, close: 1 }) as KLineData);
    // Daily bars Mon..Fri of the first three weeks; week 4 is forming.
    const dStarts = weeks.slice(0, 3).flatMap((w) => [0, 1, 2, 3, 4].map((d) => w + d * DAY));
    const { toLine } = trendlineIdxMap(wChart, { timeframe: "DAY", htfMs: DAY, htfStarts: dStarts });
    expect(toLine(3)).toBeCloseTo(15, 9);
    expect(toLine(4)).toBeCloseTo(20, 9);
  });

  it("keeps a monthly pin on a monthly chart one bar per candle", () => {
    const months = [0, 1, 2, 3, 4].map((m) => Date.UTC(2026, m, 1));
    const mChart = months.map((t) => ({ timestamp: t, open: 1, high: 1, low: 1, close: 1 }) as KLineData);
    const { toLine, toChart } = trendlineIdxMap(mChart, {
      timeframe: "MONTH", htfMs: 30 * DAY, htfStarts: months.slice(0, 4),
    });
    expect(toLine(4)).toBeCloseTo(4, 9);
    expect(toLine(6)).toBeCloseTo(6, 9);
    expect(toChart(6)).toBeCloseTo(6, 9);
  });
});

describe("crossingChartIdx", () => {
  // Flat line at 100 in HTF space; the 1h pin over 15m bars puts HTF bar 2 on
  // chart bars 8..11.
  const flat: TrendLine = {
    i1: 0, p1: 100, k1: "low", i2: 1, p2: 100, k2: "low",
    touches: 2, touchIdxs: [0, 1], touchKinds: ["low", "low"], lastTouchIdx: 1,
    crossings: 1, crossIdxs: [2], lastSign: 1,
    maxTouchGap: 1, minTouchGap: 1, maxTouchIdx: 1,
  };
  const mtf: TrendlinesMtf = {
    timeframe: "HOUR_1",
    htfMs: HTF_MS,
    htfStarts: Array.from({ length: 10 }, (_, i) => T0 + i * HTF_MS),
  };
  const bars = (closes: Record<number, number>): KLineData[] =>
    Array.from({ length: 40 }, (_, i) => bar(T0 + i * CHART_MS, closes[i] ?? 99));

  it("walks back from the HTF close through the run of closes on its side", () => {
    // 9 and 10 sit under the line again: the run ending at 11 starts at 11.
    const flip = bars({ 9: 101, 10: 99, 11: 101 });
    expect(crossingChartIdx(flat, 2, trendlineIdxMap(flip, mtf), flip)).toBe(11);
    const run = bars({ 9: 101, 10: 101, 11: 101 });
    expect(crossingChartIdx(flat, 2, trendlineIdxMap(run, mtf), run)).toBe(9);
  });

  it("crosses into the previous HTF bar when the run started there", () => {
    // Bars 6 and 7 belong to HTF bar 1; a daily candle that closes after the
    // chart's last hour for the day puts the first cut there.
    const data = bars({ 6: 101, 7: 101, 8: 101, 9: 101, 10: 101, 11: 101 });
    expect(crossingChartIdx(flat, 2, trendlineIdxMap(data, mtf), data)).toBe(6);
    // ...but never further back than that bar's open: price above the line
    // since bar 0 shows no cut anywhere near, so there is no mark to draw.
    const long = bars(Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i, 101])));
    expect(crossingChartIdx(flat, 2, trendlineIdxMap(long, mtf), long)).toBeNaN();
  });

  it("never marks a candle that stayed on the old side of the drawn line", () => {
    // The HTF close crossed ABOVE, but the drawn segment sits higher and every
    // chart close in HTF bars 1..2 stayed under it. The old walk-back from the
    // HTF close marked the start of that under-run (bar 4). The cut the eye
    // sees is bar 13, where a close first sits above the drawn line.
    const data = bars({ 13: 101, 14: 101 });
    const drawn = (_c: number, price: number) => (price > 100 ? 1 : -1);
    expect(crossingChartIdx(flat, 2, trendlineIdxMap(data, mtf), data, drawn, 1)).toBe(13);
  });

  it("marks a candle whose range spans the line when no close changed side", () => {
    const data = bars({});
    data[10] = { ...data[10], high: 102 };
    expect(crossingChartIdx(flat, 2, trendlineIdxMap(data, mtf), data, undefined, 1)).toBe(10);
  });

  it("marks the chart candle holding the cut under a pin finer than the chart", () => {
    // 15m pin over 1h bars: HTF bar 9 sits inside chart bar 2.
    const fine: TrendlinesMtf = {
      timeframe: "MINUTE_15",
      htfMs: CHART_MS,
      htfStarts: Array.from({ length: 40 }, (_, i) => T0 + i * CHART_MS),
    };
    const hourly = Array.from({ length: 10 }, (_, i) => bar(T0 + i * HTF_MS, i >= 2 ? 101 : 99));
    expect(crossingChartIdx(flat, 9, trendlineIdxMap(hourly, fine), hourly, undefined, 1)).toBe(2);
  });

  it("falls back to the HTF close bar when no earlier bar got there", () => {
    const data = bars({ 11: 101 });
    expect(crossingChartIdx(flat, 2, trendlineIdxMap(data, mtf), data)).toBe(11);
  });

  it("takes the caller's side test when given, the drawn line's", () => {
    // The projection says bars 9..11 closed above; the drawn segment (a
    // little higher) says only 11 did, so the mark goes to 11.
    const run = bars({ 9: 101, 10: 101, 11: 101 });
    const drawn = (c: number) => (c === 11 ? 1 : -1);
    expect(crossingChartIdx(flat, 2, trendlineIdxMap(run, mtf), run, drawn)).toBe(11);
  });

  it("is the bar itself with no pin", () => {
    const data = bars({});
    expect(crossingChartIdx(flat, 2, trendlineIdxMap(data, undefined), data)).toBe(2);
  });
});

describe("pinnedEndY", () => {
  // Rising line: 100 at HTF bar 0, +10 per HTF bar. Pixels: xAt maps a line
  // index to 10px per bar INSIDE the loaded range [2, 6] but the calendar
  // extrapolation outside it stretches to 20px per bar (nights and weekends
  // counted as bars); y is the price itself.
  const rising: TrendLine = {
    i1: 0, p1: 100, k1: "low", i2: 1, p2: 110, k2: "low",
    touches: 2, touchIdxs: [0, 1], touchKinds: ["low", "low"], lastTouchIdx: 1,
    crossings: 0, crossIdxs: [], lastSign: 1,
    maxTouchGap: 1, minTouchGap: 1, maxTouchIdx: 1,
  };
  const xAt = (j: number): number =>
    j < 2 ? 20 + (j - 2) * 20 : j > 6 ? 60 + (j - 6) * 20 : 20 + (j - 2) * 10;
  const yAt = (p: number) => p;

  it("keeps a line whose ends both sit in the loaded range", () => {
    expect(pinnedEndY(rising, 2, 6, xAt(2), xAt(6), 2, 6, xAt, yAt)).toEqual({ y0: 120, y1: 160 });
  });

  it("extends an anchor from before the loaded history along the in-range slope", () => {
    // Anchor at bar 0 is 40px left of the first loaded bar on the stretched
    // map. Its own projection (100) would flatten the line: at bar 6 the
    // slope from (-20, 100) to (60, 160) reads 0.75/px, so bar 4 (x=40) would
    // draw at 145 instead of 140. Along the in-range slope (1/px) the left
    // end instead sits at 80.
    const { y0, y1 } = pinnedEndY(rising, 0, 6, xAt(0), xAt(6), 2, 6, xAt, yAt);
    expect(y1).toBe(160);
    expect(y0).toBe(80);
    expect(y0 + ((y1 - y0) * (40 - xAt(0))) / (xAt(6) - xAt(0))).toBe(140);
  });

  it("does the same past the newest bar", () => {
    const { y0, y1 } = pinnedEndY(rising, 2, 8, xAt(2), xAt(8), 2, 6, xAt, yAt);
    expect(y0).toBe(120);
    expect(y1).toBe(200);
  });

  it("leaves a line entirely outside the loaded range alone", () => {
    expect(pinnedEndY(rising, 7, 9, xAt(7), xAt(9), 2, 6, xAt, yAt)).toEqual({ y0: 170, y1: 190 });
  });
});

describe("alignMtfTrendlines short last intraday bucket", () => {
  // 7H pin on a 1h chart: buckets 00/07/14/21 UTC, the 21:00 one closes at
  // the 00:00 reset. The 00:00 chart bar must read it, and lineIdx must agree
  // with the values (selectDrawnLines' === match).
  const H = 3_600_000;
  const D0 = Date.UTC(2026, 0, 5);
  const starts = [0, 7, 14, 21, 24].map((h) => D0 + h * H);
  const bars = [20, 21, 22, 23, 24].map((h) => bar(D0 + h * H));
  const pin = stash({
    timeframe: "HOUR_7",
    htfMs: 7 * H,
    chartMs: H,
    htfStarts: starts,
    htfPoints: starts.map((_, i) => ({ tl_1: 10 * (i + 1) })),
  });

  it("the 00:00 chart bar reads the 21:00 bucket and lineIdx points at it", () => {
    const out = alignMtfTrendlines(bars, pin);
    expect(out.map((p) => p.tl_1)).toEqual([20, 30, 30, 30, 40]);
    expect(out[out.length - 1].lineIdx).toBe(3);
  });
});

describe("TRENDLINES_TEMPLATE.draw records the line as an alert sees it", () => {
  const segOf = (mtf: TrendlinesMtf) => {
    const { chart } = draw(chartBars(), mtf);
    return findTrendlineSegment(chart, "candle_pane", "TRENDLINES", lineKey(htfLine, chartBars(), htfStarts()));
  };

  it("measures a closed-bar pin at its newest closed HTF bar, per HTF bar", () => {
    // lineIdx is 8 (HTF bar 9 closes in the newest chart bar's future).
    expect(segOf(stash())?.alertLine?.()).toEqual({
      slope: -2, tRef: T0 + 8 * HTF_MS, pRef: 96,
      t1: T0 + HTF_MS, p1: 110, t2: T0 + 3 * HTF_MS, p2: 106,
    });
  });

  it("skips a folded forming HTF bar, so tRef is the newest CLOSED pin bar", () => {
    expect(segOf(stash({ formingIdx: 9 }))?.alertLine?.()).toEqual({
      slope: -2, tRef: T0 + 8 * HTF_MS, pRef: 96,
      t1: T0 + HTF_MS, p1: 110, t2: T0 + 3 * HTF_MS, p2: 106,
    });
  });
});

describe("clone of a stepped line", () => {
  const segOf = (over: Record<string, unknown> = {}) => {
    const { chart } = draw(chartBars(), stash(), over);
    return findTrendlineSegment(chart, "candle_pane", "TRENDLINES", lineKey(htfLine, chartBars(), htfStarts()));
  };

  it("is straight from its drawn start to the newest candle, at the step values", () => {
    const c = segOf()?.clone();
    expect(c?.points).toEqual([
      { timestamp: T0 + 4 * CHART_MS, value: 110 },
      { timestamp: T0 + 39 * CHART_MS, value: 110 - 2 * (9 - 1) },
    ]);
  });

  it("does not change when the view scrolls", () => {
    const at = (xShift: number, extend: string) => segOf({ xShift, extend })?.clone()?.points;
    expect(at(10, "ray")).toEqual(at(0, "ray"));
    expect(at(10, "segment")).toEqual(at(0, "segment"));
  });

  it("ends a segment where its steps end", () => {
    const c = segOf({ extend: "segment" })?.clone();
    expect(c?.points[1]).toEqual({ timestamp: T0 + 15 * CHART_MS, value: 106 });
  });
});

