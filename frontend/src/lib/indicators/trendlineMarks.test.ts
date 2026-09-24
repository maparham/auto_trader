import type { KLineData } from "klinecharts";
import { describe, expect, it } from "vitest";
import { TRENDLINES_TEMPLATE } from "./trendlines";
import {
  cloneToolFor,
  distToSegment,
  hitTrendline,
  marksFor,
  markedLineStyle,
  toggleMark,
  tsAtIndex,
  TL_BOLD_EXTRA,
  TL_HIDDEN_ALPHA,
  TL_HOVER_GLOW_ALPHA,
  TL_SELECT_GLOW_ALPHA,
} from "./trendlineMarks";

describe("toggleMark", () => {
  it("adds, removes and drops empty lists and epics", () => {
    const a = toggleMark(undefined, "US100", "hidden", "1:2");
    expect(a).toEqual({ US100: { hidden: ["1:2"] } });
    const b = toggleMark(a, "US100", "bold", "3:4");
    expect(b).toEqual({ US100: { hidden: ["1:2"], bold: ["3:4"] } });
    const c = toggleMark(b, "US100", "hidden", "1:2");
    expect(c).toEqual({ US100: { bold: ["3:4"] } });
    expect(toggleMark(c, "US100", "bold", "3:4")).toBeUndefined();
    // Never mutates its input.
    expect(a).toEqual({ US100: { hidden: ["1:2"] } });
  });

  it("keeps each epic's marks apart", () => {
    const m = toggleMark({ GOLD: { hidden: ["1:2"] } }, "US100", "hidden", "1:2");
    expect(marksFor(m, "GOLD").hidden.has("1:2")).toBe(true);
    expect(marksFor(m, "US100").hidden.has("1:2")).toBe(true);
    expect(marksFor(m, "OIL").hidden.size).toBe(0);
    expect(marksFor(null, "US100").bold.size).toBe(0);
  });
});

describe("markedLineStyle", () => {
  const base = { width: 2, alpha: 0.4, opacity: 0.9 };
  it("hidden is a faint hairline with no furniture, and wins over bold", () => {
    expect(markedLineStyle(base, { hidden: true, bold: true })).toEqual({
      width: 1, alpha: TL_HIDDEN_ALPHA, furniture: false,
    });
  });
  it("bold is thicker than the style and skips the dim fade", () => {
    expect(markedLineStyle(base, { hidden: false, bold: true })).toEqual({
      width: 2 + TL_BOLD_EXTRA, alpha: 0.9, furniture: true,
    });
  });
  it("unmarked keeps the style as is", () => {
    expect(markedLineStyle(base, { hidden: false, bold: false })).toEqual({
      width: 2, alpha: 0.4, furniture: true,
    });
  });
});

describe("helpers", () => {
  it("tsAtIndex reads bars and extrapolates past both ends", () => {
    const ts = [1000, 2000, 3000];
    expect(tsAtIndex(ts, 1)).toBe(2000);
    expect(tsAtIndex(ts, 1.4)).toBe(2000);
    expect(tsAtIndex(ts, 5)).toBe(6000);
    expect(tsAtIndex(ts, -1)).toBe(0);
    expect(tsAtIndex([], 0)).toBeNull();
  });
  it("distToSegment clamps to the ends", () => {
    expect(distToSegment(5, 3, 0, 0, 10, 0)).toBe(3);
    expect(distToSegment(13, 4, 0, 0, 10, 0)).toBe(5);
  });
  it("cloneToolFor maps extend modes to drawing tools", () => {
    expect(cloneToolFor("ray")).toBe("rayLine");
    expect(cloneToolFor(undefined)).toBe("rayLine");
    expect(cloneToolFor("extended")).toBe("straightLine");
    expect(cloneToolFor("segment")).toBe("segment");
    expect(cloneToolFor("lastbar")).toBe("segment");
    expect(cloneToolFor("cross")).toBe("segment");
  });
});

