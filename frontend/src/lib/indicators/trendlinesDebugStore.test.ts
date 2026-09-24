import { describe, expect, it, vi } from "vitest";
import { lineKey, projectAt } from "./trendlines";
import { runDebugSync } from "./trendlinesDebug";
import { explain } from "./trendlinesDebugExplain";
import {
  cycleDebugGroup, debugInputFor, debugLookup, debugState, debugTarget, debugWindow, requestDebug, setDebugSim,
  setDebugTarget,
} from "./trendlinesDebugStore";
import { TRENDLINES_DEFAULTS } from "./trendlinesOutputs";
import { synthBars } from "./trendlinesSynth.testutil";

// explain, made to throw on demand: the store must not move any state when it
// does (see "explain throwing ...").
const explainCtl = vi.hoisted(() => ({ fail: false }));
vi.mock("./trendlinesDebugExplain", async (orig) => {
  const m = await orig<typeof import("./trendlinesDebugExplain")>();
  return {
    ...m,
    explain: (...args: Parameters<typeof m.explain>) => {
      if (explainCtl.fail) throw new Error("explain failed");
      return m.explain(...args);
    },
  };
});

const bars = synthBars(800);
const fakeChart = () => ({ overrideIndicator: vi.fn(), getIndicators: () => [] }) as never;

describe("debugInputFor", () => {
  it("chart timeframe: runs on the chart bars from the session floor", () => {
    const inp = debugInputFor(bars, TRENDLINES_DEFAULTS, { tlFloorTs: bars[100].timestamp }, 799, [0, 799]);
    expect("error" in inp).toBe(false);
    expect((inp as { startIdx: number }).startIdx).toBe(100);
  });
  it("mtf without htfBars asks for a timeframe reload", () => {
    const inp = debugInputFor(bars, TRENDLINES_DEFAULTS, {
      mtf: { timeframe: "HOUR_4", htfStarts: [1, 2], htfMs: 1 },
    }, 1, [0, 1]);
    expect(inp).toEqual({ error: "Reload the timeframe to debug." });
  });
  it("mtf with htfBars runs on them", () => {
    const htf = bars.slice(0, 200);
    const inp = debugInputFor(bars, TRENDLINES_DEFAULTS, {
      mtf: { timeframe: "HOUR_4", htfStarts: htf.map((b) => b.timestamp), htfMs: 60_000, htfBars: htf },
    }, 199, [0, 199]);
    expect((inp as { bars: unknown[] }).bars).toBe(htf);
  });
  it("mtf: explain keys a line exactly as the draw does (off htfStarts)", () => {
    const htf = bars.slice(0, 300);
    const htfStarts = htf.map((b) => b.timestamp);
    const inp = debugInputFor(bars, TRENDLINES_DEFAULTS, {
      mtf: { timeframe: "HOUR_4", htfStarts, htfMs: 60_000, htfBars: htf },
    }, 299, [0, 299]);
    expect((inp as { starts?: number[] }).starts).toBe(htfStarts);
    const res = explain(runDebugSync(inp as never));
    expect(res.candidates.length).toBeGreaterThan(0);
    // The draw keys under a pin with lineKey(line, chartDataList, htfStarts).
    for (const c of res.candidates) expect(c.key).toBe(lineKey(c.line, bars, htfStarts));
  });
});

describe("session-only state", () => {
  it("htfBars never persists", async () => {
    const { stripMtfRuntime } = await import("../mtfRuntime");
    const out = stripMtfRuntime({ mtf: { timeframe: "HOUR_4", htfBars: [1] } });
    expect((out.mtf as Record<string, unknown>).htfBars).toBeUndefined();
    expect((out.mtf as Record<string, unknown>).timeframe).toBe("HOUR_4");
  });
});

describe("debugWindow", () => {
  it("buckets so a small pan reuses the same window", () => {
    const id = (j: number) => j;
    expect(debugWindow(1000, 1100, id)).toEqual(debugWindow(1010, 1110, id));
  });
});

