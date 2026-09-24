import { describe, expect, it } from "vitest";
import { runDebugSync, runDebugAsync, type DebugRunInput } from "./trendlinesDebug";
import { aboveSlope, buildTlState, hasBackClearance, isLive, withinSlope } from "./trendlines";
import { TRENDLINES_DEFAULTS, type TrendlinesConfig } from "./trendlinesOutputs";
import { synthBars } from "./trendlinesSynth.testutil";

const bars = synthBars(1200);
const input = (patch: Partial<TrendlinesConfig>, extra: Partial<DebugRunInput> = {}): DebugRunInput => ({
  bars,
  cfg: { ...TRENDLINES_DEFAULTS, ...patch },
  startIdx: 0,
  evalIdx: bars.length - 1,
  window: [0, bars.length - 1],
  forced: [],
  ...extra,
});

describe("debug sink", () => {
  it("records slope rejects with lines that really fail the slope gate", () => {
    const run = runDebugSync(input({ maxSlopeAtr: 0.02 }));
    const rej = run.records.filter((r) => r.seedGate === "slopeMax");
    expect(rej.length).toBeGreaterThan(0);
    for (const r of rej) expect(withinSlope(r.line, run.st.atr[r.line.i2] as number, 0.02)).toBe(false);
  });

  it("records min slope and back clearance rejects", () => {
    const a = runDebugSync(input({ minSlopeAtr: 0.05 }));
    const minRej = a.records.filter((r) => r.seedGate === "slopeMin");
    expect(minRej.length).toBeGreaterThan(0);
    for (const r of minRej) expect(aboveSlope(r.line, a.st.atr[r.line.i2] as number, 0.05)).toBe(false);
    const b = runDebugSync(input({ minBackBars: 30 }));
    const backRej = b.records.filter((r) => r.seedGate === "backClearance");
    expect(backRej.length).toBeGreaterThan(0);
    for (const r of backRej) expect(hasBackClearance(r.line, b.st.closes, 0, 30)).toBe(false);
  });

  it("records rejected pivots by gate", () => {
    const run = runDebugSync(input({ minSwingAtr: 2, minSwingReach: 12 }));
    expect(run.rejectedPivots.some((p) => p.gate === "size")).toBe(true);
    expect(run.rejectedPivots.some((p) => p.gate === "reach")).toBe(true);
  });

  it("rejected seeds keep stepping: their crossings grow after birth", () => {
    const run = runDebugSync(input({ maxSlopeAtr: 0.02 }));
    const grown = run.records.some((r) => (r.line.crossIdxs ?? []).some((c) => c > r.bornAt));
    expect(grown).toBe(true);
  });

  it("died lines carry why and when", () => {
    const run = runDebugSync(input({ maxProjBars: 40 }));
    const died = run.records.filter((r) => r.origin === "died");
    expect(died.length).toBeGreaterThan(0);
    for (const r of died) {
      expect(r.endedBy).toBe("stale");
      expect(isLive(r.line, r.endedAt as number, { ...TRENDLINES_DEFAULTS, maxProjBars: 40 })).toBe(false);
    }
  });

  it("window drops records that end before it", () => {
    const run = runDebugSync(input({ maxProjBars: 40 }, { window: [1000, 1199] }));
    for (const r of run.records) expect((r.endedAt ?? 1199) >= 1000).toBe(true);
  });

  it("injects a forced pair even when neither anchor is a pivot", () => {
    const run = runDebugSync(input({}, { forced: [{ i1: 100, k1: "low", i2: 400, k2: "low" }] }));
    const f = run.records.find((r) => r.origin === "forced");
    expect(f).toBeDefined();
    expect(f!.line.i1).toBe(100);
    expect(f!.line.p1).toBe(bars[100].low);
    expect(f!.line.i2).toBe(400);
    expect(f!.bornAt).toBe(400 + TRENDLINES_DEFAULTS.pivotLen);
  });

  it("a forced pair too recent to confirm is injected at the eval bar, flagged", () => {
    const n = bars.length;
    const run = runDebugSync(input({}, { forced: [{ i1: n - 50, k1: "high", i2: n - 2, k2: "high" }] }));
    const f = run.records.find((r) => r.origin === "forced");
    expect(f?.forced?.unconfirmed).toBe(true);
  });

  it("the RECORDING sink leaves the detector bit-identical", () => {
    for (const patch of [{}, { maxSlopeAtr: 0.02, minBackBars: 20 }, { maxProjBars: 40, lookbackBars: 300 }]) {
      const cfg = { ...TRENDLINES_DEFAULTS, ...patch };
      const run = runDebugSync(input(patch, {
        forced: [{ i1: 100, k1: "low", i2: 400, k2: "low" }, { i1: 150, k1: "high", i2: 900, k2: "high" }],
      }));
      const plain = buildTlState(bars, bars.length, cfg);
      expect(run.st.points).toEqual(plain.points);
      expect(run.st.lines).toEqual(plain.lines);
      expect(run.st.pairs).toBe(plain.pairs);
    }
  });

  it("a full stepping cap keeps the most recent records, not the oldest", () => {
    const run = runDebugSync(input({ maxSlopeAtr: 0.01 }, { maxStepping: 60 }));
    expect(run.overflow).toBeGreaterThan(0);
    const latest = Math.max(...run.records.map((r) => r.bornAt));
    expect(latest).toBeGreaterThan(bars.length - 150);
  });

  it("async run equals sync run and honours abort", async () => {
    const i = input({ maxSlopeAtr: 0.02 });
    const a = runDebugSync(i);
    const b = await runDebugAsync(i);
    expect(b?.records.length).toBe(a.records.length);
    const ctl = new AbortController();
    ctl.abort();
    expect(await runDebugAsync(i, ctl.signal)).toBeNull();
  });
});
