import { describe, it, expect } from "vitest";
import type { KLineData } from "klinecharts";
import { deriveRows, checkWhere, matches, formatResult, type ScanRow } from "./candleScan";

const DAY = 86_400_000;
const H4 = 4 * 3_600_000;
const t = (iso: string) => Date.parse(iso);
const bar = (time: number, open: number, close: number): KLineData =>
  ({ timestamp: time, open, high: Math.max(open, close), low: Math.min(open, close), close, volume: 0 });

// Thu 2026-11-12, Fri 11-13, Mon 11-16.
const weekBars = [
  bar(t("2026-11-12T00:00:00Z"), 99, 100),
  bar(t("2026-11-13T00:00:00Z"), 100, 101),
  bar(t("2026-11-16T00:00:00Z"), 103, 104),
];

describe("deriveRows", () => {
  it("computes gap% vs the previous close and flags the bar after a weekend", () => {
    const rows = deriveRows(weekBars, DAY);
    expect(rows[0]["gap%"]).toBeNull();
    expect(rows[0]["change%"]).toBeNull();
    expect(rows[0].afterWeekend).toBe(false);
    expect(rows[1].afterWeekend).toBe(false);
    expect(rows[2]["gap%"]).toBe(1.98);
    expect(rows[2].afterWeekend).toBe(true);
  });

  it("dates IG daily bars that open 22:00 UTC by their session", () => {
    const rows = deriveRows([
      bar(t("2026-11-12T22:00:00Z"), 1, 1), // Friday session
      bar(t("2026-11-15T22:00:00Z"), 1, 1), // Monday session
    ], DAY);
    expect(rows[0].weekday).toBe(5);
    expect(rows[1].weekday).toBe(1);
    expect(rows[1].afterWeekend).toBe(true);
  });

  it("uses the UTC weekday and real gaps on 4H bars", () => {
    const rows = deriveRows([
      bar(t("2026-11-13T20:00:00Z"), 1, 1),
      bar(t("2026-11-15T22:00:00Z"), 1, 1),
      bar(t("2026-11-16T20:00:00Z"), 1, 1),
      bar(t("2026-11-17T00:00:00Z"), 1, 1),
    ], H4);
    expect(rows[0].weekday).toBe(5);
    expect(rows[1].afterWeekend).toBe(true);
    expect(rows[3].afterWeekend).toBe(false);
  });

  it("never flags a weekend on a 24/7 market", () => {
    const rows = deriveRows(["13", "14", "15", "16"].map((d) => bar(t(`2026-11-${d}T00:00:00Z`), 1, 1)), DAY);
    expect(rows.map((r) => r.afterWeekend)).toEqual([false, false, false, false]);
  });
});

describe("checkWhere", () => {
  it("names the valid fields for an unknown field", () => {
    expect(() => checkWhere([{ field: "nope", op: ">", value: 0 }])).toThrow(/gap%/);
  });
  it("names the valid ops for an unknown op", () => {
    expect(() => checkWhere([{ field: "gap%", op: "=>", value: 0 }])).toThrow(/>=/);
  });
});

describe("matches", () => {
  const where = checkWhere([
    { field: "gap%", op: ">", value: 0 },
    { field: "afterWeekend", op: "==", value: true },
  ]);
  const rows = deriveRows(weekBars, DAY);
  it("joins conditions with AND", () => {
    expect(matches(rows[2], where)).toBe(true);
    expect(matches(rows[1], where)).toBe(false);
  });
  it("never matches a null field", () => {
    expect(matches(rows[0], checkWhere([{ field: "gap%", op: "<", value: 100 }]))).toBe(false);
  });
});

describe("formatResult", () => {
  it("drops the oldest rows to fit the cap and says how many", () => {
    const rows: ScanRow[] = Array.from({ length: 2000 }, (_, i) => ({
      time: 1_700_000_000_000 + i * DAY, weekday: 1, open: 1.23456, high: 1.3, low: 1.2, close: 1.25,
      "change%": 0.5, "gap%": 0.25, afterWeekend: true,
    }));
    const out = formatResult(
      { epic: "X", resolution: "DAY", scanned: 2000, partial: false, degraded: null },
      rows, ["time", "gap%", "afterWeekend"], 8192,
    );
    expect(out.length).toBeLessThan(8192);
    const j = JSON.parse(out);
    expect(j.matched).toBe(2000);
    expect(j.omitted).toBeGreaterThan(0);
    expect(j.cols).toEqual(["time", "gap%", "afterWeekend"]);
    expect(j.rows.at(-1)[0]).toBe(rows[1999].time);
    expect(j.rows.length + j.omitted).toBe(2000);
  });
});