describe("requestDebug", () => {
  it("runs async, then repaints with a bumped debugRev", async () => {
    const chart = fakeChart();
    const inp = debugInputFor(bars, TRENDLINES_DEFAULTS, {}, 799, [0, 799]);
    expect(requestDebug(chart, "candle_pane", "TL", inp as never)).toBeNull();
    await vi.waitFor(() => expect(debugState(chart, "TL").result).not.toBeNull());
    expect((chart as { overrideIndicator: ReturnType<typeof vi.fn> }).overrideIndicator).toHaveBeenCalled();
  });
  it("new bars array invalidates the cached result", async () => {
    const chart = fakeChart();
    const inp = debugInputFor(bars, TRENDLINES_DEFAULTS, {}, 799, [0, 799]) as never;
    requestDebug(chart, "candle_pane", "TL", inp);
    await vi.waitFor(() => expect(debugState(chart, "TL").result).not.toBeNull());
    const copy = bars.slice();
    const inp2 = debugInputFor(copy, TRENDLINES_DEFAULTS, {}, 799, [0, 799]) as never;
    expect(requestDebug(chart, "candle_pane", "TL", inp2)).toBeNull();
  });
  it("the target is resolved once per bars array, not per call", () => {
    const chart = fakeChart();
    setDebugTarget(chart, "candle_pane", "TL", { t1: bars[100].timestamp, p1: 1, t2: bars[400].timestamp, p2: 2 });
    const inp = debugInputFor(bars, TRENDLINES_DEFAULTS, {}, 799, [0, 799]) as never;
    const e = debugState(chart, "TL");
    const a = debugTarget(e, inp);
    expect(debugTarget(e, inp)).toBe(a);
  });

  it("setting a target adds forced pairs to the next run", async () => {
    const chart = fakeChart();
    setDebugTarget(chart, "candle_pane", "TL", { t1: bars[100].timestamp, p1: bars[100].low, t2: bars[400].timestamp, p2: bars[400].low });
    const inp = debugInputFor(bars, TRENDLINES_DEFAULTS, {}, 799, [0, 799]) as never;
    requestDebug(chart, "candle_pane", "TL", inp);
    await vi.waitFor(() => expect(debugState(chart, "TL").result).not.toBeNull());
    expect(debugState(chart, "TL").result!.candidates.some((c) => c.origin === "forced" || c.line.i1 === 100)).toBe(true);
  });

  it("a cache hit aborts a pending run for another key", async () => {
    const chart = fakeChart();
    const inpA = debugInputFor(bars, TRENDLINES_DEFAULTS, {}, 799, [0, 799]) as never;
    requestDebug(chart, "candle_pane", "TL", inpA);
    await vi.waitFor(() => expect(debugState(chart, "TL").result).not.toBeNull());
    const e = debugState(chart, "TL");
    const keyA = e.key;
    const resA = e.result;
    const inpB = debugInputFor(bars, TRENDLINES_DEFAULTS, {}, 700, [0, 799]) as never;
    expect(requestDebug(chart, "candle_pane", "TL", inpB)).toBeNull();
    const ctlB = e.pending!.ctl;
    expect(requestDebug(chart, "candle_pane", "TL", inpA)).toBe(resA);
    expect(ctlB.signal.aborted).toBe(true);
    expect(e.pending).toBeNull();
    await new Promise((r) => setTimeout(r, 50));
    expect(e.key).toBe(keyA);
    expect(e.result).toBe(resA);
  });

  it("a run that throws clears pending, so the key can retry", async () => {
    const chart = fakeChart();
    // Holes where bars should be: the run throws reading them.
    const broken = new Array(50) as never[];
    const inp = { bars: broken, cfg: TRENDLINES_DEFAULTS, startIdx: 0, evalIdx: 49, window: [0, 49], forced: [] } as never;
    expect(requestDebug(chart, "candle_pane", "TL", inp)).toBeNull();
    const e = debugState(chart, "TL");
    expect(e.pending).not.toBeNull();
    await vi.waitFor(() => expect(e.pending).toBeNull());
    expect(e.result).toBeNull();
    // Recorded as failed: the same input does not retry on every redraw.
    expect(requestDebug(chart, "candle_pane", "TL", inp)).toBeNull();
    expect(e.pending).toBeNull();
    // Not wedged: a new key starts a fresh run.
    const inp2 = { bars: new Array(60), cfg: TRENDLINES_DEFAULTS, startIdx: 0, evalIdx: 59, window: [0, 59], forced: [] } as never;
    requestDebug(chart, "candle_pane", "TL", inp2);
    expect(e.pending).not.toBeNull();
  });

  it("explain throwing never leaves the new key holding the old result", async () => {
    const chart = fakeChart();
    const inpA = debugInputFor(bars, TRENDLINES_DEFAULTS, {}, 799, [0, 799]) as never;
    requestDebug(chart, "candle_pane", "TL", inpA);
    const e = debugState(chart, "TL");
    await vi.waitFor(() => expect(e.result).not.toBeNull());
    const resA = e.result;
    const inpB = debugInputFor(bars, TRENDLINES_DEFAULTS, {}, 700, [0, 799]) as never;
    explainCtl.fail = true;
    try {
      expect(requestDebug(chart, "candle_pane", "TL", inpB)).toBeNull();
      await vi.waitFor(() => expect(e.pending).toBeNull());
    } finally {
      explainCtl.fail = false;
    }
    const again = requestDebug(chart, "candle_pane", "TL", inpB);
    expect(again).not.toBe(resA);
    expect(again).toBeNull();
    expect(e.result).toBeNull();
  });

  it("a pinned Wait-off refold (new htfBars, a deep-copied htfClosed) keeps the run", async () => {
    const chart = fakeChart();
    const closed = bars.slice(0, 300);
    const fold = (high: number) => [...closed, { ...bars[300], high }];
    const mtf = (htfBars: typeof bars) => ({
      // A fresh copy each fold: klinecharts' merge deep-copies the stash.
      timeframe: "HOUR_4", waitClose: false, htfMs: 60_000, htfClosed: closed.map((c) => ({ ...c })), htfBars,
      htfStarts: htfBars.map((b) => b.timestamp), formingIdx: 300,
    });
    const a = debugInputFor(bars, TRENDLINES_DEFAULTS, { mtf: mtf(fold(bars[300].high)) }, 300, [0, 300]) as never;
    requestDebug(chart, "candle_pane", "TL", a);
    const e = debugState(chart, "TL");
    await vi.waitFor(() => expect(e.result).not.toBeNull());
    const run = e.run;
    const b = debugInputFor(bars, TRENDLINES_DEFAULTS, { mtf: mtf(fold(bars[300].high + 1)) }, 300, [0, 300]) as never;
    expect(requestDebug(chart, "candle_pane", "TL", b)).toBe(e.result);
    expect(e.pending).toBeNull();
    expect(e.run).toBe(run);
  });

  it("a new close re-explains the same run at that close, never re-running it", async () => {
    const chart = fakeChart();
    const cfg = { ...TRENDLINES_DEFAULTS, maxDistAtr: 3 };
    const inp = debugInputFor(bars, cfg, {}, 799, [0, 799], bars[799].close) as never;
    requestDebug(chart, "candle_pane", "TL", inp);
    const e = debugState(chart, "TL");
    await vi.waitFor(() => expect(e.result).not.toBeNull());
    const run = e.run;
    const first = e.result!;
    const moved = bars[799].close * 1.01;
    const inp2 = debugInputFor(bars, cfg, {}, 799, [0, 799], moved) as never;
    expect(requestDebug(chart, "candle_pane", "TL", inp2)).toBe(first);
    expect(e.pending).toBeNull();
    await vi.waitFor(() => expect(e.result!.close).toBe(moved));
    expect(e.run).toBe(run);
    expect(e.input!.evalClose).toBe(moved);
    // Distance is measured against the new close.
    const c = e.result!.candidates.find((x) => x.verdicts.some((v) => v.gate === "distanceAtr"))!;
    const v = c.verdicts.find((x) => x.gate === "distanceAtr")!;
    const atr = e.result!.atr[799] as number;
    expect(v.measured).toBeCloseTo(Math.abs(projectAt(c.line, 799) - moved) / atr);
  });

  it("a run for a new window keeps the previous result up while pending", async () => {
    const chart = fakeChart();
    requestDebug(chart, "candle_pane", "TL", debugInputFor(bars, TRENDLINES_DEFAULTS, {}, 799, [0, 799]) as never);
    const e = debugState(chart, "TL");
    await vi.waitFor(() => expect(e.result).not.toBeNull());
    const prev = e.result;
    const moved = debugInputFor(bars, TRENDLINES_DEFAULTS, {}, 799, [200, 799]) as never;
    expect(requestDebug(chart, "candle_pane", "TL", moved)).toBe(prev);
    expect(e.pending).not.toBeNull();
    expect(requestDebug(chart, "candle_pane", "TL", moved)).toBe(prev);
    // A new target: the old result has none of its forced lines.
    await vi.waitFor(() => expect(e.pending).toBeNull());
    setDebugTarget(chart, "candle_pane", "TL", { t1: bars[100].timestamp, p1: 1, t2: bars[400].timestamp, p2: 2 });
    expect(requestDebug(chart, "candle_pane", "TL", moved)).toBeNull();
    expect(e.pending).not.toBeNull();
    setDebugTarget(chart, "candle_pane", "TL", null);
    // A new cfg is a different chart: no stale result.
    const other = debugInputFor(bars, { ...TRENDLINES_DEFAULTS, minTouches: 3 }, {}, 799, [0, 799]) as never;
    expect(requestDebug(chart, "candle_pane", "TL", other)).toBeNull();
  });

  it("pinned: a lookup point snaps to the HTF bar that CONTAINS it", () => {
    const chart = fakeChart();
    const htf = bars.slice(0, 300);
    const htfStarts = htf.map((b) => b.timestamp);
    const htfMs = htfStarts[1] - htfStarts[0];
    setDebugTarget(chart, "candle_pane", "TL", {
      t1: htfStarts[100] + 0.9 * htfMs, p1: 1, t2: htfStarts[200] + 0.9 * htfMs, p2: 2,
    });
    const inp = debugInputFor(bars, TRENDLINES_DEFAULTS, {
      mtf: { timeframe: "HOUR_4", htfStarts, htfMs, htfBars: htf },
    }, 299, [0, 299]) as never;
    const t = debugTarget(debugState(chart, "TL"), inp)!.tgt;
    expect(t).toMatchObject({ x1: 100, x2: 200 });
  });
});

