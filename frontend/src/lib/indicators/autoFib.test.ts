// frontend/src/lib/indicators/autoFib.test.ts
// Pins the causal pair detector: strict fractal pivots at their confirm bar,
// the latest high + latest low as one pair, dir by bar order, the outside-bar
// tie, and the optional ATR swing filter. Same fixtures as the backend suite
// (tests/test_auto_fib.py).
import { describe, it, expect, vi } from "vitest";

vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));

import type { KLineData } from "klinecharts";
import { autoFibSeries, computeAutoFib, computeAutoFibPairs } from "./autoFib";
import { autoFibFibConfig } from "./autoFibOutputs";

/** high = close + 1, low = close - 1, open = close. */
function bar(close: number, i: number, open = close): KLineData {
  return { timestamp: 1700000000000 + i * 3600_000, open, high: close + 1, low: close - 1, close, volume: 1 };
}

/** Repeated cycles trough(100) -> peak -> trough, 8 bars per cycle. */
function triangle(peaks: number[]): KLineData[] {
  const closes: number[] = [];
  for (const p of peaks) {
    const up = (p - 100) / 4;
    closes.push(100, 100 + up, 100 + 2 * up, 100 + 3 * up, p, 100 + 3 * up, 100 + 2 * up, 100 + up);
  }
  closes.push(100);
  return closes.map((c, i) => bar(c, i));
}

const CFG = { pivotLen: 2, minSwingAtr: 0 };

describe("computeAutoFibPairs", () => {
  it("forms the first pair only when both a high and a low have confirmed", () => {
    // Peaks at 4, 12, 20, 28; troughs at 8, 16, 24 (bar 0 has no left window).
    const { pairOf, pairs } = computeAutoFibPairs(triangle([110, 110, 110, 110]), CFG);
    // High at 4 confirms at 6; low at 8 confirms at 10. Nothing before 10.
    expect(pairOf.slice(0, 10).every((p) => p === undefined)).toBe(true);
    // Pair index 0 is a real pair (Review Focus 1).
    expect(pairOf[10]).toBe(0);
    expect(pairs[0]).toEqual({ hiIdx: 4, hiPrice: 111, loIdx: 8, loPrice: 99, dir: -1, startIdx: 10, endIdx: 14 });
  });

  it("replaces the pair at each confirm bar and closes the old one there", () => {
    const { pairOf, pairs } = computeAutoFibPairs(triangle([110, 110, 110, 110]), CFG);
    // High at 12 confirms at 14: new pair, the high is now later (up-leg).
    expect(pairs[1]).toMatchObject({ hiIdx: 12, loIdx: 8, dir: 1, startIdx: 14, endIdx: 18 });
    expect(pairOf[13]).toBe(0);
    expect(pairOf[14]).toBe(1);
    // The last pair is still current.
    expect(pairs[pairs.length - 1].endIdx).toBeNull();
  });

  it("breaks an outside-bar tie by the bar's own colour", () => {
    // Bar 2 is both a strict pivot high and a strict pivot low.
    const flat = (i: number) => bar(100, i);
    const up = [flat(0), flat(1), { ...bar(100, 2), high: 105, low: 95, open: 96, close: 104 }, flat(3), flat(4)];
    const down = [flat(0), flat(1), { ...bar(100, 2), high: 105, low: 95, open: 104, close: 96 }, flat(3), flat(4)];
    const a = computeAutoFibPairs(up, CFG);
    const b = computeAutoFibPairs(down, CFG);
    // One pair, pushed once even though both kinds changed on the same bar.
    expect(a.pairs).toHaveLength(1);
    expect(a.pairs[0].dir).toBe(1); // green: low first, high later
    expect(b.pairs[0].dir).toBe(-1);
    expect(a.pairOf[4]).toBe(0);
  });

  it("filters small swings and waits for ATR when minSwingAtr is on", () => {
    // ATR(14) is first defined at bar 13, so pivots at 4, 8, 12 are rejected.
    // The low at 16 measures against the RAW high turn at 12 and counts; the
    // high at 20 counts against the low at 16. First pair at 20 + 2 = 22.
    const { pairOf, pairs } = computeAutoFibPairs(triangle([110, 110, 110, 110]), {
      pivotLen: 2,
      minSwingAtr: 0.01,
    });
    expect(pairOf[21]).toBeUndefined();
    expect(pairs[0]).toMatchObject({ hiIdx: 20, loIdx: 16, dir: 1, startIdx: 22 });
  });

  it("rejects everything when the filter is larger than any swing", () => {
    const { pairs } = computeAutoFibPairs(triangle([110, 110, 110, 110]), { pivotLen: 2, minSwingAtr: 100 });
    expect(pairs).toEqual([]);
  });
});

