import { describe, it, expect } from "vitest";
import {
  defaultVisibility,
  parseResolution,
  isVisibleOnResolution,
  barsSpanned,
  VISIBILITY_UNITS,
  applyPreset,
  detectPreset,
} from "./visibility";

const ALL_RES = [
  "SECOND_5", "MINUTE", "MINUTE_5", "MINUTE_15", "MINUTE_30",
  "HOUR", "HOUR_4", "DAY", "WEEK",
];

describe("parseResolution", () => {
  it("splits prefix + numeric suffix (suffix defaults to 1)", () => {
    expect(parseResolution("MINUTE")).toEqual({ unit: "minutes", value: 1 });
    expect(parseResolution("MINUTE_15")).toEqual({ unit: "minutes", value: 15 });
    expect(parseResolution("HOUR_4")).toEqual({ unit: "hours", value: 4 });
    expect(parseResolution("DAY")).toEqual({ unit: "days", value: 1 });
    expect(parseResolution("WEEK")).toEqual({ unit: "weeks", value: 1 });
    expect(parseResolution("SECOND_30")).toEqual({ unit: "seconds", value: 30 });
  });
  it("returns null for an unknown resolution", () => {
    expect(parseResolution("TICK")).toBeNull();
    expect(parseResolution("")).toBeNull();
  });
  it("recognizes the derived Month/Year resolutions", () => {
    expect(parseResolution("MONTH")).toEqual({ unit: "months", value: 1 });
    expect(parseResolution("MONTH_3")).toEqual({ unit: "months", value: 3 });
    expect(parseResolution("YEAR")).toEqual({ unit: "years", value: 1 });
  });
});

describe("defaultVisibility", () => {
  it("is visible on every native resolution (reproduces null=all)", () => {
    const m = defaultVisibility();
    for (const r of ALL_RES) expect(isVisibleOnResolution(m, r)).toBe(true);
    expect(m.autoHide.on).toBe(false);
    expect(m.autoHide.minBars).toBe(3);
  });
  it("covers exactly the supported units", () => {
    expect(VISIBILITY_UNITS.map((u) => u.unit)).toEqual([
      "seconds", "minutes", "hours", "days", "weeks", "months", "years",
    ]);
  });
});

describe("isVisibleOnResolution", () => {
  it("hides a unit whose row is off", () => {
    const m = defaultVisibility();
    m.units.minutes.on = false;
    expect(isVisibleOnResolution(m, "MINUTE_15")).toBe(false);
    expect(isVisibleOnResolution(m, "HOUR")).toBe(true);
  });
  it("respects min/max within a unit", () => {
    const m = defaultVisibility();
    m.units.minutes = { on: true, min: 5, max: 15 };
    expect(isVisibleOnResolution(m, "MINUTE")).toBe(false); // value 1 < min 5
    expect(isVisibleOnResolution(m, "MINUTE_5")).toBe(true);
    expect(isVisibleOnResolution(m, "MINUTE_15")).toBe(true);
    expect(isVisibleOnResolution(m, "MINUTE_30")).toBe(false); // value 30 > max 15
  });
  it("fails open on an unknown resolution", () => {
    expect(isVisibleOnResolution(defaultVisibility(), "TICK")).toBe(true);
  });
  it("does NOT fail open on the derived Month/Year resolutions (regression: these", () => {
    // used to be unrecognized and always show, silently defeating the feature there)
    const m = defaultVisibility();
    m.units.months.on = false;
    m.units.years.on = false;
    expect(isVisibleOnResolution(m, "MONTH")).toBe(false);
    expect(isVisibleOnResolution(m, "MONTH_2")).toBe(false);
    expect(isVisibleOnResolution(m, "YEAR")).toBe(false);
  });
});

