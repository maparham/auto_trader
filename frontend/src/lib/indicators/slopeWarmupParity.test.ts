// Shared-corpus parity for SLOPE warm-up: the numbers in slopeWarmupCases.json
// are asserted by BOTH stacks — here against slopeOutputs.ts `slopeWarmup`, and
// in backend/tests/test_slope_warmup_parity.py against indicators/slope.py
// `slope_warmup`, which reads the same file. One table, two readers, so the two
// implementations cannot drift apart without a test failing.
//
// The numbers themselves were generated from the Python function: PYTHON IS THE
// AUTHORITY here, because it is what actually computes the series the backend
// evaluates a rule against. If a case disagrees, fix TypeScript.
//
// Why this matters beyond tidiness: the run's history ask is sized from this
// number (backtestWindow.ts). Charging a referenced pane too little means the
// first N bars inside the trading window evaluate to null and the rule silently
// cannot fire there; charging too much hard-fails a run that was fine.
import { describe, it, expect } from "vitest";
import cases from "./slopeWarmupCases.json";
import { slopeOutputs, slopeWarmup } from "./slopeOutputs";
import type { SlopeExtend } from "./slope";
import { warmupOf } from "../expr/parser";
import { exprInstancesFor, exprWarmupByRef, type LiveInstance } from "../exprInstances";

interface WarmupCase {
  label: string;
  calcParams: number[];
  extendData: Record<string, unknown>;
  warmup: Record<string, number>;
}

const CASES = cases as WarmupCase[];

describe("slopeWarmup matches the Python authority", () => {
  for (const c of CASES) {
    it(c.label, () => {
      const ext = c.extendData as SlopeExtend;
      // The output SET must agree too: a warm-up table listing outputs this
      // config doesn't expose (or missing one it does) would silently stop
      // covering the case it was written for.
      expect(slopeOutputs(c.calcParams, ext).sort()).toEqual(Object.keys(c.warmup).sort());
      for (const [output, want] of Object.entries(c.warmup)) {
        expect(slopeWarmup(c.calcParams, ext, output)).toBe(want);
      }
    });
  }

  it("covers an accel output and a smoothed one, or it isn't proving much", () => {
    const outputs = CASES.flatMap((c) => Object.keys(c.warmup));
    expect(outputs.some((o) => o.startsWith("accel"))).toBe(true);
    expect(CASES.some((c) => (c.extendData.smoothing as { type?: string })?.type === "ema")).toBe(true);
    expect(CASES.some((c) => (c.extendData.accelSmoothing as { type?: string })?.type === "ema")).toBe(true);
  });

  it("an output this config does not expose costs 0, not NaN", () => {
    // accel is off here, so `accel0` is an unknown reference — the lint layer's
    // error to report. Inflating the history ask over it would hard-fail the run
    // for the wrong reason.
    expect(slopeWarmup([9], {} as SlopeExtend, "accel0")).toBe(0);
    expect(slopeWarmup([9], {} as SlopeExtend, "slope7")).toBe(0);
  });
});

describe("warmupOf charges an indicator reference its pane's warm-up", () => {
  // The failing scenario from the review, end to end: a pane with lengths [50],
  // slopePeriod 3 and EMA(10) slope smoothing. Before the refs were threaded in,
  // this returned 0 and the run fetched no warm-up for the rule at all.
  const pane: LiveInstance = {
    id: "SLOPE",
    type: "SLOPE",
    calcParams: [50],
    extendData: { slopePeriod: 3, smoothing: { type: "ema", length: 10 } },
  };
  const refs = () => [exprInstancesFor([pane]), exprWarmupByRef([pane])] as const;

  it("an unpinned pane costs its full warm-up in BASE bars", () => {
    const [instances, warmupByRef] = refs();
    expect(warmupOf("SLOPE.slope0 > 0.5", 300, instances, warmupByRef)).toBe(62);
  });

  it("without the refs it is still 0 — the pre-fix behaviour", () => {
    expect(warmupOf("SLOPE.slope0 > 0.5", 300)).toBe(0);
  });

  it("an offset outside the reference adds to it", () => {
    const [instances, warmupByRef] = refs();
    expect(warmupOf("SLOPE.slope0[-2] > 0.5", 300, instances, warmupByRef)).toBe(64);
  });

  it("a PINNED pane costs 0 base bars — it warms from its own HTF history", () => {
    const pinned: LiveInstance = {
      ...pane,
      extendData: { ...(pane.extendData as object), mtf: { timeframe: "HOUR_4" } },
    };
    expect(
      warmupOf("SLOPE.slope0 > 0.5", 300, exprInstancesFor([pinned]), exprWarmupByRef([pinned])),
    ).toBe(0);
  });

  it("an unknown instance costs 0", () => {
    const [instances, warmupByRef] = refs();
    expect(warmupOf("NOPE.slope0 > 0.5", 300, instances, warmupByRef)).toBe(0);
  });
});