describe("autoFibSeries", () => {
  it("emits the active pair's high, low, dir and level prices", () => {
    const bars = triangle([110, 110, 110, 110]);
    const fib = autoFibFibConfig({});
    expect(autoFibSeries(bars, CFG, fib, "high")[10]).toBe(111);
    expect(autoFibSeries(bars, CFG, fib, "low")[10]).toBe(99);
    expect(autoFibSeries(bars, CFG, fib, "dir")[10]).toBe(-1);
    // dir -1: level 0 on the later anchor (the low), level 1 on the high.
    expect(autoFibSeries(bars, CFG, fib, "f0")[10]).toBe(99);
    expect(autoFibSeries(bars, CFG, fib, "f0_5")[10]).toBe(105);
    expect(autoFibSeries(bars, CFG, fib, "f0_5")[9]).toBeUndefined();
    // Not an output of this pane: all undefined.
    expect(autoFibSeries(bars, CFG, fib, "fm0_236").every((v) => v === undefined)).toBe(true);
  });
});

describe("computeAutoFib MTF branch", () => {
  const H = 3600_000;
  const t0 = 1700000000000;
  const flat = Array.from({ length: 12 }, (_, i) => bar(100, i)); // high 101, low 99
  const pairs = [
    { hiTs: t0, hiPrice: 110, loTs: t0 + 4 * H, loPrice: 90, dir: -1 as const },
    { hiTs: t0 + 8 * H, hiPrice: 120, loTs: t0 + 4 * H, loPrice: 90, dir: 1 as const },
  ];
  const mtf = {
    timeframe: "HOUR_4",
    chartMs: H,
    htfMs: 4 * H,
    htfStarts: [t0, t0 + 4 * H, t0 + 8 * H],
    htfFibPairIdx: [0, 0, 1] as Array<number | undefined>,
    htfFibPairs: pairs,
  };

  it("shows pair 0 when it is the only pair on screen (closed bars only)", () => {
    const { points, pairs: out } = computeAutoFib(flat, CFG, { mtf });
    expect(points[3]).toEqual({});
    expect(points[4]).toEqual({ high: 110, low: 90, dir: -1 });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ startIdx: 4, endIdx: null, hiPrice: 110 });
  });

  it("admits the forming bar from its open and closes the previous pair there", () => {
    const { pairs: out } = computeAutoFib(flat, CFG, { mtf: { ...mtf, formingIdx: 2 } });
    expect(out.map((p) => [p.startIdx, p.endIdx])).toEqual([[4, 8], [8, null]]);
  });

  it("snaps an anchor to the chart candle holding the HTF extreme", () => {
    const bars = flat.slice();
    bars[2] = bar(109, 2); // high 110, inside HTF bar 0 (chart bars 0..3)
    const { pairs: out } = computeAutoFib(bars, CFG, { mtf });
    expect(out[0].hiIdx).toBe(2);
    expect(out[0].loIdx).toBe(4); // flat span: ties keep the first bar
  });

  it("treats a null or out-of-range pair index as no pair instead of throwing", () => {
    const idx = [null, 0, 7] as unknown as Array<number | undefined>;
    const { points, pairs: out } = computeAutoFib(flat, CFG, { mtf: { ...mtf, htfFibPairIdx: idx } });
    expect(points[4]).toEqual({});
    expect(points[8]).toEqual({ high: 110, low: 90, dir: -1 });
    expect(out).toHaveLength(1);
  });

  it("snaps only the last 11 mapped pairs (calc runs every tick)", () => {
    // 30 HTF bars, pair p active on HTF bar p; each pair's high trades on the
    // third chart bar of its HTF bar. Pair 29 closes past the loaded bars, so
    // 29 pairs map (0..28) and only 18..28 are snapped.
    const bars = Array.from({ length: 120 }, (_, i) => bar(i % 4 === 2 ? 109 : 100, i));
    const deep = {
      timeframe: "HOUR_4",
      chartMs: H,
      htfMs: 4 * H,
      htfStarts: Array.from({ length: 30 }, (_, p) => t0 + p * 4 * H),
      htfFibPairIdx: Array.from({ length: 30 }, (_, p) => p) as Array<number | undefined>,
      htfFibPairs: Array.from({ length: 30 }, (_, p) => ({
        hiTs: t0 + p * 4 * H, hiPrice: 110, loTs: t0 + p * 4 * H, loPrice: 99, dir: 1 as const,
      })),
    };
    const { pairs: out } = computeAutoFib(bars, CFG, { mtf: deep });
    expect(out).toHaveLength(29);
    expect(out[17].hiIdx).toBe(17 * 4); // unsnapped: first bar of its HTF bar
    expect(out[18].hiIdx).toBe(18 * 4 + 2); // snapped onto the wick
    expect(out[28].hiIdx).toBe(28 * 4 + 2);
  });
});

