import { describe, expect, it } from "vitest";
import { DEFAULT_WFO_CONFIG, buildWalkForwardPayload, wfoAxesFromSweepAxes } from "./wfo";
import type { SweepAxis } from "./sweep";

const range: SweepAxis = { kind: "range", target: "param:fast", label: "fast", from: 5, to: 15, step: 5 };
const list: SweepAxis = {
  kind: "list", target: "op:long.entry.0", label: "Op",
  options: [{ label: "gt", patch: { "op:long.entry.0": "gt" } }, { label: "lt", patch: { "op:long.entry.0": "lt" } }],
};
const period: SweepAxis = { kind: "period", target: "period", label: "Period", n: 4 };
const timeWin: SweepAxis = {
  kind: "list", target: "timeWindow", label: "Session",
  options: [{ label: "am", patch: { "timeWindow:startMin": 540, "timeWindow:endMin": 720 } as never }],
};

describe("wfoAxesFromSweepAxes", () => {
  it("converts range and list axes, drops period and timeWindow axes", () => {
    const { wfoAxes, usable, dropped } = wfoAxesFromSweepAxes([range, list, period, timeWin]);
    expect(wfoAxes).toEqual([
      { kind: "range", targets: ["param:fast"], values: [5, 10, 15] },
      { kind: "list", targets: ["op:long.entry.0"] },
    ]);
    expect(usable.map((a) => a.target)).toEqual(["param:fast", "op:long.entry.0"]);
    expect(dropped).toEqual(["Period", "Session"]);
  });

  it("drops an options-[] list axis instead of throwing on options[0]", () => {
    // A timeWindow axis seeded from a mask with no window has options: [] and
    // round-trips through persistence — it must be dropped, never reach options[0].
    const emptyTimeWin: SweepAxis = {
      kind: "list", target: "timeWindow", label: "Window", options: [],
    };
    // A plain list axis (non-timeWindow target) with empty options must also drop.
    const emptyList: SweepAxis = {
      kind: "list", target: "op:long.entry.0", label: "Op", options: [],
    };
    let result!: ReturnType<typeof wfoAxesFromSweepAxes>;
    expect(() => {
      result = wfoAxesFromSweepAxes([range, emptyTimeWin, emptyList]);
    }).not.toThrow();
    expect(result.wfoAxes).toEqual([{ kind: "range", targets: ["param:fast"], values: [5, 10, 15] }]);
    expect(result.usable.map((a) => a.target)).toEqual(["param:fast"]);
    expect(result.dropped).toEqual(["Window", "Op"]);
  });

  it("includes mirrorTarget in range targets", () => {
    const mirrored: SweepAxis = { ...range, mirrorTarget: "risk:short.stop.value" } as SweepAxis;
    const { wfoAxes } = wfoAxesFromSweepAxes([mirrored]);
    expect(wfoAxes[0].targets).toEqual(["param:fast", "risk:short.stop.value"]);
  });
});

describe("buildWalkForwardPayload", () => {
  it("builds payload with matrix spans and combo total", () => {
    const cfg = { ...DEFAULT_WFO_CONFIG, trainSpans: ["3m", "1m"], testSpan: "2w", step: null };
    const { payload, comboTotal } = buildWalkForwardPayload([range, list], cfg);
    expect(comboTotal).toBe(6);
    expect(payload.combos).toHaveLength(6);
    expect(payload.schedule).toEqual({ mode: "rolling", trainSpan: "3m", testSpan: "2w", step: undefined });
    expect(payload.matrixTrainSpans).toEqual(["1m"]);
    expect(payload.objective).toEqual({ metric: "sharpe", selection: "plateau" });
    expect(payload.evalMode).toBe("exact"); // default
  });

  it("threads evalMode through the payload", () => {
    const fast = buildWalkForwardPayload([range], { ...DEFAULT_WFO_CONFIG, evalMode: "fast" });
    expect(fast.payload.evalMode).toBe("fast");
    const exact = buildWalkForwardPayload([range], { ...DEFAULT_WFO_CONFIG, evalMode: "exact" });
    expect(exact.payload.evalMode).toBe("exact");
  });

  it("includes baselines [null, hold] in the walk-forward payload", () => {
    const { payload } = buildWalkForwardPayload([range, list], DEFAULT_WFO_CONFIG);
    expect(payload.baselines).toEqual(["null", "hold"]);
  });

  it("throws on no usable axes / no train span", () => {
    expect(() => buildWalkForwardPayload([period], DEFAULT_WFO_CONFIG)).toThrow(/parameter axis/);
    expect(() => buildWalkForwardPayload([range], { ...DEFAULT_WFO_CONFIG, trainSpans: [] })).toThrow(/training span/);
  });
});
