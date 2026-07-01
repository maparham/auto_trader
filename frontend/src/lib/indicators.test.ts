import { describe, it, expect } from "vitest";
import { defaultVisibility, isVisibleOnResolution } from "./visibility";

describe("indicator interval visibility decision", () => {
  it("hides a minutes-only indicator on an hour timeframe", () => {
    const m = defaultVisibility();
    m.units.hours.on = false;
    m.units.days.on = false;
    m.units.weeks.on = false;
    expect(isVisibleOnResolution(m, "MINUTE_5")).toBe(true);
    expect(isVisibleOnResolution(m, "HOUR")).toBe(false);
  });
});
