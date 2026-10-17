import { describe, it, expect, afterEach } from "vitest";
import { getIndicatorTimezone, setIndicatorTimezone, withChartTimezone } from "./indicatorTimezone";

const before = getIndicatorTimezone();
afterEach(() => { setIndicatorTimezone(before); });

describe("indicator timezone", () => {
  it("reports a change only when the zone moves", () => {
    setIndicatorTimezone("UTC");
    expect(setIndicatorTimezone("UTC")).toBe(false);
    expect(setIndicatorTimezone("Asia/Tokyo")).toBe(true);
    expect(getIndicatorTimezone()).toBe("Asia/Tokyo");
  });
});

describe("withChartTimezone", () => {
  it("writes the chart zone into a PREV_HL pane with no override", () => {
    setIndicatorTimezone("America/New_York");
    expect(withChartTimezone("PREV_HL", { lengths: { day: 2 } })).toEqual({ lengths: { day: 2 }, tz: "America/New_York" });
    expect(withChartTimezone("PREV_HL", undefined)).toEqual({ tz: "America/New_York" });
  });
  it("replaces 'chart' and an invalid zone, keeps a valid override", () => {
    setIndicatorTimezone("Europe/London");
    expect(withChartTimezone("PREV_HL", { tz: "chart" })).toEqual({ tz: "Europe/London" });
    expect(withChartTimezone("PREV_HL", { tz: "Mars/Base" })).toEqual({ tz: "Europe/London" });
    expect(withChartTimezone("PREV_HL", { tz: "Asia/Tokyo" })).toEqual({ tz: "Asia/Tokyo" });
  });
  it("leaves other types alone and never mutates", () => {
    const ext = { source: "hl2" };
    expect(withChartTimezone("RSI", ext)).toBe(ext);
    const prev = { lengths: {} };
    withChartTimezone("PREV_HL", prev);
    expect(prev).toEqual({ lengths: {} });
  });
});
