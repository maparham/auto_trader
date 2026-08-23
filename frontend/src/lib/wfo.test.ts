import { describe, expect, it } from "vitest";
import { DEFAULT_WFO_CONFIG, buildWalkForwardPayload, matchUiAxesByTargets, uiAxesFromResult, wfoAxesFromSweepAxes } from "./wfo";
import type { WfoResult } from "../api";
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
      { kind: "range", targets: ["param:fast"], values: [5, 10, 15], ui: range },
      { kind: "list", targets: ["op:long.entry.0"], ui: list },
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
    expect(result.wfoAxes).toEqual([{ kind: "range", targets: ["param:fast"], values: [5, 10, 15], ui: range }]);
    expect(result.usable.map((a) => a.target)).toEqual(["param:fast"]);
    expect(result.dropped).toEqual(["Window", "Op"]);
  });

  it("includes mirrorTarget in range targets", () => {
    const mirrored: SweepAxis = { ...range, mirrorTarget: "risk:short.stop.value" } as SweepAxis;
    const { wfoAxes } = wfoAxesFromSweepAxes([mirrored]);
    expect(wfoAxes[0].targets).toEqual(["param:fast", "risk:short.stop.value"]);
  });
});

describe("uiAxesFromResult", () => {
  const resultWith = (axes: WfoResult["axes"]): WfoResult =>
    ({ eval_mode: "exact", objective: {} as WfoResult["objective"], schedule: {}, axes, schemes: [] });

  it("round-trips the SweepAxes a run's wfoAxes carried", () => {
    const { wfoAxes } = wfoAxesFromSweepAxes([range, list]);
    expect(uiAxesFromResult(resultWith(wfoAxes))).toEqual([range, list]);
  });

  it("yields [] for pre-field results and null results", () => {
    expect(uiAxesFromResult(resultWith([{ kind: "range", targets: ["param:fast"], values: [5] }]))).toEqual([]);
    expect(uiAxesFromResult(null)).toEqual([]);
    expect(uiAxesFromResult(undefined)).toEqual([]);
  });

  it("skips axes whose ui is malformed, keeps the rest", () => {
    const { wfoAxes } = wfoAxesFromSweepAxes([range]);
    const axes = [...wfoAxes, { kind: "list" as const, targets: ["x"], ui: 42 }];
    expect(uiAxesFromResult(resultWith(axes))).toEqual([range]);
  });
});

describe("matchUiAxesByTargets", () => {
  it("labels a pre-field result with sweep axes that align by kind+targets", () => {
    const { wfoAxes } = wfoAxesFromSweepAxes([range, list]);
    const bare = wfoAxes.map(({ ui: _ui, ...rest }) => rest); // pre-field: no ui stored
    expect(matchUiAxesByTargets(bare, [range, list, period])).toEqual([range, list]);
  });

  it("matches regardless of config order, returning axes in the result's order", () => {
    const { wfoAxes } = wfoAxesFromSweepAxes([range, list]);
    const bare = wfoAxes.map(({ ui: _ui, ...rest }) => rest);
    expect(matchUiAxesByTargets(bare, [list, range])).toEqual([range, list]);
  });

  it("tolerates extra config axes the run never swept", () => {
    // The config grew an axis since the run — it appears in no archived combo,
    // so it can't mislabel anything and must not break the match.
    const { wfoAxes } = wfoAxesFromSweepAxes([range, list]);
    const bare = wfoAxes.map(({ ui: _ui, ...rest }) => rest);
    const extra: SweepAxis = { ...range, target: "lit:short.entry.0.0" };
    expect(matchUiAxesByTargets(bare, [extra, range, list])).toEqual([range, list]);
  });

  it("matches a mirrored run axis to today's unmirrored axis (same primary target + grid)", () => {
    const mirrored: SweepAxis = { ...range, target: "risk:long.stop.mult", mirrorTarget: "risk:short.stop.mult" };
    const { wfoAxes } = wfoAxesFromSweepAxes([mirrored]);
    const bare = wfoAxes.map(({ ui: _ui, ...rest }) => rest);
    const unmirrored: SweepAxis = { ...range, target: "risk:long.stop.mult" };
    expect(matchUiAxesByTargets(bare, [unmirrored])).toEqual([unmirrored]);
  });

  it("returns [] when the current config no longer matches the run", () => {
    const { wfoAxes } = wfoAxesFromSweepAxes([range, list]);
    const bare = wfoAxes.map(({ ui: _ui, ...rest }) => rest);
    const otherRange: SweepAxis = { ...range, target: "param:slow" };
    expect(matchUiAxesByTargets(bare, [otherRange, list])).toEqual([]); // target drift
    expect(matchUiAxesByTargets(bare, [range])).toEqual([]); // missing counterpart
    expect(matchUiAxesByTargets(bare, [{ ...range, step: 1 }, list])).toEqual([]); // grid drift
    expect(matchUiAxesByTargets([], [range])).toEqual([]); // no archived axes
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

  it("includes all baseline kinds in the walk-forward payload", () => {
    const { payload } = buildWalkForwardPayload([range, list], DEFAULT_WFO_CONFIG);
    expect(payload.baselines).toEqual(["null", "hold", "reversed"]);
  });

  it("throws on no usable axes / no train span", () => {
    expect(() => buildWalkForwardPayload([period], DEFAULT_WFO_CONFIG)).toThrow(/parameter axis/);
    expect(() => buildWalkForwardPayload([range], { ...DEFAULT_WFO_CONFIG, trainSpans: [] })).toThrow(/training span/);
  });
});
