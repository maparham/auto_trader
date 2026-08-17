import { describe, it, expect } from "vitest";
import type { FormatDateParams } from "klinecharts";
import { makeMaskedFormatDate, makeFormatDate, maskedTimeLabel } from "./timeFormat";

const DAY = 86_400_000;
const ANCHOR = Date.UTC(2026, 2, 2, 9, 30); // Mon 2026-03-02 09:30 UTC
const dtf = new Intl.DateTimeFormat("en", {
  hour12: false,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  timeZone: "UTC",
});
const call = (fmt: (p: FormatDateParams) => string, timestamp: number, template: string) =>
  fmt({ dateTimeFormat: dtf, timestamp, template, type: "xAxis" } as FormatDateParams);

describe("makeMaskedFormatDate", () => {
  const fmt = makeMaskedFormatDate(ANCHOR, "24h");

  it("renders the anchor day as Day 1", () => {
    expect(call(fmt, ANCHOR, "YYYY-MM-DD HH:mm")).toBe("Day 1 09:30");
  });

  it("counts whole days from the anchor", () => {
    expect(call(fmt, ANCHOR + 3 * DAY, "YYYY-MM-DD HH:mm")).toBe("Day 4 09:30");
  });

  it("counts backwards for context bars before the start", () => {
    expect(call(fmt, ANCHOR - DAY, "YYYY-MM-DD HH:mm")).toBe("Day 0 09:30");
    expect(call(fmt, ANCHOR - 2 * DAY, "YYYY-MM-DD HH:mm")).toBe("Day -1 09:30");
  });

  it("never leaks a year or month at coarse tick granularities", () => {
    expect(call(fmt, ANCHOR, "YYYY")).toBe("Day 1");
    expect(call(fmt, ANCHOR, "YYYY-MM")).toBe("Day 1");
    expect(call(fmt, ANCHOR, "MM-DD")).toBe("Day 1");
  });

  it("renders a time-only template as a bare clock time", () => {
    expect(call(fmt, ANCHOR, "HH:mm")).toBe("09:30");
  });

  it("honours the 12h clock preference", () => {
    const twelve = makeMaskedFormatDate(ANCHOR, "12h");
    expect(call(twelve, ANCHOR, "YYYY-MM-DD HH:mm")).toBe("Day 1 9:30 AM");
  });

  it("stays a pure function of (timestamp, template) so tick de-duping still works", () => {
    expect(call(fmt, ANCHOR, "YYYY")).toBe(call(fmt, ANCHOR, "YYYY"));
    expect(call(fmt, ANCHOR, "YYYY")).not.toBe(call(fmt, ANCHOR + DAY, "YYYY"));
  });

  it("leaves the unmasked formatter untouched", () => {
    expect(call(makeFormatDate("24h", "ymd"), ANCHOR, "YYYY-MM-DD HH:mm")).toBe("2026-03-02 09:30");
  });
});

