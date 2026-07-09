// SL/TP must stay on the valid side of a reference price (clampLevelToPrice) —
// the market price for an open position, the order's limit for a working order.

import { describe, it, expect, beforeEach } from "vitest";
import { installMemStorage } from "./testMemStorage";

// vitest runs in the 'node' env (see vite.config.ts); provide a tiny in-memory
// localStorage before importing the module under test.
installMemStorage();

const {
  clampLevelToPrice,
  brokerLabel,
  noteBrokerLabels,
  isCapital,
  migrateCapitalLiveAccountKeys,
  isBreakeven,
  isBreakevenTarget,
  breakevenEligible,
  breakevenTargetEligible,
} = await import("./trading");

const TICK = 0.01;
const PRICE = 100;

describe("clampLevelToPrice", () => {
  // LONG: stop below the price, take-profit above it.
  it("long stop is clamped to just below the price when dragged above", () => {
    expect(clampLevelToPrice("stop", "buy", PRICE, 105, TICK)).toBe(99.99);
  });
  it("long stop is left alone when already below", () => {
    expect(clampLevelToPrice("stop", "buy", PRICE, 95, TICK)).toBe(95);
  });
  it("long take-profit is clamped to just above the price when dragged below", () => {
    expect(clampLevelToPrice("tp", "buy", PRICE, 90, TICK)).toBe(100.01);
  });
  it("long take-profit is left alone when already above", () => {
    expect(clampLevelToPrice("tp", "buy", PRICE, 110, TICK)).toBe(110);
  });

  // SHORT: reversed — stop above the price, take-profit below it.
  it("short stop is clamped to just above the price when dragged below", () => {
    expect(clampLevelToPrice("stop", "sell", PRICE, 95, TICK)).toBe(100.01);
  });
  it("short stop is left alone when already above", () => {
    expect(clampLevelToPrice("stop", "sell", PRICE, 105, TICK)).toBe(105);
  });
  it("short take-profit is clamped to just below the price when dragged above", () => {
    expect(clampLevelToPrice("tp", "sell", PRICE, 110, TICK)).toBe(99.99);
  });
  it("short take-profit is left alone when already below", () => {
    expect(clampLevelToPrice("tp", "sell", PRICE, 90, TICK)).toBe(90);
  });

  // WORKING ORDER: the reference passed is the order's LIMIT, not the market. So a
  // long buy-limit at 100 with the market up at 108 can still take profit anywhere
  // above 100 — the clamp knows nothing about 108, only the limit it was handed.
  it("working long TP below the market is preserved when above the limit reference", () => {
    const LIMIT = 100;
    expect(clampLevelToPrice("tp", "buy", LIMIT, 103, TICK)).toBe(103);
  });
  it("working long SL is measured from the limit, not the market", () => {
    const LIMIT = 100;
    expect(clampLevelToPrice("stop", "buy", LIMIT, 101, TICK)).toBe(99.99);
  });
});

describe("capital feed labels + isCapital", () => {
  it("labels both capital feeds distinctly", () => {
    expect(brokerLabel("capital")).toBe("Capital.com (demo)");
    expect(brokerLabel("capital-live")).toBe("Capital.com (live)");
  });
  it("isCapital matches both feeds, not others", () => {
    expect(isCapital("capital")).toBe(true);
    expect(isCapital("capital-live")).toBe(true);
    expect(isCapital("ig-live")).toBe(false);
  });
});

describe("backend-reported broker labels", () => {
  it("falls back to a capitalized id for an unknown broker with no label", () => {
    expect(brokerLabel("mt5")).toBe("Mt5");
  });
  it("prefers the backend label over the static map and the fallback", () => {
    noteBrokerLabels({ mt5: "Ava Trade Ltd (demo)", capital: "Capital (renamed)" });
    expect(brokerLabel("mt5")).toBe("Ava Trade Ltd (demo)");
    expect(brokerLabel("capital")).toBe("Capital (renamed)");
    // A later payload without labels keeps the last-known names.
    noteBrokerLabels(undefined);
    expect(brokerLabel("mt5")).toBe("Ava Trade Ltd (demo)");
    // Cleanup: restore the static labels for other describe blocks.
    noteBrokerLabels({});
    expect(brokerLabel("capital")).toBe("Capital.com (demo)");
  });
});

describe("capital:live → capital-live:live migration", () => {
  beforeEach(() => localStorage.clear());

  it("rewrites activeAccount and lastAccountByBroker once", () => {
    localStorage.setItem("activeAccount", "capital:live");
    localStorage.setItem(
      "lastAccountByBroker",
      JSON.stringify({ capital: "capital:live" }),
    );
    migrateCapitalLiveAccountKeys();
    expect(localStorage.getItem("activeAccount")).toBe("capital-live:live");
    const map = JSON.parse(localStorage.getItem("lastAccountByBroker")!);
    expect(map["capital-live"]).toBe("capital-live:live");
    // re-run is a no-op (sentinel)
    localStorage.setItem("activeAccount", "capital:paper");
    migrateCapitalLiveAccountKeys();
    expect(localStorage.getItem("activeAccount")).toBe("capital:paper");
  });

  it("leaves a demo-paper user untouched", () => {
    localStorage.setItem("activeAccount", "capital:paper");
    migrateCapitalLiveAccountKeys();
    expect(localStorage.getItem("activeAccount")).toBe("capital:paper");
  });

  it("does NOT seed a live entry for a demo-only user (no real-money default)", () => {
    // A user who never used the real-money account but already has a
    // lastAccountByBroker map must not be silently defaulted into capital-live:live.
    localStorage.setItem("activeAccount", "capital:paper");
    localStorage.setItem(
      "lastAccountByBroker",
      JSON.stringify({ capital: "capital:paper", "ig-demo": "ig-demo:demo" }),
    );
    migrateCapitalLiveAccountKeys();
    const map = JSON.parse(localStorage.getItem("lastAccountByBroker")!);
    expect(map["capital-live"]).toBeUndefined();
    expect(map["capital"]).toBe("capital:paper");
  });
});

