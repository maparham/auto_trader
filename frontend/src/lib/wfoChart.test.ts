// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { wfoEquityPoints, wfoFoldBandPoints } from "./backtest";

const scheme = {
  train_span: "3m",
  folds: [
    { test_from: 100, test_to: 200 }, { test_from: 200, test_to: 300 }, { test_from: 300, test_to: 400 },
  ],
  stitched: { equity: [[100, 10000], [199, 10100]], equity_scaled: [[100, 10000], [199, 10200]], trades: [], metrics: {} },
} as never;

describe("wfo chart helpers", () => {
  it("converts equity to ms and honors compounded flag", () => {
    expect(wfoEquityPoints(scheme, false)).toEqual([[100_000, 10000], [199_000, 10100]]);
    expect(wfoEquityPoints(scheme, true)[1][1]).toBe(10200);
  });
  it("bands alternate test segments in ms", () => {
    expect(wfoFoldBandPoints(scheme)).toEqual([
      { from: 100_000, to: 200_000 }, { from: 300_000, to: 400_000 },
    ]);
  });
});
