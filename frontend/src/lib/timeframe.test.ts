import { describe, it, expect } from "vitest";
import corpus from "./timeframes.corpus.json";
import { barEndMs, bucketOpenMs, canonicalTf, tfLabel, tfSecondsOf, TimeframeError, isNativeTf, tryCanonicalTf } from "./timeframe";

interface Row { input: string; canonical?: string; label?: string; seconds?: number; error?: boolean }

describe("timeframe corpus (shared with backend/tests/test_timeframe.py)", () => {
  for (const row of corpus as Row[]) {
    it(row.input || "<empty>", () => {
      if (row.error) {
        expect(() => canonicalTf(row.input)).toThrow(TimeframeError);
        expect(tryCanonicalTf(row.input)).toBeNull();
        expect(tfSecondsOf(row.input)).toBeNull();
        return;
      }
      expect(canonicalTf(row.input)).toBe(row.canonical);
      expect(tfLabel(row.input)).toBe(row.label);
      expect(tfSecondsOf(row.input)).toBe(row.seconds);
    });
  }
});

describe("timeframe helpers", () => {
  it("names the limit", () => {
    expect(() => canonicalTf("HOUR_25")).toThrow("hours must be between 1 and 24");
  });
  it("labels garbage as itself", () => {
    expect(tfLabel("FOO")).toBe("FOO");
  });
  it("ends the last intraday bar of the day at midnight", () => {
    const d = Date.UTC(2026, 6, 5);
    expect(barEndMs("HOUR_5", d + 20 * 3_600_000)).toBe(d + 24 * 3_600_000);
    expect(barEndMs("HOUR_5", d + 15 * 3_600_000)).toBe(d + 20 * 3_600_000);
    expect(barEndMs("MINUTE_7", d + (23 * 60 + 55) * 60_000)).toBe(d + 24 * 3_600_000);
    expect(barEndMs("HOUR_4", d + 20 * 3_600_000)).toBe(d + 24 * 3_600_000);
    expect(barEndMs("FOO", d)).toBeNull();
  });
  it("opens buckets on the grammar's grid, not an epoch grid", () => {
    const d = Date.UTC(2026, 6, 5);
    const H = 3_600_000;
    // 5H tiles each UTC day 00/05/10/15/20; the epoch grid would not.
    expect(bucketOpenMs("HOUR_5", d + 4 * H + 59 * 60_000)).toBe(d);
    expect(bucketOpenMs("HOUR_5", d + 5 * H)).toBe(d + 5 * H);
    expect(bucketOpenMs("5H", d + 23 * H)).toBe(d + 20 * H);
    expect(bucketOpenMs("HOUR_5", d + 24 * H)).toBe(d + 24 * H);
    expect(bucketOpenMs("MINUTE_7", d + 23 * 60_000)).toBe(d + 21 * 60_000);
    // Natives keep the fixed grid.
    expect(bucketOpenMs("HOUR_4", d + 5 * H)).toBe(d + 4 * H);
    // Calendar buckets: January-anchored month groups, YEAR on Jan 1.
    expect(bucketOpenMs("MONTH_5", Date.UTC(2025, 11, 15))).toBe(Date.UTC(2025, 10, 1));
    expect(bucketOpenMs("YEAR", Date.UTC(2025, 6, 1))).toBe(Date.UTC(2025, 0, 1));
    expect(bucketOpenMs("FOO", d)).toBeNull();
  });
  it("ends calendar buckets at the true calendar end (parity: test_mtf_align.py)", () => {
    // A 31-day October closes on Nov 1, not Oct 31 (open + 30d).
    expect(barEndMs("MONTH", Date.UTC(2025, 9, 1))).toBe(Date.UTC(2025, 10, 1));
    expect(barEndMs("MONTH_3", Date.UTC(2025, 9, 1))).toBe(Date.UTC(2026, 0, 1));
    // 5M: the short Nov-Dec tail closes on Jan 1.
    expect(barEndMs("5M", Date.UTC(2025, 10, 1))).toBe(Date.UTC(2026, 0, 1));
    expect(barEndMs("MONTH_5", Date.UTC(2025, 5, 1))).toBe(Date.UTC(2025, 10, 1));
    // YEAR closes on the next Jan 1 (leap years included).
    expect(barEndMs("YEAR", Date.UTC(2024, 0, 1))).toBe(Date.UTC(2025, 0, 1));
    // DAY_N / WEEK_N keep open + N * nominal.
    expect(barEndMs("DAY_2", Date.UTC(2025, 0, 1))).toBe(Date.UTC(2025, 0, 3));
    expect(barEndMs("WEEK_2", Date.UTC(2025, 0, 6))).toBe(Date.UTC(2025, 0, 20));
  });
  it("knows natives", () => {
    expect(isNativeTf("4H")).toBe(true);
    expect(isNativeTf("HOUR_6")).toBe(false);
    expect(isNativeTf("FOO")).toBe(false);
  });
});
