// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { entryMarkerFor, realizedR, reviewOrder, reviewStep, fmtTradeDuration } from "./tradeReview";
import type { StoredBacktestResult } from "./persist";

type Trade = StoredBacktestResult["trades"][number];
type Marker = StoredBacktestResult["markers"][number];

function trade(over: Partial<Trade>): Trade {
  return {
    side: "buy",
    quantity: 1,
    entry_time: 1000,
    entry_price: 100,
    exit_time: 2000,
    exit_price: 101,
    pnl: 1,
    leg: "long",
    reason: "target",
    stop_initial: null,
    stop_final: null,
    target: null,
    ...over,
  } as Trade;
}

describe("reviewOrder", () => {
  const trades = [
    trade({ entry_time: 3000, pnl: -5 }), // 0: loss, latest
    trade({ entry_time: 1000, pnl: 2 }), // 1: win, earliest
    trade({ entry_time: 2000, pnl: -1 }), // 2: loss, middle
    trade({ entry_time: 1500, pnl: 0 }), // 3: breakeven
  ];

  it("selects losses chronologically by entry time (breakeven counts as a loss)", () => {
    expect(reviewOrder(trades, "losses")).toEqual([3, 2, 0]);
  });

  it("selects wins chronologically", () => {
    expect(reviewOrder(trades, "wins")).toEqual([1]);
  });

  it("selects all trades chronologically", () => {
    expect(reviewOrder(trades, "all")).toEqual([1, 3, 2, 0]);
  });

  it("returns [] for an empty cohort", () => {
    expect(reviewOrder([trade({ pnl: 5 })], "losses")).toEqual([]);
  });
});

describe("reviewStep", () => {
  it("advances and retreats within bounds", () => {
    expect(reviewStep(0, 1, 5)).toBe(1);
    expect(reviewStep(3, -1, 5)).toBe(2);
  });

  it("clamps at both ends", () => {
    expect(reviewStep(0, -1, 5)).toBe(0);
    expect(reviewStep(4, 1, 5)).toBe(4);
  });

  it("pins to 0 for an empty order", () => {
    expect(reviewStep(2, 1, 0)).toBe(0);
  });
});

describe("realizedR", () => {
  it("computes R for a long from the initial stop distance", () => {
    // risk 10 (100 -> 90), gain 5 -> +0.5R
    const t = trade({ entry_price: 100, exit_price: 105, stop_initial: 90, leg: "long" });
    expect(realizedR(t)).toBeCloseTo(0.5);
  });

  it("computes R for a short", () => {
    // risk 10 (100 -> 110), price fell 20 -> +2R
    const t = trade({ entry_price: 100, exit_price: 80, stop_initial: 110, leg: "short" });
    expect(realizedR(t)).toBeCloseTo(2);
  });

  it("is negative for a losing trade", () => {
    const t = trade({ entry_price: 100, exit_price: 95, stop_initial: 90, leg: "long" });
    expect(realizedR(t)).toBeCloseTo(-0.5);
  });

  it("returns null without an initial stop or with an inverted stop", () => {
    expect(realizedR(trade({ stop_initial: null }))).toBeNull();
    // long with stop ABOVE entry: no meaningful risk distance
    expect(realizedR(trade({ entry_price: 100, stop_initial: 105, leg: "long" }))).toBeNull();
  });
});

describe("entryMarkerFor", () => {
  const mk = (over: Partial<Marker>): Marker =>
    ({ time: 1000, side: "buy", price: 100, reason: "rule", leg: "long", ...over }) as Marker;

  it("finds the opening marker by time, leg and opening side", () => {
    const markers = [
      mk({ time: 1000, side: "buy", leg: "long", terms: [{ left: "x" }] } as Partial<Marker>),
      mk({ time: 2000, side: "sell", leg: "long" }), // the exit
    ];
    const t = trade({ entry_time: 1000, leg: "long" });
    expect(entryMarkerFor(t, markers)?.terms?.[0]?.left).toBe("x");
  });

  it("uses sell-side markers for short entries", () => {
    const markers = [mk({ time: 1000, side: "sell", leg: "short" })];
    const t = trade({ entry_time: 1000, leg: "short" });
    expect(entryMarkerFor(t, markers)).toBe(markers[0]);
  });

  it("disambiguates same-bar same-leg entries by price", () => {
    const a = mk({ time: 1000, side: "buy", leg: "long", price: 100 });
    const b = mk({ time: 1000, side: "buy", leg: "long", price: 200 });
    const t = trade({ entry_time: 1000, leg: "long", entry_price: 200 });
    expect(entryMarkerFor(t, [a, b])).toBe(b);
  });

  it("returns null when no marker matches", () => {
    expect(entryMarkerFor(trade({ entry_time: 999 }), [mk({})])).toBeNull();
  });
});

describe("fmtTradeDuration", () => {
  it("formats sub-hour, hour and day scale durations", () => {
    expect(fmtTradeDuration(0, 25 * 60)).toBe("25m");
    expect(fmtTradeDuration(0, 3 * 3600 + 25 * 60)).toBe("3h 25m");
    expect(fmtTradeDuration(0, 2 * 86400 + 5 * 3600)).toBe("2d 5h");
  });
});