// --- through the real draw path ----------------------------------------------

function bar(i: number, low: number, high: number): KLineData {
  const mid = (low + high) / 2;
  return { timestamp: i * 60_000, open: mid, high, low, close: mid, volume: 1 };
}

/** Three rising lows on a flat corridor: one clean support line. */
function dips(): KLineData[] {
  const out = Array.from({ length: 80 }, (_, k) => bar(k, 99.5, 100.5));
  out[20] = bar(20, 90, 100.5);
  out[40] = bar(40, 94, 100.5);
  out[60] = bar(60, 96, 100.5);
  return out;
}

interface Stroke { x0: number; y0: number; x1: number; y1: number; alpha: number; width: number }

// x pixel = bar index, y pixel = 1000 - price * 10 (the trendlines tests' view).
const toY = (p: number) => 1000 - p * 10;
const fromY = (y: number) => (1000 - y) / 10;

function draw(ext: Record<string, unknown>, epic = "US100") {
  const bars = dips();
  const strokes: Stroke[] = [];
  let arcs = 0;
  let texts = 0;
  let cur = { x: 0, y: 0 };
  const ctx = {
    font: "", textBaseline: "", textAlign: "", strokeStyle: "", fillStyle: "",
    globalAlpha: 1, lineWidth: 1, lineDashOffset: 0, lineJoin: "",
    save() {}, restore() {}, beginPath() {}, stroke() {}, fill() {}, rect() {}, clip() {},
    closePath() {}, strokeText() {},
    setLineDash() {},
    moveTo(x: number, y: number) { cur = { x, y }; },
    lineTo(x: number, y: number) {
      strokes.push({ x0: cur.x, y0: cur.y, x1: x, y1: y, alpha: ctx.globalAlpha, width: ctx.lineWidth });
      cur = { x, y };
    },
    arc() { arcs++; },
    measureText: (t: string) => ({ width: t.length * 6 }),
    fillText() { texts++; },
  };
  const chart = {
    getDataList: () => bars,
    getSize: () => ({ width: 60 }),
    getSymbol: () => ({ ticker: epic }),
  };
  const calcParams = [2, 0.75, 2, 5, 250, 1];
  const extendData = {
    extend: "lastbar", dedupe: false, nearPrice: false,
    showPivots: false, showLinePivots: false, ...ext,
  };
  const result = TRENDLINES_TEMPLATE.calc!(bars, { calcParams, extendData } as never);
  TRENDLINES_TEMPLATE.draw!({
    ctx,
    chart,
    indicator: { result, calcParams, extendData, paneId: "candle_pane", name: "TRENDLINES" },
    bounding: { width: 1000, height: 400 },
    xAxis: { convertToPixel: (i: number) => i, convertFromPixel: (x: number) => x },
    yAxis: { convertToPixel: toY, convertFromPixel: fromY },
  } as never);
  return { chart, strokes, arcs, texts, bars };
}

/** The one line's hit target and key, from an unmarked draw. */
function theLine() {
  const d = draw({});
  const { x0, y0, x1, y1 } = d.strokes[0];
  const hit = hitTrendline(d.chart, (x0 + x1) / 2, (y0 + y1) / 2, 6);
  expect(hit, "fixture must draw a hittable line").not.toBeNull();
  return { ...d, hit: hit! };
}