describe("barsSpanned", () => {
  it("counts bars between two ms timestamps for a resolution", () => {
    // 1 hour apart on a 1m chart = 60 bars
    expect(barsSpanned(0, 3_600_000, "MINUTE")).toBe(60);
    // order-independent
    expect(barsSpanned(3_600_000, 0, "MINUTE")).toBe(60);
    // 1 hour apart on a 1H chart = 1 bar
    expect(barsSpanned(0, 3_600_000, "HOUR")).toBe(1);
  });
  it("is Infinity for an unknown resolution (never auto-hides)", () => {
    // "TICK" (not "MONTH": derived timeframes added MONTH to RESOLUTION_SECONDS for
    // scroll-back math, so it's no longer an unknown key there; ticks remain unsupported).
    expect(barsSpanned(0, 1000, "TICK")).toBe(Infinity);
  });
});

describe("applyPreset", () => {
  it("all: every unit on, full range", () => {
    const m = applyPreset(defaultVisibility(), "MINUTE_15", "all");
    expect(m.units).toEqual(defaultVisibility().units);
  });

  it("only: just this unit on, min=max=value", () => {
    const m = applyPreset(defaultVisibility(), "MINUTE_15", "only");
    expect(m.units.minutes).toEqual({ on: true, min: 15, max: 15 });
    expect(m.units.seconds.on).toBe(false);
    expect(m.units.hours.on).toBe(false);
    expect(m.units.days.on).toBe(false);
    expect(m.units.weeks.on).toBe(false);
  });

  it("finer: finer units fully on, this unit capped at value, coarser off", () => {
    const m = applyPreset(defaultVisibility(), "MINUTE_15", "finer");
    expect(m.units.seconds).toEqual({ on: true, min: 1, max: 59 });
    expect(m.units.minutes).toEqual({ on: true, min: 1, max: 15 });
    expect(m.units.hours.on).toBe(false);
    expect(m.units.days.on).toBe(false);
    expect(m.units.weeks.on).toBe(false);
  });

  it("coarser: coarser units fully on, this unit from value to unitMax, finer off", () => {
    const m = applyPreset(defaultVisibility(), "MINUTE_15", "coarser");
    expect(m.units.seconds.on).toBe(false);
    expect(m.units.minutes).toEqual({ on: true, min: 15, max: 59 });
    expect(m.units.hours).toEqual({ on: true, min: 1, max: 24 });
    expect(m.units.days).toEqual({ on: true, min: 1, max: 366 });
    expect(m.units.weeks).toEqual({ on: true, min: 1, max: 52 });
  });

  it("preserves autoHide untouched", () => {
    const start = { ...defaultVisibility(), autoHide: { on: true, minBars: 7 } };
    const m = applyPreset(start, "MINUTE_15", "finer");
    expect(m.autoHide).toEqual({ on: true, minBars: 7 });
  });

  it("custom is a no-op", () => {
    const start = defaultVisibility();
    const m = applyPreset(start, "MINUTE_15", "custom");
    expect(m).toEqual(start);
  });

  it("unknown resolution is a no-op", () => {
    const start = defaultVisibility();
    const m = applyPreset(start, "TICK", "finer");
    expect(m).toEqual(start);
  });
});

describe("detectPreset", () => {
  it("detects all/only/finer/coarser round-trip", () => {
    for (const p of ["all", "only", "finer", "coarser"] as const) {
      const m = applyPreset(defaultVisibility(), "MINUTE_15", p);
      expect(detectPreset(m, "MINUTE_15")).toBe(p);
    }
  });

  it("returns custom for a hand-edited model", () => {
    const m = defaultVisibility();
    m.units.hours.max = 12;
    expect(detectPreset(m, "MINUTE_15")).toBe("custom");
  });

  it("returns custom for an unparseable resolution", () => {
    expect(detectPreset(defaultVisibility(), "TICK")).toBe("custom");
  });

  it("finer/coarser/only round-trip on the Month/Year units too", () => {
    for (const p of ["all", "only", "finer", "coarser"] as const) {
      const m = applyPreset(defaultVisibility(), "MONTH_2", p);
      expect(detectPreset(m, "MONTH_2")).toBe(p);
    }
  });
});
