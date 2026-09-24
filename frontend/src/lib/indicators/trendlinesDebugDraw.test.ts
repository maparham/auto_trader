import { describe, expect, it, vi } from "vitest";
import {
  candidateLook, DBG_FAILED_DASH, DBG_KEY_PREFIX, DBG_OUTRANKED_DASH, debugGroupOf, paintDebug, reasonTag,
} from "./trendlinesDebugDraw";
import { runDebugSync } from "./trendlinesDebug";
import { explain } from "./trendlinesDebugExplain";
import { debugState } from "./trendlinesDebugStore";
import { TRENDLINES_DEFAULTS } from "./trendlinesOutputs";
import { synthBars } from "./trendlinesSynth.testutil";
import { projectAt, TRENDLINES_TEMPLATE } from "./trendlines";
import { hitTrendline } from "./trendlineMarks";

const bars = synthBars(900);
const res = explain(runDebugSync({
  bars, cfg: { ...TRENDLINES_DEFAULTS, maxLines: 1, maxSlopeAtr: 0.03 }, startIdx: 0,
  evalIdx: bars.length - 1, window: [0, bars.length - 1], forced: [],
}));

/** Records every stroke's dash and color so tests can assert "no hue". */
function recCtx() {
  const strokes: Array<{ dash: number[]; color: string }> = [];
  let dash: number[] = [];
  const ctx = {
    strokeStyle: "#123456", fillStyle: "#123456", globalAlpha: 1, lineWidth: 1, font: "", textAlign: "left",
    textBaseline: "middle", lineCap: "butt",
    save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, arc() {}, fill() {},
    closePath() {}, rect() {}, clip() {},
    setLineDash(d: number[]) { dash = d; },
    stroke() { strokes.push({ dash, color: String(ctx.strokeStyle) }); },
    fillText() {}, strokeText() {}, measureText: (s: string) => ({ width: s.length * 6 }),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, strokes };
}

const paint = (over = {}) => {
  const { ctx, strokes } = recCtx();
  const segs = paintDebug({
    ctx, lineColor: "#123456", xAt: (j) => j, xAtPivot: (j) => j, yPx: (p) => p / 100,
    width: 1000, height: 1000, tagRight: 990, target: null, ...over,
  }, res, new Set());
  return { segs, strokes };
};

