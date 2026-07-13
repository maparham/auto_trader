import { describe, it, expect } from "vitest";
import { downsampleEquity, EQUITY_PERSIST_CAP } from "./equityDownsample";
import type { EquityPoint } from "../api";

const series = (n: number): EquityPoint[] =>
  Array.from({ length: n }, (_, i) => ({ time: 1000 + i, value: i + 0.123456 }));

describe("downsampleEquity", () => {
  it("returns empty for empty input", () => {
    expect(downsampleEquity([])).toEqual([]);
  });

  it("at/under the cap: keeps all points but rounds values to 2 dp", () => {
    const out = downsampleEquity(series(5), 10);
    expect(out).toHaveLength(5);
    expect(out[0].value).toBe(0.12);
    expect(out[4].value).toBe(4.12);
    expect(out.map((p) => p.time)).toEqual([1000, 1001, 1002, 1003, 1004]);
  });

  it("over the cap: thins to <= cap+1 and preserves first and last", () => {
    const n = 37128;
    const out = downsampleEquity(series(n), EQUITY_PERSIST_CAP);
    expect(out.length).toBeLessThanOrEqual(EQUITY_PERSIST_CAP + 1);
    expect(out.length).toBeGreaterThan(1000);
    expect(out[0].time).toBe(1000);
    expect(out[out.length - 1].time).toBe(1000 + n - 1); // last point always kept
  });

  it("keeps ascending time order", () => {
    const out = downsampleEquity(series(10000), 500);
    for (let i = 1; i < out.length; i++) {
      expect(out[i].time).toBeGreaterThan(out[i - 1].time);
    }
  });

  it("defaults cap to EQUITY_PERSIST_CAP", () => {
    expect(downsampleEquity(series(50000)).length).toBeLessThanOrEqual(EQUITY_PERSIST_CAP + 1);
  });
});
