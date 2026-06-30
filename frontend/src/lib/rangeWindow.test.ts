import { describe, it, expect } from "vitest";
import { rangeWindow, RANGE_KEYS, TRAILING_KEYS } from "./rangeWindow";

const DAY = 86_400_000;
// Fixed "now": 2026-06-30T12:00:00Z (June → month index 5; Q2; first half of year).
const NOW = Date.UTC(2026, 5, 30, 12, 0, 0);

describe("rangeWindow", () => {
  it("exposes the eight keys in TV display order", () => {
    expect(RANGE_KEYS).toEqual(["1D", "5D", "1M", "3M", "6M", "YTD", "1Y", "All"]);
  });

  it("pairs each key with the agreed resolution", () => {
    const res = (k: any) => rangeWindow(k, NOW, "UTC").resolution;
    expect(res("1D")).toBe("MINUTE");
    expect(res("5D")).toBe("MINUTE_5");
    expect(res("1M")).toBe("MINUTE_30");
    expect(res("3M")).toBe("HOUR");
    expect(res("6M")).toBe("HOUR_4");
    expect(res("YTD")).toBe("DAY");
    expect(res("1Y")).toBe("DAY");
    expect(res("All")).toBe("DAY");
  });

  it("always sets toTs to now", () => {
    for (const k of RANGE_KEYS) expect(rangeWindow(k, NOW, "UTC").toTs).toBe(NOW);
  });

  it("anchors the left edge to the start of the calendar period", () => {
    const from = (k: any) => rangeWindow(k, NOW, "UTC").fromTs;
    expect(from("1D")).toBe(Date.UTC(2026, 5, 30)); // start of today
    expect(from("1M")).toBe(Date.UTC(2026, 5, 1)); // 1st of June
    expect(from("3M")).toBe(Date.UTC(2026, 3, 1)); // Q2 starts Apr 1
    expect(from("6M")).toBe(Date.UTC(2026, 0, 1)); // H1 starts Jan 1 (June is first half)
    expect(from("YTD")).toBe(Date.UTC(2026, 0, 1));
    expect(from("1Y")).toBe(Date.UTC(2025, 0, 1)); // Jan 1 last year
  });

  it("keeps 5D trailing (5 days back from now)", () => {
    expect(rangeWindow("5D", NOW, "UTC").fromTs).toBe(NOW - 5 * DAY);
  });

  it("anchors All at the epoch (page until exhausted)", () => {
    expect(rangeWindow("All", NOW, "UTC").fromTs).toBe(0);
  });

  it("puts the quarter/half boundaries in the right place later in the year", () => {
    const oct = Date.UTC(2026, 9, 15, 9, 0, 0); // Oct 15 → Q4, second half
    expect(rangeWindow("3M", oct, "UTC").fromTs).toBe(Date.UTC(2026, 9, 1)); // Q4 starts Oct 1
    expect(rangeWindow("6M", oct, "UTC").fromTs).toBe(Date.UTC(2026, 6, 1)); // H2 starts Jul 1
  });

  it("computes calendar boundaries in the given timezone", () => {
    // Etc/GMT-2 is UTC+2, so 'start of June' there is May 31 22:00 UTC.
    expect(rangeWindow("1M", NOW, "Etc/GMT-2").fromTs).toBe(Date.UTC(2026, 4, 31, 22, 0));
    // Start of today (June 30 in UTC+2) = June 29 22:00 UTC.
    expect(rangeWindow("1D", NOW, "Etc/GMT-2").fromTs).toBe(Date.UTC(2026, 5, 29, 22, 0));
  });

  it("exposes the four trailing-offset keys", () => {
    expect(TRAILING_KEYS).toEqual(["-1D", "-1W", "-1M", "-1Y"]);
  });

  it("pairs trailing offsets with the interval of the calendar span they resemble", () => {
    const res = (k: any) => rangeWindow(k, NOW, "UTC").resolution;
    expect(res("-1D")).toBe("MINUTE"); // like 1D
    expect(res("-1W")).toBe("MINUTE_5"); // like 5D
    expect(res("-1M")).toBe("MINUTE_30"); // like 1M
    expect(res("-1Y")).toBe("DAY"); // like 1Y
  });

  it("anchors trailing offsets exactly N back from now (right edge = now)", () => {
    const NOWH = Date.UTC(2026, 5, 30, 14, 30, 0); // 2026-06-30 14:30Z
    expect(rangeWindow("-1D", NOWH, "UTC").fromTs).toBe(NOWH - DAY);
    expect(rangeWindow("-1W", NOWH, "UTC").fromTs).toBe(NOWH - 7 * DAY);
    // one calendar month back, same wall-clock time
    expect(rangeWindow("-1M", NOWH, "UTC").fromTs).toBe(Date.UTC(2026, 4, 30, 14, 30));
    expect(rangeWindow("-1Y", NOWH, "UTC").fromTs).toBe(Date.UTC(2025, 5, 30, 14, 30));
    for (const k of TRAILING_KEYS) expect(rangeWindow(k, NOWH, "UTC").toTs).toBe(NOWH);
  });
});