describe("debug paint", () => {
  it("failed lines are dotted, outranked are dashed", () => {
    const failed = res.candidates.find((c) => !c.drawn && !c.outranked)!;
    const out = res.candidates.find((c) => c.outranked)!;
    expect(candidateLook(failed, false, false).dash).toEqual(DBG_FAILED_DASH);
    expect(candidateLook(out, false, false).dash).toEqual(DBG_OUTRANKED_DASH);
  });
  it("uses the instance color only: no hue anywhere", () => {
    const { strokes } = paint();
    expect(strokes.length).toBeGreaterThan(0);
    for (const s of strokes) expect(s.color).toBe("#123456");
  });
  it("records a dbg: hit segment per sampled non-drawn candidate on screen", () => {
    const { segs } = paint();
    expect(segs.every((s) => s.key.startsWith(DBG_KEY_PREFIX))).toBe(true);
    expect(segs.length).toBe(res.candidates.filter((c) => !c.drawn && c.shown).length);
    // The fixture is a wall: sampling actually cut something.
    expect(res.candidates.some((c) => !c.shown)).toBe(true);
  });
  it("an expanded group paints every candidate in it", () => {
    const big = res.counts.find((g) => g.n > g.shown)!;
    const { segs } = paint({ expanded: new Set([big.group]) });
    const want = res.candidates.filter((c) => !c.drawn && (c.shown || debugGroupOf(c) === big.group)).length;
    expect(segs.length).toBe(want);
  });
  it("with a target, only its matches paint, the closest lit as selected", () => {
    const pool = res.candidates.filter((c) => !c.drawn);
    const keys = new Set([pool[pool.length - 1].key, pool[pool.length - 2].key]);
    const closest = DBG_KEY_PREFIX + pool[pool.length - 1].key;
    const { segs, strokes } = paint({ matchKeys: keys, highlightKey: closest });
    expect(segs.map((s) => s.key).sort()).toEqual([...keys].map((k) => DBG_KEY_PREFIX + k).sort());
    // Selected look (solid) on the lit one: more solid strokes than unlit.
    const solid = (xs: typeof strokes) => xs.filter((x) => x.dash.length === 0).length;
    expect(solid(strokes)).toBeGreaterThan(solid(paint({ matchKeys: keys }).strokes));
  });
  it("the selected candidate paints even when sampling cut it", () => {
    const cut = res.candidates.find((c) => !c.drawn && !c.shown)!;
    const { segs } = paint({ selectedKey: DBG_KEY_PREFIX + cut.key });
    expect(segs.some((s) => s.key === DBG_KEY_PREFIX + cut.key)).toBe(true);
  });
  it("a layer switched off in the Debug tab does not paint; the selected line still does", () => {
    const out = res.candidates.find((c) => !c.drawn && c.outranked && c.shown)!;
    const noOut = paint({ show: { failed: true, outranked: false, forced: true } });
    expect(noOut.segs.some((s) => s.key === DBG_KEY_PREFIX + out.key)).toBe(false);
    expect(noOut.segs.length).toBeGreaterThan(0);
    const none = paint({ show: { failed: false, outranked: false, forced: false } });
    expect(none.segs).toEqual([]);
    const sel = paint({ show: { failed: false, outranked: false, forced: false }, selectedKey: DBG_KEY_PREFIX + out.key });
    expect(sel.segs.map((s) => s.key)).toEqual([DBG_KEY_PREFIX + out.key]);
  });
  it("To drawing: a debug line clones to a segment lying on the line", () => {
    const pointsFor = (ja: number, pa: number, jb: number, pb: number) =>
      [{ timestamp: bars[ja].timestamp, value: pa }, { timestamp: bars[jb].timestamp, value: pb }];
    const { segs } = paint({ pointsFor });
    const seg = segs[0];
    const cand = res.byKey.get(seg.key.slice(DBG_KEY_PREFIX.length))!;
    const c = seg.clone()!;
    expect(c.tool).toBe("segment");
    for (const pt of c.points) {
      const idx = bars.findIndex((b) => b.timestamp === pt.timestamp);
      expect(pt.value).toBeCloseTo(projectAt(cand.line, idx), 6);
    }
    expect(c.points[0].timestamp).toBeLessThan(c.points[1].timestamp);
    // No pointsFor (a caller that cannot map bars): nothing to clone.
    expect(paint().segs[0].clone()).toBeNull();
  });
  it("hidden groups are not painted", () => {
    const { ctx } = recCtx();
    const all = new Set(res.counts.map((g) => g.group));
    expect(paintDebug({
      ctx, lineColor: "#123456", xAt: (j) => j, xAtPivot: (j) => j, yPx: (p) => p / 100,
      width: 1000, height: 1000, tagRight: 990, target: null,
    }, res, all)).toHaveLength(0);
  });
  it("hiding one group hides exactly the lines explain tallied under it", () => {
    for (const { group, n } of res.counts) {
      if (group === "drawn") continue;
      const { ctx } = recCtx();
      const segs = paintDebug({
        ctx, lineColor: "#123456", xAt: (j) => j, xAtPivot: (j) => j, yPx: (p) => p / 100,
        width: 1000, height: 1000, tagRight: 990, target: null,
      }, res, new Set([group]));
      const shownIn = res.candidates.filter((c) => !c.drawn && c.shown && debugGroupOf(c) === group).length;
      expect(n).toBeGreaterThanOrEqual(shownIn);
      expect(segs.length).toBe(res.candidates.filter((c) => !c.drawn && c.shown).length - shownIn);
      for (const s of segs)
        expect(debugGroupOf(res.byKey.get(s.key.slice(DBG_KEY_PREFIX.length))!)).not.toBe(group);
    }
  });
  it("reason tags are short and em-dash free", () => {
    for (const c of res.candidates) {
      const t = reasonTag(c);
      expect(t.length).toBeLessThanOrEqual(24);
      expect(t).not.toMatch(/—|--/);
    }
  });
  it("an Extend Left candidate paints from its start, not its first anchor", () => {
    const base = res.candidates.find((c) => !c.drawn && c.shown && c.line.i1 >= 20)!;
    const i0 = base.line.i1 - 15;
    const c = { ...base, line: { ...base.line, i0 } };
    const { ctx } = recCtx();
    const segs = paintDebug({
      ctx, lineColor: "#123456", xAt: (j) => j, xAtPivot: (j) => j, yPx: (p) => p / 100,
      width: 1000, height: 1000, tagRight: 990, target: null,
    }, { ...res, candidates: [c] }, new Set());
    expect(segs).toHaveLength(1);
    expect(segs[0].x0).toBe(i0);
    expect(segs[0].y0).toBeCloseTo(projectAt(c.line, i0) / 100, 9);
  });

  it("a live candidate runs on to the live edge; an ended one stops", () => {
    const live = res.candidates.find((c) => !c.drawn && c.shown && c.end === res.evalIdx)!;
    const ended = res.candidates.find((c) => !c.drawn && c.shown && c.end < res.evalIdx)!;
    const edge = res.evalIdx + 3.5;
    const { ctx } = recCtx();
    const segs = paintDebug({
      ctx, lineColor: "#123456", xAt: (j) => j / 2, xAtPivot: (j) => j / 2, yPx: (p) => p / 100,
      width: 1000, height: 1000, tagRight: 990, target: null, liveEdge: edge,
    }, { ...res, candidates: [live, ended] }, new Set());
    const byKey = new Map(segs.map((s) => [s.key.slice(DBG_KEY_PREFIX.length), s]));
    expect(byKey.get(live.key)!.x1).toBeCloseTo(edge / 2, 6);
    expect(byKey.get(ended.key)!.x1).toBeCloseTo(ended.end / 2, 6);
  });

  it("paints debug when nothing is drawn", async () => {
    const calcParams = Object.values({ ...TRENDLINES_DEFAULTS, minTouches: 99 });
    const ext = { debug: true };
    const chartStub = {
      getDataList: () => bars,
      getSize: () => ({ width: 60 }),
      getVisibleRange: () => ({ from: 0, to: bars.length - 1 }),
      overrideIndicator: vi.fn(),
    };
    const draw = () => {
      const { ctx } = recCtx();
      const result = TRENDLINES_TEMPLATE.calc!(bars, { calcParams, extendData: ext } as never);
      TRENDLINES_TEMPLATE.draw!({
        ctx, chart: chartStub,
        indicator: { result, calcParams, extendData: ext, paneId: "candle_pane", name: "TL_DBG" },
        bounding: { width: 1000, height: 1000 },
        xAxis: { convertToPixel: (i: number) => i, convertFromPixel: (x: number) => x },
        yAxis: { convertToPixel: (p: number) => 1000 - p / 100, convertFromPixel: (y: number) => (1000 - y) * 100 },
      } as never);
    };
    draw(); // starts the async run
    await vi.waitFor(() => expect(chartStub.overrideIndicator).toHaveBeenCalled());
    draw(); // paints the landed result
    // The draw's own landed result, so the probed candidate is the one drawn.
    const landed = debugState(chartStub, "TL_DBG").result!;
    expect(landed.candidates.some((x) => x.drawn)).toBe(false);
    const c = landed.candidates.find((x) => !x.drawn && x.shown && x.end > x.line.i1)!;
    const x = (c.line.i1 + c.end) / 2;
    expect(hitTrendline(chartStub, x, 1000 - projectAt(c.line, x) / 100, 6)?.seg.key.startsWith("dbg:")).toBe(true);
  });
});
