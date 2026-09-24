import { describe, expect, it } from "vitest";
import { runDebugSync } from "./trendlinesDebug";
import { explain, explainSelection, lineVerdicts, GATE_ORDER } from "./trendlinesDebugExplain";
import {
  mergeTolerance, nearestFirst, poolable, selectDrawnLines, selectLevels, trendlineGate,
} from "./trendlines";
import { TRENDLINES_DEFAULTS, type TrendlinesConfig } from "./trendlinesOutputs";
import { synthBars } from "./trendlinesSynth.testutil";

const bars = synthBars(1200);
const run = (patch: Partial<TrendlinesConfig> = {}) =>
  runDebugSync({
    bars, cfg: { ...TRENDLINES_DEFAULTS, ...patch }, startIdx: 0,
    evalIdx: bars.length - 1, window: [0, bars.length - 1], forced: [],
  });

describe("explainSelection", () => {
  it("its drawn set is exactly selectLevels' output", () => {
    for (const patch of [{}, { maxLines: 1 }, { maxPerPivot: 1 }, { mergeAtr: 1 }]) {
      const r = run(patch);
      const cfg = r.input.cfg;
      const i = r.input.evalIdx;
      const close = r.st.closes[i];
      const passing = poolable(r.st.lines, i, cfg).filter(trendlineGate(i, close, r.st.atr[i], cfg));
      const ranked = nearestFirst(passing, i, close);
      const tol = mergeTolerance(cfg, r.st.atr[i], close);
      const fates = explainSelection(ranked, i, tol, cfg.maxPerPivot, cfg.maxLines);
      const drawn = ranked.filter((l) => fates.get(l)?.kind === "drawn");
      expect(drawn).toEqual(selectLevels(ranked, i, tol, cfg.maxPerPivot, cfg.maxLines));
    }
  });
});

describe("explain", () => {
  it("live verdicts agree with the detector's own gate", () => {
    const r = run({ minTouches: 3, maxDistAtr: 3, extendLeft: 1 });
    const cfg = r.input.cfg;
    const i = r.input.evalIdx;
    const close = r.st.closes[i];
    const gate = trendlineGate(i, close, r.st.atr[i], cfg);
    const pool = new Set(poolable(r.st.lines, i, cfg));
    for (const line of r.st.lines) {
      const allPass = lineVerdicts(line, null, r).every((v) => v.pass);
      expect(allPass).toBe(pool.has(line) && gate(line));
    }
  });

  it("the drawn candidates are the emitted drawn set", () => {
    const r = run();
    const res = explain(r);
    const cfg = r.input.cfg;
    const i = r.input.evalIdx;
    const close = r.st.closes[i];
    const drawn = selectDrawnLines(poolable(r.st.lines, i, cfg), i, close, cfg.maxLines, {
      tol: mergeTolerance(cfg, r.st.atr[i], close), keep: new Set(), perPivot: cfg.maxPerPivot,
      pass: trendlineGate(i, close, r.st.atr[i], cfg),
    });
    expect(res.candidates.filter((c) => c.drawn).map((c) => c.line)).toEqual(
      expect.arrayContaining(drawn),
    );
    expect(res.candidates.filter((c) => c.drawn)).toHaveLength(drawn.length);
  });

  it("failed verdicts are in pipeline order and seed rejects lead with their seed gate", () => {
    const res = explain(run({ maxSlopeAtr: 0.02 }));
    const seed = res.candidates.find((c) => c.record?.seedGate === "slopeMax");
    expect(seed?.failed[0].gate).toBe("slopeMax");
    for (const c of res.candidates) {
      const order = c.failed.map((v) => GATE_ORDER.indexOf(v.gate));
      expect(order).toEqual([...order].sort((a, b) => a - b));
    }
  });

  it("seed-gate rejects lead with their own gate even when lookback also fails", () => {
    const res = explain(run({ maxSlopeAtr: 0.02, lookbackBars: 50 }));
    const seed = res.candidates.filter((c) => c.record?.seedGate === "slopeMax");
    expect(seed.length).toBeGreaterThan(0);
    for (const c of seed) expect(c.failed[0].gate).toBe(c.record!.seedGate);
  });

  it("outranked means every gate passed and selection dropped it", () => {
    const res = explain(run({ maxLines: 1 }));
    const out = res.candidates.filter((c) => c.outranked);
    expect(out.length).toBeGreaterThan(0);
    for (const c of out) {
      expect(c.verdicts.filter((v) => !["merged", "perPivot", "maxLines"].includes(v.gate)).every((v) => v.pass)).toBe(true);
      expect(["merged", "perPivot", "maxLines"]).toContain(c.fate?.kind);
    }
  });

  it("counts cover every non-drawn candidate once", () => {
    const res = explain(run({ maxSlopeAtr: 0.02 }));
    const total = res.counts.filter((g) => g.group !== "drawn").reduce((s, g) => s + g.n, 0);
    expect(total).toBe(res.candidates.filter((c) => !c.drawn).length);
  });

  it("forced anchors that are not fractals report the largest Min Length that works", () => {
    const r = runDebugSync({
      bars, cfg: { ...TRENDLINES_DEFAULTS, pivotLen: 8 }, startIdx: 0, evalIdx: bars.length - 1,
      window: [0, bars.length - 1], forced: [{ i1: 101, k1: "low", i2: 402, k2: "low" }],
    });
    const c = explain(r).candidates.find((x) => x.origin === "forced")!;
    const frac = c.verdicts.filter((v) => v.gate === "fractal");
    expect(frac).toHaveLength(2);
    for (const v of frac) {
      expect(v.limit).toBe(8);
      expect(v.measured === null || v.measured < 8 || v.pass).toBe(true);
    }
  });
});
