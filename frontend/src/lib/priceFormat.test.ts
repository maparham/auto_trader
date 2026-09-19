import { describe, it, expect } from "vitest";
import { fmtPrice } from "./priceFormat";

describe("fmtPrice", () => {
  it("groups thousands like the chart axis, at the given precision", () => {
    expect(fmtPrice(2622900, 0)).toBe("2,622,900");
    expect(fmtPrice(1234.5, 2)).toBe("1,234.50");
    expect(fmtPrice(999, 0)).toBe("999");
    expect(fmtPrice(1000, 0)).toBe("1,000");
    expect(fmtPrice(0.12345, 5)).toBe("0.12345");
    expect(fmtPrice(-1234567.891, 1)).toBe("-1,234,567.9");
  });

  it("shows exactly the digits toFixed would (stored levels match their labels)", () => {
    for (const [v, p] of [[1.005, 2], [2537530.6, 0], [0.5, 0], [2.5, 0], [1e21, 0], [NaN, 2]] as const) {
      expect(fmtPrice(v, p).replace(/,/g, "")).toBe(v.toFixed(p));
    }
  });

  it("does not throw on a bad precision", () => {
    expect(fmtPrice(1, NaN)).toBe("1.00");
    expect(fmtPrice(1, -3)).toBe("1");
    expect(fmtPrice(1, 99)).toMatch(/^1\.0+$/);
  });
});
