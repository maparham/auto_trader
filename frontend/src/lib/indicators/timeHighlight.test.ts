import { describe, it, expect, vi } from "vitest";
import type { KLineData } from "klinecharts";

// timeHighlight.ts (via sessions.ts) reads IndicatorSeries at module load; stub
// klinecharts' runtime surface like sessions.test.ts does.
vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));

import {
  DEFAULT_TIME_WINDOWS,
  windowActiveAt,
  computeTimeHighlight,
  buildWindowSegments,
  type TimeWindowDef,
} from "./timeHighlight";

const bar = (iso: string): KLineData =>
  ({ timestamp: Date.parse(iso), open: 1, high: 1, low: 1, close: 1, volume: 1 }) as KLineData;

const w = (over: Partial<TimeWindowDef>): TimeWindowDef => ({
  id: "x",
  color: "#000",
  from: "09:00",
  to: "17:00",
  mode: "band",
  enabled: true,
  ...over,
});

describe("windowActiveAt", () => {
  it("is active inside a normal window", () => {
    // 12:00 UTC is inside 09:00–17:00 UTC.
    expect(windowActiveAt(Date.parse("2026-07-06T12:00:00Z"), w({}), "UTC")).toBe(true);
  });
  it("is inactive before the window opens", () => {
    expect(windowActiveAt(Date.parse("2026-07-06T08:59:00Z"), w({}), "UTC")).toBe(false);
  });
  it("treats `from` as inclusive and `to` as exclusive", () => {
    expect(windowActiveAt(Date.parse("2026-07-06T09:00:00Z"), w({}), "UTC")).toBe(true);
    expect(windowActiveAt(Date.parse("2026-07-06T17:00:00Z"), w({}), "UTC")).toBe(false);
  });
  it("is inactive when disabled", () => {
    expect(windowActiveAt(Date.parse("2026-07-06T12:00:00Z"), w({ enabled: false }), "UTC")).toBe(
      false,
    );
  });

  describe("midnight-wrapping window (to <= from)", () => {
    const night = w({ from: "22:00", to: "06:00" });
    it("is active in the evening tail (>= from)", () => {
      expect(windowActiveAt(Date.parse("2026-07-06T23:00:00Z"), night, "UTC")).toBe(true);
    });
    it("is active in the early-morning tail (< to)", () => {
      expect(windowActiveAt(Date.parse("2026-07-06T05:00:00Z"), night, "UTC")).toBe(true);
    });
    it("is inactive in the daytime gap", () => {
      expect(windowActiveAt(Date.parse("2026-07-06T12:00:00Z"), night, "UTC")).toBe(false);
    });
    it("is active exactly at `from` and inactive exactly at `to`", () => {
      expect(windowActiveAt(Date.parse("2026-07-06T22:00:00Z"), night, "UTC")).toBe(true);
      expect(windowActiveAt(Date.parse("2026-07-06T06:00:00Z"), night, "UTC")).toBe(false);
    });
  });

  describe("DST-aware (device zone América/New_York)", () => {
    const nine = w({ from: "09:00", to: "17:00" });
    it("is active at 12:00 local in July (EDT, UTC-4)", () => {
      // 16:00 UTC == 12:00 EDT, inside 09:00–17:00.
      expect(windowActiveAt(Date.parse("2026-07-06T16:00:00Z"), nine, "America/New_York")).toBe(
        true,
      );
    });
    it("is inactive at 08:00 local in July", () => {
      // 12:00 UTC == 08:00 EDT, before 09:00.
      expect(windowActiveAt(Date.parse("2026-07-06T12:00:00Z"), nine, "America/New_York")).toBe(
        false,
      );
    });
    it("is active at 12:00 local in January (EST, UTC-5)", () => {
      // 17:00 UTC == 12:00 EST, inside 09:00–17:00.
      expect(windowActiveAt(Date.parse("2026-01-06T17:00:00Z"), nine, "America/New_York")).toBe(
        true,
      );
    });
  });
});

describe("computeTimeHighlight", () => {
  it("reports each bar's active window ids in list order", () => {
    const morning = w({ id: "am", from: "08:00", to: "12:00" });
    const allday = w({ id: "day", from: "00:00", to: "23:59" });
    const ext = { windows: [morning, allday] };
    const pts = computeTimeHighlight(
      [bar("2026-07-06T09:00:00Z"), bar("2026-07-06T15:00:00Z")],
      ext,
      "UTC",
    );
    // 09:00: inside both -> ["am","day"] (list order). 15:00: only allday.
    expect(pts[0].ids).toEqual(["am", "day"]);
    expect(pts[1].ids).toEqual(["day"]);
  });
  it("emits an empty point for bars in no window", () => {
    const morning = w({ id: "am", from: "08:00", to: "12:00" });
    const pts = computeTimeHighlight([bar("2026-07-06T15:00:00Z")], { windows: [morning] }, "UTC");
    expect(pts[0].ids).toBeUndefined();
  });
  it("falls back to DEFAULT_TIME_WINDOWS when none configured", () => {
    // Default window is 09:00–17:00; 12:00 UTC is inside it (device zone UTC here).
    const pts = computeTimeHighlight([bar("2026-07-06T12:00:00Z")], {}, "UTC");
    expect(pts[0].ids).toEqual([DEFAULT_TIME_WINDOWS[0].id]);
  });
});

describe("buildWindowSegments", () => {
  it("collapses consecutive active bars into one segment and splits on gaps", () => {
    const pts = [
      { ids: ["a"] },
      { ids: ["a"] },
      {}, // gap
      { ids: ["a"] },
    ];
    expect(buildWindowSegments(pts, "a")).toEqual([
      { start: 0, end: 1 },
      { start: 3, end: 3 },
    ]);
  });
  it("ignores bars where only OTHER windows are active", () => {
    const pts = [{ ids: ["a"] }, { ids: ["b"] }, { ids: ["a"] }];
    expect(buildWindowSegments(pts, "a")).toEqual([
      { start: 0, end: 0 },
      { start: 2, end: 2 },
    ]);
  });
  it("returns no segments when the window is never active", () => {
    expect(buildWindowSegments([{}, { ids: ["b"] }], "a")).toEqual([]);
  });
});
