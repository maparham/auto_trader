import { describe, expect, it } from "vitest";
import {
  fundingText,
  leverageText,
  localOpeningHours,
  marginText,
  priceText,
  rangePosition,
  spreadText,
  swapTimeText,
} from "./marketInfoFormat";

// Real OIL_CRUDE opening hours from Capital (zone UTC).
const OIL_HOURS = {
  mon: ["00:00 - 21:00", "22:00 - 00:00"],
  tue: ["00:00 - 21:00", "22:00 - 00:00"],
  wed: ["00:00 - 21:00", "22:00 - 00:00"],
  thu: ["00:00 - 21:00", "22:00 - 00:00"],
  fri: ["00:00 - 17:00"],
  sat: [],
  sun: ["22:00 - 00:00"],
  zone: "UTC",
};

describe("localOpeningHours", () => {
  it("UTC viewer (offset 0): windows pass through, identical days grouped", () => {
    expect(localOpeningHours(OIL_HOURS, 0)).toEqual([
      { days: "Mon – Thu", hours: "00:00 – 21:00, 22:00 – 00:00" },
      { days: "Fri", hours: "00:00 – 17:00" },
      { days: "Sat", hours: "closed" },
      { days: "Sun", hours: "22:00 – 00:00" },
    ]);
  });

  it("UTC+2 viewer: cross-midnight windows merge into the next day (Capital's own rendering)", () => {
    // Sun 22:00–24:00 UTC becomes Mon 00:00–02:00 local and fuses with
    // Mon 02:00–23:00 → "Mon 00:00 – 23:00". Same chain Tue–Fri.
    expect(localOpeningHours(OIL_HOURS, 120)).toEqual([
      { days: "Mon – Thu", hours: "00:00 – 23:00" },
      { days: "Fri", hours: "00:00 – 19:00" },
      { days: "Sat – Sun", hours: "closed" },
    ]);
  });

  it("negative offset (UTC-5): windows split backwards across midnight and wrap into Sunday", () => {
    expect(localOpeningHours(OIL_HOURS, -300)).toEqual([
      { days: "Mon – Thu", hours: "00:00 – 16:00, 17:00 – 00:00" },
      { days: "Fri", hours: "00:00 – 12:00" },
      // Sun 22:00 UTC (17:00 local) runs straight into Mon-00:00-UTC's shifted
      // start (Sun 19:00 local) — contiguous, so they fuse into one window.
      { days: "Sat", hours: "closed" },
      { days: "Sun", hours: "17:00 – 00:00" },
    ]);
  });

  it("returns [] when there are no windows at all", () => {
    expect(localOpeningHours({ zone: "UTC" }, 0)).toEqual([]);
    expect(localOpeningHours({ mon: [], zone: "UTC" }, 0)).toEqual([]);
  });

  it("ignores malformed windows", () => {
    expect(
      localOpeningHours({ mon: ["garbage", "09:00 - 17:00"], zone: "UTC" }, 0),
    ).toEqual([
      { days: "Mon", hours: "09:00 – 17:00" },
      { days: "Tue – Sun", hours: "closed" },
    ]);
  });
});

describe("fundingText", () => {
  it("formats the broker's percent value to 3 decimals", () => {
    expect(fundingText(-0.01096)).toBe("-0.011%");
    expect(fundingText(0.5)).toBe("0.500%");
  });
  it("rejects non-numbers", () => {
    expect(fundingText(undefined)).toBeNull();
    expect(fundingText("x")).toBeNull();
  });
});

describe("swapTimeText", () => {
  // 1783026000000 ms = 2026-07-02 21:00:00 UTC.
  it("renders the charge time in local HH:MM", () => {
    expect(swapTimeText(1783026000000, 0)).toBe("21:00");
    expect(swapTimeText(1783026000000, 120)).toBe("23:00");
    expect(swapTimeText(1783026000000, -300)).toBe("16:00");
  });
  it("wraps past midnight", () => {
    expect(swapTimeText(1783026000000, 240)).toBe("01:00");
  });
  it("rejects non-numbers", () => {
    expect(swapTimeText(null, 0)).toBeNull();
  });
});

describe("marginText / leverageText", () => {
  it("formats percentage margin and derives leverage", () => {
    expect(marginText(10, "PERCENTAGE")).toBe("10.00%");
    expect(leverageText(10, "PERCENTAGE")).toBe("10:1");
    expect(leverageText(5, "PERCENTAGE")).toBe("20:1");
    expect(leverageText(100, "PERCENTAGE")).toBe("1:1");
    expect(leverageText(3, "PERCENTAGE")).toBe("33:1");
    expect(leverageText(66.7, "PERCENTAGE")).toBe("1.5:1");
  });
  it("non-percentage units: margin shown verbatim, no leverage", () => {
    expect(marginText(500, "ABSOLUTE")).toBe("500 ABSOLUTE");
    expect(leverageText(500, "ABSOLUTE")).toBeNull();
  });
  it("rejects missing values", () => {
    expect(marginText(undefined, "PERCENTAGE")).toBeNull();
    expect(leverageText(0, "PERCENTAGE")).toBeNull();
  });
});

describe("spreadText / priceText / rangePosition", () => {
  it("spread = |offer − bid| at instrument precision", () => {
    expect(spreadText(68.425, 68.457, 3)).toBe("0.032");
    expect(spreadText(1.0851, 1.0853, 4)).toBe("0.0002");
  });
  it("spread falls back to 2 decimals on a bogus precision", () => {
    expect(spreadText(10, 10.5, "x")).toBe("0.50");
  });
  it("priceText renders at precision", () => {
    expect(priceText(66.998, 3)).toBe("66.998");
    expect(priceText(66.998, "x")).toBe("67.00");
    expect(priceText("n/a", 3)).toBeNull();
  });
  it("rangePosition maps price into 0–100 and clamps", () => {
    expect(rangePosition(66.998, 68.758, 68.425)).toBeCloseTo(81.08, 1);
    expect(rangePosition(10, 20, 25)).toBe(100);
    expect(rangePosition(10, 20, 5)).toBe(0);
    expect(rangePosition(20, 10, 15)).toBeNull(); // inverted range
    expect(rangePosition(10, 10, 10)).toBeNull(); // zero-width range
  });
});
