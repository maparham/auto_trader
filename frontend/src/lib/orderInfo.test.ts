import { describe, it, expect } from "vitest";
import { computeOrderInfo, usedMargin } from "./orderInfo";

const base = {
  quantity: 100,
  price: 70,
  stop: null,
  takeProfit: null,
  leverage: 10,
  balance: 100_000,
  usedMargin: 0,
};

describe("computeOrderInfo", () => {
  it("returns null without a price or size", () => {
    expect(computeOrderInfo({ ...base, price: null })).toBeNull();
    expect(computeOrderInfo({ ...base, quantity: 0 })).toBeNull();
  });

  it("computes trade value and margin from leverage", () => {
    const r = computeOrderInfo(base)!;
    expect(r.tradeValue).toBe(7000); // 100 * 70
    expect(r.margin).toBe(700); // 7000 / 10
    expect(r.available).toBe(100_000);
    expect(r.overLeveraged).toBe(false);
  });

  it("flags over-leverage when margin exceeds available", () => {
    const r = computeOrderInfo({ ...base, balance: 500, leverage: 1 })!;
    expect(r.margin).toBe(7000);
    expect(r.overLeveraged).toBe(true);
    expect(r.marginRatio).toBe(1);
  });

  it("computes reward cash + percent and R:R", () => {
    const r = computeOrderInfo({ ...base, stop: 69, takeProfit: 72 })!;
    expect(r.rewardCash).toBe(200); // |72-70| * 100
    expect(r.rewardPct).toBeCloseTo((2 / 70) * 100, 6);
    expect(r.riskCash).toBe(100); // |70-69| * 100
    expect(r.rr).toBe(2); // 200 / 100
  });

  it("reward null when no take-profit", () => {
    const r = computeOrderInfo(base)!;
    expect(r.rewardCash).toBeNull();
    expect(r.rr).toBeNull();
  });

  it("uses the broker's real available when provided (live account)", () => {
    // A live account passes the broker's true free margin; it overrides the
    // balance − usedMargin estimate and drives margin ratio / over-leverage.
    const r = computeOrderInfo({ ...base, balance: 1421.32, available: 1243.21 })!;
    expect(r.available).toBe(1243.21);
    expect(r.marginRatio).toBeCloseTo(700 / 1243.21, 6);
    expect(r.overLeveraged).toBe(false);
  });
});

describe("usedMargin", () => {
  it("sums position notional / leverage", () => {
    const m = usedMargin(
      [
        { priceLevel: 100, quantity: 2 }, // 200
        { priceLevel: 50, quantity: 4 }, // 200
      ],
      10,
    );
    expect(m).toBe(40); // 400 / 10
  });

  it("is zero with no positions", () => {
    expect(usedMargin([], 10)).toBe(0);
  });
});