describe("AUTO_FIB_TEMPLATE draw", () => {
  function fakeCtx() {
    const calls: string[] = [];
    const ctx: Record<string, unknown> = {
      strokeStyle: "", fillStyle: "", lineWidth: 0, font: "", textAlign: "", textBaseline: "", globalAlpha: 1,
      save: () => {}, restore: () => {}, beginPath: () => {}, moveTo: () => {}, lineTo: () => {},
      setLineDash: () => {},
      stroke: () => calls.push(`stroke:${ctx.globalAlpha}`),
      fillText: (t: string) => calls.push(`text:${t}`),
    };
    return { ctx, calls };
  }

  async function paint(pastCount: number, extra: Record<string, unknown> = {}) {
    const { AUTO_FIB_TEMPLATE } = await import("./autoFib");
    const { ctx, calls } = fakeCtx();
    const mk = (s: number, e: number | null) => ({ hiIdx: s - 2, hiPrice: 110, loIdx: s - 4, loPrice: 90, dir: 1, startIdx: s, endIdx: e });
    const result = [{}, { pairs: [mk(10, 20), mk(20, 30), mk(30, null)] }];
    const chart = {
      getDataList: () => new Array(40),
      getSize: () => ({ width: 40 }),
      getIndicators: () => [{ name: "fib", visible: true }],
    };
    (AUTO_FIB_TEMPLATE as { draw: (p: unknown) => boolean }).draw({
      ctx,
      chart,
      indicator: {
        result,
        name: "fib",
        calcParams: [5, 0],
        extendData: { pastCount, ...extra, fib: { levels: [{ value: 0, enabled: true, color: "#111" }, { value: 1, enabled: true, color: "#222" }], extend: "none", reverse: false, trendLine: false, labels: true } },
        paneId: "candle_pane",
        precision: 2,
      },
      bounding: { width: 500, height: 400 },
      xAxis: { convertToPixel: (i: number) => i * 10 },
      yAxis: { convertToPixel: (p: number) => 300 - p },
    });
    return Object.assign(calls, { chart });
  }

  it("draws only the current fib by default, with labels", async () => {
    const calls = await paint(0);
    expect(calls.filter((c) => c.startsWith("stroke:"))).toEqual(["stroke:1", "stroke:1"]);
    expect(calls).toContain("text:0 (110.00)");
  });

  it("records the painted level lines as hit targets", async () => {
    const { hitPaintedLine } = await import("./paintedLines");
    const { chart } = await paint(1);
    // Current fib: level 0 at the high (y 190), x from its low anchor (260)
    // to the last bar (390).
    expect(hitPaintedLine(chart, 300, 192, 6)).toEqual({ paneId: "candle_pane", name: "fib" });
    // Past fib's span (160..300) at its level 1 (y 210).
    expect(hitPaintedLine(chart, 170, 210, 6)?.name).toBe("fib");
    expect(hitPaintedLine(chart, 300, 150, 6)).toBeNull();
  });

  it("glows the current fib when selected, fainter when hovered", async () => {
    const glow = (calls: string[], alpha: number) => calls.filter((c) => c === `stroke:${alpha}`).length;
    expect(glow(await paint(0, { emphasis: "select" }), 0.25)).toBe(2);
    expect(glow(await paint(0, { emphasis: "hover" }), 0.12)).toBe(2);
    expect(glow(await paint(0), 0.25) + glow(await paint(0), 0.12)).toBe(0);
  });

  it("adds pastCount earlier fibs, dimmed and unlabelled", async () => {
    const calls = await paint(1);
    expect(calls.filter((c) => c === "stroke:0.35")).toHaveLength(2);
    expect(calls.filter((c) => c.startsWith("text:"))).toHaveLength(2); // current only
  });
});