describe("isBreakeven", () => {
  it("true when stop equals price", () => {
    expect(isBreakeven(100, 100, 2)).toBe(true);
  });
  it("true when within one tick", () => {
    expect(isBreakeven(100, 100.004, 2)).toBe(true); // tick = 0.01
  });
  it("false when a full tick apart", () => {
    expect(isBreakeven(100, 100.01, 2)).toBe(false);
  });
  it("false when either level is null", () => {
    expect(isBreakeven(null, 100, 2)).toBe(false);
    expect(isBreakeven(100, null, 2)).toBe(false);
  });
  it("respects precision (5dp: 0.00001 tick)", () => {
    expect(isBreakeven(1.23456, 1.234569, 5)).toBe(true);
    expect(isBreakeven(1.23456, 1.23457, 5)).toBe(false);
  });
  it("true just inside one tick (float-noise guard doesn't over-exclude)", () => {
    expect(isBreakeven(100, 100.0099, 2)).toBe(true);
  });
});

describe("breakevenEligible", () => {
  const pos = (over = {}) => ({
    kind: "position" as const, id: "D1", epic: "EURUSD", side: "buy" as const,
    quantity: 2, priceLevel: 100, stop: null, takeProfit: null, upnl: null,
    openedAt: null, leverage: null, margin: null, ...over,
  });
  it("long in profit (price above entry) is eligible", () => {
    expect(breakevenEligible(pos(), 101, 2)).toBe(true);
  });
  it("long at a loss (price below entry) is NOT eligible", () => {
    expect(breakevenEligible(pos(), 99, 2)).toBe(false);
  });
  it("short in profit (price below entry) is eligible", () => {
    expect(breakevenEligible(pos({ side: "sell" }), 99, 2)).toBe(true);
  });
  it("not eligible without a latest price", () => {
    expect(breakevenEligible(pos(), null, 2)).toBe(false);
  });
  it("not eligible for a resting order", () => {
    expect(breakevenEligible(pos({ kind: "order" }), 101, 2)).toBe(false);
  });
  it("not eligible when the stop is already at breakeven", () => {
    expect(breakevenEligible(pos({ stop: 100 }), 101, 2)).toBe(false);
  });
  it("rounds entry to precision before the side check (sub-tick sliver)", () => {
    // entry 100.507 rounds to 100.51 at 2dp; latest 100.509 is barely in profit
    // but round(entry) 100.51 is NOT below it → staging BE would be rejected → hide.
    expect(breakevenEligible(pos({ priceLevel: 100.507 }), 100.509, 2)).toBe(false);
  });
});

describe("isBreakevenTarget", () => {
  it("true when the take-profit equals price", () => {
    expect(isBreakevenTarget(100, 100, 2)).toBe(true);
  });
  it("true when within one tick", () => {
    expect(isBreakevenTarget(100, 100.004, 2)).toBe(true); // tick = 0.01
  });
  it("false when a full tick apart", () => {
    expect(isBreakevenTarget(100, 100.01, 2)).toBe(false);
  });
  it("false when either level is null", () => {
    expect(isBreakevenTarget(null, 100, 2)).toBe(false);
    expect(isBreakevenTarget(100, null, 2)).toBe(false);
  });
  it("respects precision (5dp: 0.00001 tick)", () => {
    expect(isBreakevenTarget(1.23456, 1.234569, 5)).toBe(true);
    expect(isBreakevenTarget(1.23456, 1.23457, 5)).toBe(false);
  });
});

describe("breakevenTargetEligible", () => {
  const pos = (over = {}) => ({
    kind: "position" as const, id: "D1", epic: "EURUSD", side: "buy" as const,
    quantity: 2, priceLevel: 100, stop: null, takeProfit: null, upnl: null,
    openedAt: null, leverage: null, margin: null, ...over,
  });
  it("long at a loss (price below entry) is eligible", () => {
    expect(breakevenTargetEligible(pos(), 99, 2)).toBe(true);
  });
  it("long in profit (price above entry) is NOT eligible", () => {
    expect(breakevenTargetEligible(pos(), 101, 2)).toBe(false);
  });
  it("short at a loss (price above entry) is eligible", () => {
    expect(breakevenTargetEligible(pos({ side: "sell" }), 101, 2)).toBe(true);
  });
  it("not eligible without a latest price", () => {
    expect(breakevenTargetEligible(pos(), null, 2)).toBe(false);
  });
  it("not eligible for a resting order", () => {
    expect(breakevenTargetEligible(pos({ kind: "order" }), 99, 2)).toBe(false);
  });
  it("not eligible when the take-profit is already at breakeven", () => {
    expect(breakevenTargetEligible(pos({ takeProfit: 100 }), 99, 2)).toBe(false);
  });
  it("rounds entry to precision before the side check (sub-tick sliver)", () => {
    // entry 100.504 rounds to 100.50 at 2dp; latest 100.503 is barely at a loss
    // (raw entry above it) but round(entry) 100.50 is NOT above 100.503 → staging TP
    // there would be rejected (TP must sit above the market for a long) → hide.
    expect(breakevenTargetEligible(pos({ priceLevel: 100.504 }), 100.503, 2)).toBe(false);
  });
});
