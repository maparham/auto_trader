import { describe, it, expect } from "vitest";
import {
  quickBarPeriods,
  periodByResolution,
  DEFAULT_RESOLUTIONS,
  PERIODS,
} from "./feed";

describe("quickBarPeriods", () => {
  it("returns exactly the defaults (in duration order) when there are no favorites", () => {
    const bar = quickBarPeriods([]);
    expect(bar.map((p) => p.resolution)).toEqual([
      "MINUTE", "MINUTE_5", "MINUTE_15", "MINUTE_30",
      "HOUR", "HOUR_4", "DAY", "WEEK",
    ]);
  });

  it("inserts a sub-minute favorite before 1m", () => {
    const bar = quickBarPeriods(["SECOND_30"]).map((p) => p.resolution);
    expect(bar[0]).toBe("SECOND_30");
    expect(bar[1]).toBe("MINUTE");
  });

  it("inserts a derived favorite after 1W in duration order", () => {
    const bar = quickBarPeriods(["WEEK_2"]).map((p) => p.resolution);
    expect(bar[bar.length - 1]).toBe("WEEK_2");
    expect(bar[bar.indexOf("WEEK_2") - 1]).toBe("WEEK");
  });

  it("does not duplicate a favorite that equals a default", () => {
    const bar = quickBarPeriods(["HOUR"]).map((p) => p.resolution);
    expect(bar.filter((r) => r === "HOUR")).toHaveLength(1);
    expect(bar).toEqual(quickBarPeriods([]).map((p) => p.resolution));
  });

  it("ignores unknown resolution keys and de-dupes repeats", () => {
    const bar = quickBarPeriods(["NOPE", "SECOND_30", "SECOND_30"]).map((p) => p.resolution);
    expect(bar.filter((r) => r === "SECOND_30")).toHaveLength(1);
    expect(bar).not.toContain("NOPE");
  });
});

describe("periodByResolution", () => {
  it("resolves defaults, seconds, and derived keys", () => {
    expect(periodByResolution("HOUR")?.label).toBe("1H");
    expect(periodByResolution("SECOND_30")?.label).toBe("30s");
    expect(periodByResolution("WEEK_2")?.label).toBe("2W");
    expect(periodByResolution("NOPE")).toBeUndefined();
  });
});

describe("DEFAULT_RESOLUTIONS", () => {
  it("is exactly the PERIODS resolution set", () => {
    expect([...DEFAULT_RESOLUTIONS].sort()).toEqual(
      PERIODS.map((p) => p.resolution).sort(),
    );
  });
});
