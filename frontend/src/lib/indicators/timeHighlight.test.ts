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
  projectOccurrences,
  isRecurringWindow,
  type DailyWindowDef,
  type RecurringWindowDef,
} from "./timeHighlight";

const bar = (iso: string): KLineData =>
  ({ timestamp: Date.parse(iso), open: 1, high: 1, low: 1, close: 1, volume: 1 }) as KLineData;

const w = (over: Partial<DailyWindowDef>): DailyWindowDef => ({
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

const rw = (over: Partial<RecurringWindowDef>): RecurringWindowDef => ({
  id: "r",
  color: "#000",
  mode: "band",
  enabled: true,
  anchorStartMs: Date.parse("2026-07-06T09:30:00Z"),
  anchorEndMs: Date.parse("2026-07-06T11:00:00Z"),
  period: "day",
  ...over,
});

describe("isRecurringWindow", () => {
  it("distinguishes recurring windows from daily HH:MM windows", () => {
    expect(isRecurringWindow(rw({}))).toBe(true);
    expect(isRecurringWindow(w({}))).toBe(false);
  });
});

describe("projectOccurrences", () => {
  it("repeats a daily anchor at the same wall time on each prior day", () => {
    const occ = projectOccurrences(
      rw({}),
      Date.parse("2026-07-04T00:00:00Z"),
      Date.parse("2026-07-07T00:00:00Z"),
      "UTC",
    );
    expect(occ).toEqual([
      { startMs: Date.parse("2026-07-04T09:30:00Z"), endMs: Date.parse("2026-07-04T11:00:00Z") },
      { startMs: Date.parse("2026-07-05T09:30:00Z"), endMs: Date.parse("2026-07-05T11:00:00Z") },
      { startMs: Date.parse("2026-07-06T09:30:00Z"), endMs: Date.parse("2026-07-06T11:00:00Z") },
    ]);
  });

  it("repeats a weekly anchor on the same weekday", () => {
    // Anchor is Monday 2026-07-06; the prior occurrence is Monday 2026-06-29.
    const occ = projectOccurrences(
      rw({ period: "week" }),
      Date.parse("2026-06-28T00:00:00Z"),
      Date.parse("2026-07-01T00:00:00Z"),
      "UTC",
    );
    expect(occ).toEqual([
      { startMs: Date.parse("2026-06-29T09:30:00Z"), endMs: Date.parse("2026-06-29T11:00:00Z") },
    ]);
  });

  it("includes occurrences overlapping the range edge, excludes ones fully outside", () => {
    const occ = projectOccurrences(
      rw({}),
      Date.parse("2026-07-05T10:00:00Z"), // cuts into the July 5 occurrence
      Date.parse("2026-07-06T00:00:00Z"),
      "UTC",
    );
    expect(occ).toEqual([
      { startMs: Date.parse("2026-07-05T09:30:00Z"), endMs: Date.parse("2026-07-05T11:00:00Z") },
    ]);
  });

  it("clamps a month-end anchor to shorter months", () => {
    // Jan 31 anchored monthly: February occurrence lands on Feb 28 (2026 is not a leap year).
    const occ = projectOccurrences(
      rw({
        period: "month",
        anchorStartMs: Date.parse("2026-01-31T09:00:00Z"),
        anchorEndMs: Date.parse("2026-01-31T10:00:00Z"),
      }),
      Date.parse("2026-02-01T00:00:00Z"),
      Date.parse("2026-03-01T00:00:00Z"),
      "UTC",
    );
    expect(occ).toEqual([
      { startMs: Date.parse("2026-02-28T09:00:00Z"), endMs: Date.parse("2026-02-28T10:00:00Z") },
    ]);
  });

  it("clamps a Feb 29 yearly anchor to Feb 28 in non-leap years", () => {
    const occ = projectOccurrences(
      rw({
        period: "year",
        anchorStartMs: Date.parse("2024-02-29T09:00:00Z"),
        anchorEndMs: Date.parse("2024-02-29T10:00:00Z"),
      }),
      Date.parse("2023-01-01T00:00:00Z"),
      Date.parse("2023-12-31T00:00:00Z"),
      "UTC",
    );
    expect(occ).toEqual([
      { startMs: Date.parse("2023-02-28T09:00:00Z"), endMs: Date.parse("2023-02-28T10:00:00Z") },
    ]);
  });

  it("projects a multi-month yearly range (winter) into the previous year", () => {
    const occ = projectOccurrences(
      rw({
        period: "year",
        anchorStartMs: Date.parse("2025-12-15T00:00:00Z"),
        anchorEndMs: Date.parse("2026-01-20T00:00:00Z"),
      }),
      Date.parse("2024-11-01T00:00:00Z"),
      Date.parse("2025-03-01T00:00:00Z"),
      "UTC",
    );
    expect(occ).toEqual([
      { startMs: Date.parse("2024-12-15T00:00:00Z"), endMs: Date.parse("2025-01-20T00:00:00Z") },
    ]);
  });

  it("keeps wall-clock time across a DST boundary", () => {
    // Anchor 09:30 New York in July (EDT, UTC-4) → January occurrence is
    // 09:30 EST, i.e. 14:30 UTC, not 13:30 UTC.
    const occ = projectOccurrences(
      rw({
        period: "month",
        anchorStartMs: Date.parse("2026-07-06T13:30:00Z"), // 09:30 EDT
        anchorEndMs: Date.parse("2026-07-06T15:00:00Z"), // 11:00 EDT
      }),
      Date.parse("2026-01-01T00:00:00Z"),
      Date.parse("2026-01-31T00:00:00Z"),
      "America/New_York",
    );
    expect(occ).toEqual([
      { startMs: Date.parse("2026-01-06T14:30:00Z"), endMs: Date.parse("2026-01-06T16:00:00Z") },
    ]);
  });

  it("returns nothing for a disabled window", () => {
    const occ = projectOccurrences(
      rw({ enabled: false }),
      Date.parse("2026-07-01T00:00:00Z"),
      Date.parse("2026-07-31T00:00:00Z"),
      "UTC",
    );
    expect(occ).toEqual([]);
  });
});

describe("computeTimeHighlight with recurring windows", () => {
  it("marks bars inside projected occurrences, half-open bounds", () => {
    const win = rw({ id: "rr" });
    const pts = computeTimeHighlight(
      [
        bar("2026-07-05T09:29:00Z"), // before prior-day occurrence
        bar("2026-07-05T09:30:00Z"), // start inclusive
        bar("2026-07-05T10:59:00Z"), // inside
        bar("2026-07-05T11:00:00Z"), // end exclusive
        bar("2026-07-06T10:00:00Z"), // inside the anchor itself
      ],
      { windows: [win] },
      "UTC",
    );
    expect(pts.map((p) => p.ids?.includes("rr") ?? false)).toEqual([false, true, true, false, true]);
  });

  it("applies the optional recurrence mask as a fine filter", () => {
    // Daily 09:30–11:00, but mask restricts to Mondays. 2026-07-06 is a Monday;
    // 2026-07-07 is a Tuesday.
    const win = rw({ id: "rr", mask: { enabled: true, daysOfWeek: [1] } });
    const pts = computeTimeHighlight(
      [bar("2026-07-06T10:00:00Z"), bar("2026-07-07T10:00:00Z")],
      { windows: [win] },
      "UTC",
    );
    expect(pts[0].ids).toEqual(["rr"]);
    expect(pts[1].ids).toBeUndefined();
  });

  it("mixes daily and recurring windows in list order", () => {
    const daily = w({ id: "am", from: "08:00", to: "12:00" });
    const win = rw({ id: "rr" });
    const pts = computeTimeHighlight([bar("2026-07-05T10:00:00Z")], { windows: [daily, win] }, "UTC");
    expect(pts[0].ids).toEqual(["am", "rr"]);
  });
});

describe("buildRecurringWindowFromDrag", () => {
  it("spans whole bars, half-open, regardless of drag direction", async () => {
    const { buildRecurringWindowFromDrag } = await import("./timeHighlight");
    const barMs = 300_000; // 5m
    const a = Date.parse("2026-07-06T10:00:00Z");
    const b = Date.parse("2026-07-06T09:00:00Z");
    const win = buildRecurringWindowFromDrag(a, b, barMs);
    expect(win.anchorStartMs).toBe(b);
    expect(win.anchorEndMs).toBe(a + barMs); // last dragged bar included
    expect(win.period).toBe("day");
    expect(win.enabled).toBe(true);
    expect(win.mask).toEqual({ enabled: true });
  });
  it("collapses a click without drag to the single bar", async () => {
    const { buildRecurringWindowFromDrag } = await import("./timeHighlight");
    const a = Date.parse("2026-07-06T10:00:00Z");
    const win = buildRecurringWindowFromDrag(a, null, 300_000);
    expect(win.anchorStartMs).toBe(a);
    expect(win.anchorEndMs).toBe(a + 300_000);
  });
});

describe("appendWindow", () => {
  it("materializes the implied defaults before appending", async () => {
    const { appendWindow, DEFAULT_TIME_WINDOWS } = await import("./timeHighlight");
    const win = rw({ id: "new" });
    const next = appendWindow({}, win);
    expect(next).toEqual([...DEFAULT_TIME_WINDOWS, win]);
  });
  it("appends to an explicit window list", async () => {
    const { appendWindow } = await import("./timeHighlight");
    const existing = w({ id: "d" });
    const win = rw({ id: "new" });
    expect(appendWindow({ windows: [existing] }, win)).toEqual([existing, win]);
  });
});

describe("timeHighlightZone", () => {
  it("follows the chart timezone pushed via setIndicatorTimezone", async () => {
    const { timeHighlightZone } = await import("./timeHighlight");
    const { setIndicatorTimezone } = await import("./prevHl");
    const before = timeHighlightZone();
    try {
      setIndicatorTimezone("America/New_York");
      expect(timeHighlightZone()).toBe("America/New_York");
    } finally {
      setIndicatorTimezone(before);
    }
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