describe("Show pivots", () => {
  it("lists every counted pivot, and only counted ones", () => {
    const { pivots } = computeAutoFibPairs(triangle([110, 110, 110, 110]), CFG);
    expect(pivots.slice(0, 3)).toEqual([
      { idx: 4, kind: "high" },
      { idx: 8, kind: "low" },
      { idx: 12, kind: "high" },
    ]);
    // The swing filter drops pivots 4, 8 and 12 (ATR not warm yet).
    const filtered = computeAutoFibPairs(triangle([110, 110, 110, 110]), { pivotLen: 2, minSwingAtr: 0.01 });
    expect(filtered.pivots[0]).toEqual({ idx: 16, kind: "low" });
  });

  it("puts the marks on the last row only when the option is on", () => {
    const bars = triangle([110, 110, 110, 110]);
    expect(computeAutoFib(bars, CFG, {}).marks).toBeUndefined();
    const { marks } = computeAutoFib(bars, CFG, { showPivots: true });
    expect(marks?.idxs.slice(0, 2)).toEqual([4, 8]);
    expect(marks?.highs[4]).toBe(111);
    expect(marks?.lows[8]).toBe(99);
  });

  it("snaps pinned pivots like the anchors and hides one not yet usable", () => {
    const H = 3600_000;
    const t0 = 1700000000000;
    const bars = Array.from({ length: 12 }, (_, i) => bar(100, i));
    bars[2] = bar(109, 2); // high 110 inside HTF bar 0
    const { marks, pairs } = computeAutoFib(bars, CFG, {
      showPivots: true,
      mtf: {
        timeframe: "HOUR_4",
        chartMs: H,
        htfMs: 4 * H,
        htfStarts: [t0, t0 + 4 * H, t0 + 8 * H],
        htfFibPairIdx: [0, 0, 0],
        htfFibPairs: [{ hiTs: t0, hiPrice: 110, loTs: t0 + 4 * H, loPrice: 99, dir: -1 }],
        htfFibPivots: [
          { ts: t0, kind: "high", price: 110 },
          { ts: t0 + 4 * H, kind: "low", price: 99 },
          // Later than the newest usable pair's anchors: not on the chart yet.
          { ts: t0 + 8 * H, kind: "high", price: 101 },
        ],
      },
    });
    expect(marks?.idxs).toEqual([2, 4]);
    expect(pairs[0].hiIdx).toBe(2); // the anchor and its mark agree
  });

  async function paintMarks(showPivots: boolean) {
    const { AUTO_FIB_TEMPLATE } = await import("./autoFib");
    const calls: string[] = [];
    const ctx: Record<string, unknown> = {
      strokeStyle: "", fillStyle: "", lineWidth: 0, font: "", textAlign: "", textBaseline: "", globalAlpha: 1,
      save: () => {}, restore: () => {}, beginPath: () => {}, moveTo: () => {}, lineTo: () => {},
      closePath: () => {}, rect: () => {}, clip: () => {}, setLineDash: () => {}, fillText: () => {},
      stroke: () => calls.push("stroke"),
      fill: () => calls.push("fill"),
    };
    const highs: number[] = [];
    const lows: number[] = [];
    highs[5] = 110;
    lows[8] = 90;
    highs[12] = 105;
    const marks = { idxs: [5, 8, 12], kinds: ["high", "low", "high"], highs, lows };
    const pair = { hiIdx: 5, hiPrice: 110, loIdx: 8, loPrice: 90, dir: -1, startIdx: 10, endIdx: null };
    (AUTO_FIB_TEMPLATE as { draw: (p: unknown) => boolean }).draw({
      ctx,
      chart: { getDataList: () => new Array(20), getSize: () => ({ width: 40 }) },
      indicator: {
        result: [{}, { pairs: [pair], marks }],
        calcParams: [5, 0],
        extendData: { showPivots, fib: { levels: [], extend: "none", reverse: false, trendLine: false, labels: false } },
        paneId: "candle_pane",
        precision: 2,
      },
      bounding: { width: 500, height: 400 },
      xAxis: { convertToPixel: (i: number) => i * 10 },
      yAxis: { convertToPixel: (p: number) => 300 - p },
    });
    return calls;
  }

  it("paints stemmed anchors and plain pivots when on, nothing when off", async () => {
    // The fib strokes come first; the marks are Trendlines' three batches on
    // top: stemmed anchors (fill), major swings (fill, none here) and the
    // plain pivot (stroke).
    const on = await paintMarks(true);
    const off = await paintMarks(false);
    expect(on.slice(off.length)).toEqual(["fill", "fill", "stroke"]);
    expect(off).not.toContain("fill");
  });
});
