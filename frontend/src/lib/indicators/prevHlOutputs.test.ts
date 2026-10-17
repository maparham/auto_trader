import { describe, it, expect, afterEach } from "vitest";
import { PREV_HL_OUTPUTS, parsePrevHlRefConfig, prevHlWarmup } from "./prevHlOutputs";
import {
  EXPR_INSTANCE_TYPES, collectExprInstances, exprInstancesFor, exprWarmupByRef, synthesizeExprInstances,
} from "../exprInstances";
import { chartIndicatorToExprToken } from "../exprChartToken";
import { INDICATOR_SPECS } from "../expr/catalog";
import { getIndicatorTimezone, setIndicatorTimezone } from "../indicatorTimezone";

const before = getIndicatorTimezone();
afterEach(() => { setIndicatorTimezone(before); });

describe("PREV_HL config", () => {
  it("takes computePrevHl's fallbacks and ignores lineHidden", () => {
    expect(parsePrevHlRefConfig({ lineHidden: { dayHigh: true } })).toEqual({
      lengths: { rolling: 1, day: 1, week: 1 },
      aggs: { rolling: "extreme", day: "extreme", week: "extreme" },
      rollingUnit: "hour", gapMode: "trading", anchorTs: 0,
    });
    expect(prevHlWarmup(parsePrevHlRefConfig({ rollingUnit: "bars", lengths: { rolling: 7 } }), "rollingLow")).toBe(8);
    expect(prevHlWarmup(parsePrevHlRefConfig({ lengths: { day: 3 } }), "dayHigh")).toBe(0);
  });
  it("a non-finite stored length is 0, not a silent fallback to 1 (S8)", () => {
    expect(parsePrevHlRefConfig({ lengths: { rolling: "abc", day: NaN } }).lengths).toEqual({ rolling: 0, day: 0, week: 1 });
  });
});

describe("PREV_HL as a rule instance", () => {
  const live = [{ id: "PREV_HL", type: "PREV_HL", calcParams: [], extendData: { rollingUnit: "bars", lengths: { rolling: 20, day: 2 } } }];
  it("is referenceable with a bare id", () => {
    expect(EXPR_INSTANCE_TYPES.has("PREV_HL")).toBe(true);
    expect(Object.hasOwn(INDICATOR_SPECS, "PREV_HL")).toBe(false);
  });
  it("lists all eight outputs whatever is hidden", () => {
    const hidden = [{ ...live[0], extendData: { ...live[0].extendData, lineHidden: { weekHigh: true } } }];
    expect(exprInstancesFor(hidden)).toEqual([
      { id: "PREV_HL", outputs: [...PREV_HL_OUTPUTS], timeframe: null, detail: "rolling 20 bars · 2 days · 1 week · anchor unset" },
    ]);
    expect(exprWarmupByRef(live)("PREV_HL", "rollingHigh")).toBe(21);
  });
  it("ships the chart zone with a rule request", () => {
    setIndicatorTimezone("Asia/Tokyo");
    expect(collectExprInstances(live, ["PREV_HL.dayHigh < candle.close"]).PREV_HL.extendData)
      .toEqual({ rollingUnit: "bars", lengths: { rolling: 20, day: 2 }, tz: "Asia/Tokyo" });
  });
  it("re-creates a missing pane WITHOUT a zone (it becomes a chart pane; a written tz would freeze it)", () => {
    setIndicatorTimezone("Asia/Tokyo");
    expect(synthesizeExprInstances(["PREV_HL.dayHigh > 0"], new Set()))
      .toEqual({ PREV_HL: { type: "PREV_HL", calcParams: [], extendData: {} } });
  });
  it("turns a legend click into an instance ref", () => {
    expect(chartIndicatorToExprToken("PREV_HL", [], {}, { instanceId: "PREV_HL", figureKey: "weekLow" })).toBe("PREV_HL.weekLow");
    expect(chartIndicatorToExprToken("PREV_HL", [], {}, { instanceId: "PREV_HL" })).toBe("PREV_HL.dayHigh");
  });
  it("requires an instanceId", () => {
    expect(chartIndicatorToExprToken("PREV_HL", [], {})).toBeNull();
  });
  it("turns a curve click on a non-default line into its output", () => {
    expect(chartIndicatorToExprToken("PREV_HL", [], {}, { instanceId: "PREV_HL", lineIndex: 1 })).toBe("PREV_HL.rollingLow");
    expect(chartIndicatorToExprToken("PREV_HL", [], {}, { instanceId: "PREV_HL", lineIndex: 4 })).toBe("PREV_HL.weekHigh");
  });
});