describe("drawTrendlines with marks", () => {
  it("records a hit target on the stroke, and nothing off it", () => {
    const { chart, strokes, hit } = theLine();
    const s = strokes[0];
    expect(hit.paneId).toBe("candle_pane");
    expect(hit.name).toBe("TRENDLINES");
    expect(hitTrendline(chart, s.x0, s.y0 - 40, 6)).toBeNull();
  });

  it("hidden: one faint 1px stroke and no rings or tags", () => {
    const { hit, arcs: arcsBefore } = theLine();
    expect(arcsBefore).toBeGreaterThan(0);
    const d = draw({ lineWidth: 3, lineMarks: { US100: { hidden: [hit.seg.key] } } });
    expect(d.strokes).toHaveLength(1);
    expect(d.strokes[0].alpha).toBe(TL_HIDDEN_ALPHA);
    expect(d.strokes[0].width).toBe(1);
    expect(d.arcs).toBe(0);
    expect(d.texts).toBe(0);
    // Still clickable, so it can be unhidden.
    const s = d.strokes[0];
    expect(hitTrendline(d.chart, (s.x0 + s.x1) / 2, (s.y0 + s.y1) / 2, 6)?.seg.key).toBe(hit.seg.key);
  });

  it("bold: thicker than the instance's own width", () => {
    const { hit } = theLine();
    const d = draw({ lineWidth: 2, lineMarks: { US100: { bold: [hit.seg.key] } } });
    expect(d.strokes[0].width).toBe(2 + TL_BOLD_EXTRA);
  });

  it("marks are per epic", () => {
    const { hit } = theLine();
    const d = draw({ lineMarks: { GOLD: { hidden: [hit.seg.key] } } });
    expect(d.strokes[0].alpha).toBe(1);
    expect(d.arcs).toBeGreaterThan(0);
  });

  it("selected: a wide translucent under-stroke before the line", () => {
    const { hit } = theLine();
    const d = draw({ selectedLine: hit.seg.key });
    expect(d.strokes[0].alpha).toBe(TL_SELECT_GLOW_ALPHA);
    expect(d.strokes[0].width).toBeGreaterThan(d.strokes[1].width);
    expect(d.strokes[1].alpha).toBe(1);
  });

  it("hovered: the same under-stroke, fainter; a pick wins over a hover", () => {
    const { hit } = theLine();
    const d = draw({ hoveredLine: hit.seg.key });
    expect(d.strokes[0].alpha).toBe(TL_HOVER_GLOW_ALPHA);
    expect(d.strokes[0].width).toBeGreaterThan(d.strokes[1].width);
    const both = draw({ hoveredLine: hit.seg.key, selectedLine: hit.seg.key });
    expect(both.strokes[0].alpha).toBe(TL_SELECT_GLOW_ALPHA);
    expect(both.strokes).toHaveLength(d.strokes.length);
  });

  it("emphasized: every line gets the hover glow, a picked one the stronger", () => {
    const { hit } = theLine();
    const d = draw({ emphasized: true });
    expect(d.strokes[0].alpha).toBe(TL_HOVER_GLOW_ALPHA);
    expect(d.strokes[0].width).toBeGreaterThan(d.strokes[1].width);
    const picked = draw({ emphasized: true, selectedLine: hit.seg.key });
    expect(picked.strokes[0].alpha).toBe(TL_SELECT_GLOW_ALPHA);
  });

  it("To drawing: a segment whose two points lie on the drawn stroke", () => {
    const { hit, strokes, bars } = theLine();
    const c = hit.seg.clone();
    expect(c?.tool).toBe("segment");
    const s = strokes[0];
    const yOn = (x: number) => s.y0 + ((s.y1 - s.y0) * (x - s.x0)) / (s.x1 - s.x0);
    for (const p of c!.points) {
      const idx = bars.findIndex((b) => b.timestamp === p.timestamp);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(toY(p.value)).toBeCloseTo(yOn(idx), 6);
    }
    expect(c!.points[0].timestamp).toBe(bars[20].timestamp);
  });

  it("To drawing from a ray is a rayLine", () => {
    const d = draw({ extend: "ray" });
    const s = d.strokes[0];
    const hit = hitTrendline(d.chart, s.x0 + 5, s.y0 + ((s.y1 - s.y0) * 5) / (s.x1 - s.x0), 6);
    expect(hit?.seg.clone()?.tool).toBe("rayLine");
  });
});
