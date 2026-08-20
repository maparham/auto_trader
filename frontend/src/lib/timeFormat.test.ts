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

  // An invalid saved timezone falls back to the SYSTEM zone, so the label keeps
  // both halves — it used to drop the clock time and count elapsed 24h blocks.
  // The day number is left to the zone-independent tests below; what matters
  // here is the shape and that no real DATE survives.
  //
  // The date check anchors on date-shaped forms, not on bare "03": the clock
  // time is rendered in the RUNNER's zone, so a machine at UTC-6 prints
  // "Day 4 03:30" for this input and a bare /03/ would fail there while nothing
  // had leaked. (Reported by review, reproduced with TZ=America/Chicago.)
  it("keeps a day number and a clock time (never a real date) on an invalid timezone", () => {
    const out = maskedTimeLabel(ANCHOR, ANCHOR + 3 * DAY, "24h", "Not/AZone");
    expect(out).toMatch(/^Day \d+ \d{2}:\d{2}$/);
    expect(out).not.toMatch(/2026|Mar|03-|-03|03\/|\/03/);
  });
});

// Two masked cells at once: lib/maskedReplay hands the any-cell readers a null
// anchor rather than a neighbour's, and this is what that renders as. The shape
// matters as much as the text — the compact forms elsewhere keep the first two
// space-separated words, and every masked label starts "Day ".
describe("masked label with no anchor", () => {
  it("withholds the day number and keeps the clock time", () => {
    expect(maskedTimeLabel(null, Date.UTC(2026, 6, 10, 9, 30), "24h", "UTC")).toBe("Day ? 09:30");
  });

  it("honours the 12h preference the same way", () => {
    expect(maskedTimeLabel(null, Date.UTC(2026, 6, 10, 15, 5), "12h", "UTC")).toBe("Day ? 3:05 PM");
  });

  it("never prints a real date part", () => {
    const label = maskedTimeLabel(null, Date.UTC(2026, 6, 10, 9, 30), "24h", "UTC");
    expect(label).not.toMatch(/2026|07|10/);
  });

  // The degraded branch (a corrupt saved timezone makes the Intl constructor
  // throw) has no anchor arithmetic to fall back on either. It still renders in
  // the system zone, so the clock time survives; only the day number is absent.
  it("keeps withholding the day number when the timezone is unusable", () => {
    const label = maskedTimeLabel(null, Date.UTC(2026, 6, 10, 9, 30), "24h", "Not/AZone");
    expect(label).toMatch(/^Day \?/);
    expect(label).not.toMatch(/2026|Jul/);
  });
});

// A saved timezone can be corrupt (hand-edited storage, a zone Intl dropped).
// The label must stay up, stay blind, and — the part that regressed — keep
// counting CALENDAR days, because the axis beside it does. Counting elapsed 24h
// blocks from the anchor instead disagrees with the axis for part of every day
// that a session did not start at local midnight.
describe("masked label with an unusable timezone", () => {
  const ANCHOR_UTC = Date.UTC(2026, 6, 10, 21, 30); // 21:30, deliberately not midnight

  it("still renders a day number and a clock time", () => {
    expect(maskedTimeLabel(ANCHOR_UTC, ANCHOR_UTC, "24h", "Not/AZone")).toMatch(/^Day \d+ \d{2}:\d{2}$/);
  });

  it("counts calendar days, not elapsed 24h blocks", () => {
    // 4 hours past the anchor crosses local midnight but is inside the first 24h
    // block. Calendar counting says the next day; block counting says the same
    // day, which is the bug.
    const fourHoursOn = ANCHOR_UTC + 4 * 60 * 60 * 1000;
    const start = maskedTimeLabel(ANCHOR_UTC, ANCHOR_UTC, "24h", "Not/AZone");
    const later = maskedTimeLabel(ANCHOR_UTC, fourHoursOn, "24h", "Not/AZone");
    const dayOf = (s: string) => Number(s.split(" ")[1]);
    // Whatever the machine's zone is, the two labels sit either side of ITS
    // midnight iff the clock time went down; that is the only case this asserts,
    // so the test is zone-independent rather than pinned to one CI locale.
    const wrapped = later.split(" ")[2] < start.split(" ")[2];
    expect(dayOf(later)).toBe(dayOf(start) + (wrapped ? 1 : 0));
  });

  it("never leaks a real date through the fallback", () => {
    expect(maskedTimeLabel(ANCHOR_UTC, ANCHOR_UTC + 5 * 86_400_000, "24h", "Not/AZone"))
      .not.toMatch(/2026|Jul|07-/);
  });
});
