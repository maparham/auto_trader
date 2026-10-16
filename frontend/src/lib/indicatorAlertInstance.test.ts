import { describe, it, expect } from "vitest";
import { alertInstanceOf, alertTimeframeOf, chartValueOf } from "./indicatorAlertInstance";

describe("alertInstanceOf", () => {
  it("keeps only the pin of an mtf block", () => {
    const ext = { maType: "ema", mtf: { timeframe: "HOUR_4", htfSeries: [1, 2, 3], htfStarts: [1, 2, 3] } };
    expect(alertInstanceOf("EMA", [20], ext)).toEqual({
      type: "EMA", calcParams: [20], extendData: { maType: "ema", mtf: { timeframe: "HOUR_4" } },
    });
  });
  it("drops an mtf block with no pin and never mutates the pane", () => {
    const ext = { mtf: { htfSeries: [1] } };
    expect(alertInstanceOf("RSI", undefined, ext)).toEqual({ type: "RSI", calcParams: [], extendData: {} });
    expect(ext).toEqual({ mtf: { htfSeries: [1] } });
  });
});

describe("alertTimeframeOf", () => {
  it("prefers the pin", () => {
    expect(alertTimeframeOf({ mtf: { timeframe: "HOUR_4" } }, "MINUTE_5")).toBe("HOUR_4");
    expect(alertTimeframeOf({}, "MINUTE_5")).toBe("MINUTE_5");
  });
});

describe("chartValueOf", () => {
  it("reads the output name or its camelCase result key", () => {
    expect(chartValueOf({ ma: 5 }, "ma")).toBe(5);
    expect(chartValueOf({ bullTop: 7 }, "bull_top")).toBe(7);
    expect(chartValueOf({ ma: NaN }, "ma")).toBeUndefined();
    expect(chartValueOf(undefined, "ma")).toBeUndefined();
  });
});
