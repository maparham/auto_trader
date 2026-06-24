import { describe, it, expect } from "vitest";
import {
  formatRemaining,
  resolveExpiry,
  endOfDay,
  expiryOptions,
  matchExpiryOption,
} from "./alertUi";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("formatRemaining", () => {
  it("shows the largest two non-zero units, down to minutes", () => {
    expect(formatRemaining(DAY + 6 * HOUR)).toBe("1d, 6h");
    expect(formatRemaining(6 * HOUR + 12 * MIN)).toBe("6h, 12m");
    expect(formatRemaining(12 * MIN)).toBe("12m");
  });

  it("drops zero middle units (keeps the two that exist)", () => {
    expect(formatRemaining(DAY + 30 * MIN)).toBe("1d, 30m");
    expect(formatRemaining(2 * DAY)).toBe("2d");
  });

  it("sub-minute → <1m, expired → expired", () => {
    expect(formatRemaining(30_000)).toBe("<1m");
    expect(formatRemaining(0)).toBe("expired");
    expect(formatRemaining(-5)).toBe("expired");
  });
});

describe("resolveExpiry", () => {
  const now = 1_000_000;
  it("open-ended → null", () => {
    expect(resolveExpiry({ kind: "open" }, now)).toBeNull();
  });
  it("duration → now + ms", () => {
    expect(resolveExpiry({ kind: "duration", ms: DAY }, now)).toBe(now + DAY);
  });
  it("datetime → the fixed time as-is", () => {
    expect(resolveExpiry({ kind: "datetime", at: 5_000_000 }, now)).toBe(5_000_000);
  });
});

describe("endOfDay", () => {
  it("is today at 23:59 local time", () => {
    const now = new Date(2026, 5, 24, 14, 7, 30).getTime();
    const eod = new Date(endOfDay(now));
    expect(eod.getFullYear()).toBe(2026);
    expect(eod.getMonth()).toBe(5);
    expect(eod.getDate()).toBe(24);
    expect(eod.getHours()).toBe(23);
    expect(eod.getMinutes()).toBe(59);
    expect(eod.getTime()).toBeGreaterThan(now);
  });
});

describe("matchExpiryOption", () => {
  const now = new Date(2026, 5, 24, 14, 7, 0).getTime();
  it("null → open", () => {
    expect(matchExpiryOption(null, now)).toBe("open");
  });
  it("a preset timestamp resolves back to its option", () => {
    const opts = expiryOptions(now);
    for (const o of opts) {
      if ("expiresAt" in o && o.expiresAt != null) {
        expect(matchExpiryOption(o.expiresAt, now)).toBe(o.id);
      }
    }
  });
  it("tolerates sub-minute drift on a preset", () => {
    expect(matchExpiryOption(now + HOUR + 30_000, now)).toBe("1h");
  });
  it("an unrecognized timestamp → custom", () => {
    expect(matchExpiryOption(now + 3 * DAY, now)).toBe("custom");
  });
});
