// SL/TP must stay on the valid side of the latest price (clampLevelToPrice).

import { describe, it, expect } from "vitest";
import { clampLevelToPrice } from "./trading";

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
});
