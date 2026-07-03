// SL/TP must stay on the valid side of a reference price (clampLevelToPrice) —
// the market price for an open position, the order's limit for a working order.

import { describe, it, expect, beforeEach } from "vitest";
import { installMemStorage } from "./testMemStorage";

// vitest runs in the 'node' env (see vite.config.ts); provide a tiny in-memory
// localStorage before importing the module under test.
installMemStorage();

const { clampLevelToPrice, brokerLabel, isCapital, migrateCapitalLiveAccountKeys } =
  await import("./trading");

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