describe("strip state", () => {
  it("a big group cycles sampled, all, hidden; a small one skips all", () => {
    const chart = fakeChart();
    const e = debugState(chart, "TL");
    const state = (g: string) => (e.hidden.has(g) ? "hidden" : e.expanded.has(g) ? "all" : "sampled");
    const seq: string[] = [];
    for (let k = 0; k < 3; k++) {
      cycleDebugGroup(chart, "candle_pane", "TL", "touches", 112);
      seq.push(state("touches"));
    }
    expect(seq).toEqual(["all", "hidden", "sampled"]);
    cycleDebugGroup(chart, "candle_pane", "TL", "slope", 4);
    expect(state("slope")).toBe("hidden");
    cycleDebugGroup(chart, "candle_pane", "TL", "slope", 4);
    expect(state("slope")).toBe("sampled");
  });

  it("the lookup is computed once per result, target and limits", () => {
    const chart = fakeChart();
    const e = debugState(chart, "TL");
    const res = explain(runDebugSync({
      bars, cfg: TRENDLINES_DEFAULTS, startIdx: 0, evalIdx: 799, window: [0, 799], forced: [],
    }));
    const tgt = { x1: 100, p1: bars[100].low, x2: 400, p2: bars[400].low };
    const a = debugLookup(e, res, tgt);
    expect(debugLookup(e, res, tgt)).toBe(a);
    setDebugSim(chart, "candle_pane", "TL", { priceAtr: 5, spanPct: 0.5 });
    const b = debugLookup(e, res, tgt);
    expect(b).not.toBe(a);
    expect(b.matches.length).toBeGreaterThanOrEqual(a.matches.length);
    expect([...b.keys].sort()).toEqual(b.matches.map((m) => m.cand.key).sort());
  });
});
