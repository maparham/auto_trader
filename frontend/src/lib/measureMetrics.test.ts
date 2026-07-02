import { describe, it, expect } from "vitest";
import { measureMetrics, formatDuration } from "./measureMetrics";

const HOUR = 3600000;
const MIN = 60000;

describe("formatDuration", () => {
  it("formats minutes / hours / days as at most two units", () => {
    expect(formatDuration(15 * MIN)).toBe("15m");
    expect(formatDuration(2 * HOUR + 15 * MIN)).toBe("2h 15m");
    expect(formatDuration(2 * HOUR)).toBe("2h");
    expect(formatDuration(25 * HOUR)).toBe("1d 1h");
    expect(formatDuration(48 * HOUR)).toBe("2d");
  });

  it("rounds to whole minutes and is sign-agnostic", () => {
    expect(formatDuration(-2 * HOUR)).toBe("2h");
    expect(formatDuration(20000)).toBe("0m");
  });
});

describe("measureMetrics", () => {
  it("matches the TradingView down-move readout", () => {
    // −0.293 on a price of ~69.76, precision 3 → −0.42%, −293 ticks, over 25 bars / 2h15m.
    const m = measureMetrics({
      price0: 69.76,
      price1: 69.467,
      index0: 100,
      index1: 125,
      time0: 0,
      time1: 2 * HOUR + 15 * MIN,
      precision: 3,
    });
    expect(m.up).toBe(false);
    expect(m.ticks).toBe(-293);
    expect(m.bars).toBe(25);
    expect(m.line1).toBe("−0.293 (−0.42%) −293");
    expect(m.line2).toBe("25 bars, 2h 15m");
  });

  it("marks an up move green and shows no sign on positives", () => {
    const m = measureMetrics({
      price0: 100,
      price1: 101,
      index0: 0,
      index1: 1,
      time0: 0,
      time1: MIN,
      precision: 2,
    });
    expect(m.up).toBe(true);
    expect(m.ticks).toBe(100);
    expect(m.bars).toBe(1);
    expect(m.line1).toBe("1.00 (1.00%) 100");
    expect(m.line2).toBe("1 bar, 1m");
  });

  it("rounds ticks to the instrument min-tick from precision", () => {
    // precision 1 → min-tick 0.1; a 2.34 move is ~23 ticks.
    expect(measureMetrics({ price0: 10, price1: 12.34, index0: 0, index1: 3, time0: 0, time1: HOUR, precision: 1 }).ticks).toBe(23);
    // precision 0 → min-tick 1.
    expect(measureMetrics({ price0: 10, price1: 15, index0: 0, index1: 3, time0: 0, time1: HOUR, precision: 0 }).ticks).toBe(5);
  });

  it("bars is the absolute index span regardless of drag direction", () => {
    const m = measureMetrics({ price0: 5, price1: 4, index0: 130, index1: 100, time0: 5 * HOUR, time1: 0, precision: 2 });
    expect(m.bars).toBe(30);
    expect(m.ms).toBe(5 * HOUR);
  });
});
