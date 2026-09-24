import { describe, expect, it } from "vitest";
import { forcedPairsFor, lookup, similarity, targetToIdx, SIM_DEFAULTS } from "./trendlinesDebugLookup";
import { runDebugSync } from "./trendlinesDebug";
import { explain } from "./trendlinesDebugExplain";
import { newSeed, projectAt } from "./trendlines";
import { TRENDLINES_DEFAULTS } from "./trendlinesOutputs";
import { synthBars } from "./trendlinesSynth.testutil";

const bars = synthBars(1200);
const times = bars.map((b) => b.timestamp);

describe("targetToIdx", () => {
  it("snaps to the nearest bar and keeps the user's prices", () => {
    const t = targetToIdx(times, { t1: times[100] + 1000, p1: 1, t2: times[300], p2: 2 });
    expect(t).toEqual({ x1: 100, p1: 1, x2: 300, p2: 2 });
  });
  it("target outside bars gives an error, not a snap", () => {
    const last = times[times.length - 1];
    const t = targetToIdx(times, { t1: times[10], p1: 1, t2: last + 10 * 60_000, p2: 2 });
    expect("error" in t).toBe(true);
  });
  it("containing mode floors to the bar whose span holds the point", () => {
    const step = times[1] - times[0];
    const near = targetToIdx(times, { t1: times[100] + 0.9 * step, p1: 1, t2: times[300], p2: 2 });
    expect(near).toMatchObject({ x1: 101 });
    const cont = targetToIdx(times, { t1: times[100] + 0.9 * step, p1: 1, t2: times[300], p2: 2 }, "containing");
    expect(cont).toMatchObject({ x1: 100, x2: 300 });
    expect("error" in targetToIdx(times, { t1: times[0] - 1, p1: 1, t2: times[3], p2: 2 }, "containing")).toBe(true);
  });
  it("orders the two points left to right", () => {
    const t = targetToIdx(times, { t1: times[300], p1: 2, t2: times[100], p2: 1 });
    expect(t).toEqual({ x1: 100, p1: 1, x2: 300, p2: 2 });
  });
});

describe("similarity", () => {
  const line = newSeed(100, 50_000, "low", 300, 50_200, "low");
  const atr = bars.map(() => 100);
  it("identical line: zero deviation, full cover", () => {
    const s = similarity({ x1: 100, p1: 50_000, x2: 300, p2: 50_200 }, line, 400, atr);
    expect(s.dev).toBeCloseTo(0);
    expect(s.cover).toBeCloseTo(1);
  });
  it("offset by 0.4 ATR is within the default price limit, 0.6 is not", () => {
    expect(similarity({ x1: 100, p1: 50_040, x2: 300, p2: 50_240 }, line, 400, atr).dev).toBeCloseTo(0.4);
    expect(similarity({ x1: 100, p1: 50_060, x2: 300, p2: 50_260 }, line, 400, atr).dev).toBeCloseTo(0.6);
  });
  it("a line starting halfway covers half the target", () => {
    const late = newSeed(200, projectAt(line, 200), "low", 300, 50_200, "low");
    expect(similarity({ x1: 100, p1: 50_000, x2: 300, p2: 50_200 }, late, 400, atr).cover).toBeCloseTo(0.5);
  });
  it("a line with i0 set earlier than i1 covers a target that starts before i1", () => {
    // The line's plotted anchors start at 200, but Extend Left moved its
    // drawn start back to i0=100 -- projectAt still extrapolates from the
    // i1/i2 anchors, so a target spanning 100..300 should be fully covered.
    const extended: typeof line = { ...line, i1: 200, p1: projectAt(line, 200), i0: 100 };
    const s = similarity({ x1: 100, p1: 50_000, x2: 300, p2: 50_200 }, extended, 400, atr);
    expect(s.cover).toBeCloseTo(1);
  });
});

describe("lookup", () => {
  it("a drawn line looks itself up as covered", () => {
    const res = explain(runDebugSync({
      bars, cfg: TRENDLINES_DEFAULTS, startIdx: 0, evalIdx: bars.length - 1,
      window: [0, bars.length - 1], forced: [],
    }));
    const d = res.candidates.find((c) => c.drawn)!;
    const tgt = { x1: d.line.i1, p1: d.line.p1, x2: d.line.i2, p2: d.line.p2 };
    const out = lookup(res, tgt, SIM_DEFAULTS);
    expect(out.covered?.cand.key).toBe(d.key);
  });
  it("forced pairs include the snapped pair and stay under ten", () => {
    const highs = bars.map((b) => b.high);
    const lows = bars.map((b) => b.low);
    const pairs = forcedPairsFor(highs, lows, { x1: 100, p1: bars[100].low, x2: 400, p2: bars[400].low }, 5);
    expect(pairs[0]).toMatchObject({ i1: 100, i2: 400 });
    expect(pairs.length).toBeLessThanOrEqual(10);
    for (const p of pairs) expect(p.i1).toBeLessThan(p.i2);
  });
});