// Day numbers are CALENDAR days in the axis timezone, not elapsed 24h blocks
// from the jump instant. With an evening anchor the two disagree for most of
// every session, and the block version makes the axis read backwards: one "Day"
// then spans 21:30 -> 21:29, so the clock wraps INSIDE a single label
// ("Day 0 21:30" sitting to the left of "Day 0 17:30"). Every case here is
// pinned against an evening anchor because that is where the two schemes split.
describe("makeMaskedFormatDate: calendar-day numbering", () => {
  const EVENING = Date.UTC(2026, 2, 2, 21, 30); // Mon 2026-03-02 21:30 UTC
  const HOUR = 3_600_000;
  const fmt = makeMaskedFormatDate(EVENING, "24h");
  const day = (ts: number) => call(fmt, ts, "YYYY-MM-DD HH:mm");

  it("keeps a later bar on the SAME calendar day as the anchor on Day 1", () => {
    expect(day(EVENING + 2 * HOUR)).toBe("Day 1 23:30");
  });

  it("rolls to Day 2 at local midnight, hours after an evening anchor", () => {
    // 4h after the jump, but the calendar date has turned: elapsed-block
    // numbering kept this on Day 1, which is what printed "Day 1 01:30" to the
    // LEFT of "Day 1 21:30" on the axis.
    expect(day(EVENING + 4 * HOUR)).toBe("Day 2 01:30");
    expect(day(EVENING + 23 * HOUR)).toBe("Day 2 20:30");
  });

  it("counts context bars back by calendar day, not by elapsed block", () => {
    // Earlier the same evening is still Day 1 (blocks said Day 0); the previous
    // calendar day is Day 0 however few hours back it sits.
    expect(day(EVENING - 4 * HOUR)).toBe("Day 1 17:30");
    expect(day(EVENING - 22 * HOUR)).toBe("Day 0 23:30");
    expect(day(EVENING - 46 * HOUR)).toBe("Day -1 23:30");
  });

  it("reads left-to-right: the clock never runs backwards inside a Day label", () => {
    // The user-visible property the whole change exists for. Walk hourly across
    // the anchor and assert the printed (day, time) pair only ever increases.
    let prevDay = -Infinity;
    let prevKey = "";
    for (let h = -30; h <= 72; h++) {
      const [, n, time] = /^Day (-?\d+) (\d\d:\d\d)$/.exec(day(EVENING + h * HOUR)) ?? [];
      expect(n).toBeDefined();
      const num = Number(n);
      expect(num).toBeGreaterThanOrEqual(prevDay); // day number is monotone
      // Sortable key: offset the day number so it stays lexicographically
      // ordered through the negative context days.
      const key = `${String(num + 1000).padStart(5, "0")} ${time}`;
      expect(key > prevKey ? "ascending" : `${prevKey} then ${key}`).toBe("ascending");
      prevDay = num;
      prevKey = key;
    }
  });

  it("follows the DISPLAY timezone's calendar, across a DST jump", () => {
    // Sat 2026-03-07 21:30 in New York; the following Sunday is 23h long
    // (spring forward), so no fixed 86.4e6 block can align with it.
    const ny = new Intl.DateTimeFormat("en", {
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZone: "America/New_York",
    });
    const anchor = Date.UTC(2026, 2, 8, 2, 30); // = Sat 07 Mar 21:30 EST
    const nyFmt = makeMaskedFormatDate(anchor, "24h");
    const at = (ts: number) => nyFmt({ dateTimeFormat: ny, timestamp: ts, template: "YYYY-MM-DD HH:mm", type: "xAxis" } as FormatDateParams);
    expect(at(anchor)).toBe("Day 1 21:30");
    expect(at(Date.UTC(2026, 2, 9, 0, 30))).toBe("Day 2 20:30"); // Sun 20:30 EDT, 22h later
    expect(at(Date.UTC(2026, 2, 9, 12, 30))).toBe("Day 3 08:30"); // Mon 08:30 EDT
  });
});

// The one-shot helper app-level panels (drawing coordinates, indicator anchors,
// marker popovers) use — it must agree with the chart's own axis, and it must
// never leak a date through a bad timezone.
describe("maskedTimeLabel", () => {
  it("matches what the axis shows for the same bar", () => {
    expect(maskedTimeLabel(ANCHOR, ANCHOR + 3 * DAY, "24h", "UTC")).toBe("Day 4 09:30");
  });

  it("honours the 12h clock preference", () => {
    expect(maskedTimeLabel(ANCHOR, ANCHOR, "12h", "UTC")).toBe("Day 1 9:30 AM");
  });

  it("counts context bars before the anchor down through Day 0", () => {
    expect(maskedTimeLabel(ANCHOR, ANCHOR - DAY, "24h", "UTC")).toBe("Day 0 09:30");
  });

  it("degrades to the day part (never a real date) on an invalid timezone", () => {
    const out = maskedTimeLabel(ANCHOR, ANCHOR + 3 * DAY, "24h", "Not/AZone");
    expect(out).toBe("Day 4");
    expect(out).not.toMatch(/2026|Mar|03/);
  });
});
