import { describe, it, expect } from "vitest";
import { slopeMetrics } from "./slopeMetrics";

const HOUR = 3_600_000;
const DAY = 86_400_000;

// A 10-bar rising line where price climbs 1% per bar reads as exactly 45°, and its
// rates fall straight out of the deltas. This is the canonical "1%/bar = 45°" anchor.
describe("slopeMetrics", () => {
  it("reads +1%/bar as 45° and reports matching rates", () => {
    const m = slopeMetrics({
      price0: 100,
      price1: 110,
      index0: 0,
      index1: 10,
      time0: 0,
      time1: 10 * HOUR,
      precision: 2,
    });
    expect(m.angleDeg).toBeCloseTo(45, 5);
    expect(m.pctPerBar).toBeCloseTo(1, 5);
    expect(m.pricePerBar).toBeCloseTo(1, 5);
    expect(m.up).toBe(true);
    expect(m.angleText).toBe("45.0°");
  });

  it("gives a negative angle and down direction for a falling line", () => {
    const m = slopeMetrics({
      price0: 110,
      price1: 100,
      index0: 0,
      index1: 10,
      time0: 0,
      time1: 10 * HOUR,
      precision: 2,
    });
    expect(m.angleDeg).toBeLessThan(0);
    expect(m.up).toBe(false);
    // pct is relative to the anchor (earlier) price 110: (-10/110)/10*100
    expect(m.pctPerBar).toBeCloseTo(-0.909, 3);
    expect(m.angleText.startsWith("−")).toBe(true); // unicode minus
  });

  it("normalizes a right-to-left drawn line to the same magnitude", () => {
    const ltr = slopeMetrics({
      price0: 100, price1: 110, index0: 0, index1: 10, time0: 0, time1: 10 * HOUR, precision: 2,
    });
    // Same two points, drawn end-first (index1 < index0).
    const rtl = slopeMetrics({
      price0: 110, price1: 100, index0: 10, index1: 0, time0: 10 * HOUR, time1: 0, precision: 2,
    });
    expect(rtl.angleDeg).toBeCloseTo(ltr.angleDeg, 5);
    expect(rtl.pctPerBar).toBeCloseTo(ltr.pctPerBar, 5);
    expect(rtl.pricePerBar).toBeCloseTo(ltr.pricePerBar, 5);
    expect(rtl.up).toBe(ltr.up);
  });

  it("angle is instrument-independent: same %/bar gives the same angle", () => {
    // EURUSD-scale: +0.1%/bar (1% total over 10 bars: 1.1 → 1.111)
    const fx = slopeMetrics({
      price0: 1.1, price1: 1.111, index0: 0, index1: 10, time0: 0, time1: 10 * HOUR, precision: 4,
    });
    // BTC-scale: +0.1%/bar (500 over 50000 across 10 bars)
    const btc = slopeMetrics({
      price0: 50000, price1: 50500, index0: 0, index1: 10, time0: 0, time1: 10 * HOUR, precision: 1,
    });
    expect(fx.pctPerBar).toBeCloseTo(0.1, 5);
    expect(btc.pctPerBar).toBeCloseTo(0.1, 5);
    expect(fx.angleDeg).toBeCloseTo(btc.angleDeg, 5);
    // price/bar, by contrast, is wildly different (scale-dependent) — that's the point.
    expect(btc.pricePerBar).toBeCloseTo(50, 5);
    expect(fx.pricePerBar).toBeCloseTo(0.0011, 8);
  });

  it("scales the time readout to per-hour for intraday bars", () => {
    const m = slopeMetrics({
      price0: 100, price1: 110, index0: 0, index1: 10, time0: 0, time1: 10 * HOUR, precision: 2,
    });
    expect(m.timeUnit).toBe("hr");
    expect(m.pricePerTime).toBeCloseTo(1, 5); // +10 over 10h = 1/hr
    expect(m.priceTimeText).toBe("1.00/hr");
  });

  it("scales the time readout to per-day for daily bars", () => {
    const m = slopeMetrics({
      price0: 100, price1: 110, index0: 0, index1: 10, time0: 0, time1: 10 * DAY, precision: 2,
    });
    expect(m.timeUnit).toBe("day");
    expect(m.pricePerTime).toBeCloseTo(1, 5); // +10 over 10d = 1/day
  });

  it("uses the base interval for a gap-free price/time (ignores weekend gaps)", () => {
    // 50 bars of 30m = 25h of chart time, but the timestamps span a huge wall-clock gap
    // (a weekend). With baseIntervalMinutes supplied, price/hr = price/bar * 60/30, not
    // distorted by the gap.
    const m = slopeMetrics({
      price0: 100,
      price1: 92.8, // -7.2 over 50 bars → -0.144/bar
      index0: 0,
      index1: 50,
      time0: 0,
      time1: 500 * HOUR, // absurd gap — must NOT affect the result
      precision: 2,
      baseIntervalMinutes: 30,
    });
    expect(m.pricePerBar).toBeCloseTo(-0.144, 5);
    expect(m.timeUnit).toBe("hr");
    // -0.144/bar * (60/30 bars per hr) = -0.288/hr
    expect(m.pricePerTime).toBeCloseTo(-0.288, 5);
  });

  it("rounds price-per-bar text to the instrument precision", () => {
    const m = slopeMetrics({
      price0: 50000, price1: 50500, index0: 0, index1: 10, time0: 0, time1: 10 * HOUR, precision: 1,
    });
    expect(m.priceBarText).toBe("50.0/bar");
  });

  it("handles a degenerate vertical line (Δbars = 0) without exploding", () => {
    const m = slopeMetrics({
      price0: 100, price1: 110, index0: 5, index1: 5, time0: 0, time1: 0, precision: 2,
    });
    expect(m.angleDeg).toBe(90); // straight up
    expect(Number.isFinite(m.pctPerBar)).toBe(true);
    expect(Number.isFinite(m.pricePerBar)).toBe(true);
    expect(m.pctPerBar).toBe(0);
    expect(m.pricePerBar).toBe(0);
  });

  it("reports %/hr matching a slope rule's %/hr operand (5m base)", () => {
    // The EMA(9) case from the slope-verify session: the curve rose
    // 28769.72085 → 28833.62668 over one 5-minute bar. A slope rule reads this as
    // ~2.6655 %/hr; the ruler's new %/hr line must report the same quantity so the
    // two can be compared without mentally multiplying %/bar by bars-per-hour.
    const m = slopeMetrics({
      price0: 28769.72085254716,
      price1: 28833.626682037728,
      index0: 0,
      index1: 1,
      time0: 0,
      time1: 5 * 60_000,
      precision: 2,
      baseIntervalMinutes: 5,
    });
    expect(m.timeUnit).toBe("hr");
    expect(m.pctPerBar).toBeCloseTo(0.2221, 4);
    expect(m.pctPerTime).toBeCloseTo(m.pctPerBar * 12, 9); // 12 five-minute bars per hour
    expect(m.pctPerTime).toBeCloseTo(2.6655, 3);
    expect(m.pctTimeText).toBe("2.67%/hr");
  });

  it("scales %/hr to %/day for daily bars", () => {
    const m = slopeMetrics({
      price0: 100, price1: 110, index0: 0, index1: 10, time0: 0, time1: 10 * DAY, precision: 2,
    });
    expect(m.timeUnit).toBe("day");
    // +1%/bar over daily bars → 1%/day.
    expect(m.pctPerTime).toBeCloseTo(1, 5);
    expect(m.pctTimeText).toBe("1.00%/day");
  });
});
