import { describe, it, expect, beforeEach } from "vitest";
import { installMemStorage } from "./testMemStorage";

installMemStorage();

const { clampPillPos, loadPillPos, savePillPos, clearPillPos, PILL_MARGIN } = await import(
  "./replayPillPos"
);

const CELL = { width: 1000, height: 600 };
const PILL = { width: 400, height: 34 };

beforeEach(() => localStorage.clear());

describe("clampPillPos", () => {
  it("leaves a position that is already inside alone", () => {
    expect(clampPillPos({ x: 200, y: 100 }, CELL, PILL)).toEqual({ x: 200, y: 100 });
  });

  it("pulls a position back from the right and bottom edges", () => {
    const out = clampPillPos({ x: 9999, y: 9999 }, CELL, PILL);
    expect(out.x).toBe(CELL.width - PILL.width - PILL_MARGIN);
    expect(out.y).toBe(CELL.height - PILL.height - PILL_MARGIN);
  });

  it("keeps a margin at the left and top rather than sitting on the border", () => {
    expect(clampPillPos({ x: -50, y: -50 }, CELL, PILL)).toEqual({
      x: PILL_MARGIN,
      y: PILL_MARGIN,
    });
  });

  // A 4-way split: the pill wraps to several rows and can be wider than its
  // cell, which makes the upper bound smaller than the lower one. The left edge
  // has to win, or the pill lands with its controls off the left side.
  it("pins to the left edge when the pill is wider than the cell", () => {
    const narrow = { width: 300, height: 200 };
    const wrapped = { width: 380, height: 68 };
    expect(clampPillPos({ x: 500, y: 20 }, narrow, wrapped).x).toBe(PILL_MARGIN);
  });

  it("does the same vertically in a very short cell", () => {
    const short = { width: 1000, height: 30 };
    expect(clampPillPos({ x: 10, y: 400 }, short, PILL).y).toBe(PILL_MARGIN);
  });
});

describe("the stored position", () => {
  it("is null until something is saved", () => {
    expect(loadPillPos("tab.a")).toBeNull();
  });

  it("round-trips per scope", () => {
    savePillPos("tab.a", { x: 12, y: 34 });
    savePillPos("tab.b", { x: 56, y: 78 });
    expect(loadPillPos("tab.a")).toEqual({ x: 12, y: 34 });
    expect(loadPillPos("tab.b")).toEqual({ x: 56, y: 78 });
  });

  it("replaces a scope's previous position rather than accumulating", () => {
    savePillPos("tab.a", { x: 1, y: 1 });
    savePillPos("tab.a", { x: 2, y: 2 });
    expect(loadPillPos("tab.a")).toEqual({ x: 2, y: 2 });
  });

  // Clearing is what a reset does, and it must leave "no stored position" — not
  // a stored corner, which would stop following the cell as it resizes.
  it("clears back to null, leaving other scopes alone", () => {
    savePillPos("tab.a", { x: 1, y: 1 });
    savePillPos("tab.b", { x: 2, y: 2 });
    clearPillPos("tab.a");
    expect(loadPillPos("tab.a")).toBeNull();
    expect(loadPillPos("tab.b")).toEqual({ x: 2, y: 2 });
  });

  it("clearing an absent scope is a no-op", () => {
    expect(() => clearPillPos("tab.nope")).not.toThrow();
  });

  // No purge path reaches fields inside a flat key, so closing cells would grow
  // this map forever without the cap.
  it("bounds the map so closed cells cannot grow it forever", () => {
    for (let i = 0; i < 60; i++) savePillPos(`tab.${i}`, { x: i, y: i });
    const all = JSON.parse(localStorage.getItem("auto-trader.replayPillPos") ?? "{}");
    expect(Object.keys(all).length).toBeLessThanOrEqual(40);
    // The newest survives, which is the one the user is actually looking at.
    expect(loadPillPos("tab.59")).toEqual({ x: 59, y: 59 });
  });
});
