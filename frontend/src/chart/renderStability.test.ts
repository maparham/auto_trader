import { describe, it, expect } from "vitest";
import { stableValue, stableArray } from "./renderStability";

describe("stableValue", () => {
  it("keeps the previous identity when all fields match", () => {
    const prev = { y: 10, price: 1.5, countdown: "0:42", w: 60, dir: "up" };
    const next = { y: 10, price: 1.5, countdown: "0:42", w: 60, dir: "up" };
    expect(stableValue(prev, next)).toBe(prev);
  });

  it("returns the next object when any field differs", () => {
    const prev = { y: 10, price: 1.5 };
    const next = { y: 11, price: 1.5 };
    expect(stableValue(prev, next)).toBe(next);
  });

  it("handles null on either side", () => {
    expect(stableValue(null, null)).toBeNull();
    const next = { y: 1 };
    expect(stableValue(null, next)).toBe(next);
    expect(stableValue({ y: 1 }, null)).toBeNull();
  });

  it("does not treat a missing field as equal to an extra one", () => {
    expect(stableValue({ a: 1 }, { a: 1, b: undefined })).not.toBe(null);
    const prev = { a: 1 };
    const next = { a: 1, b: 2 };
    expect(stableValue(prev, next)).toBe(next);
  });
});

describe("stableArray", () => {
  it("keeps the previous identity for two empty arrays", () => {
    const prev: Array<{ id: string }> = [];
    expect(stableArray(prev, [])).toBe(prev);
  });

  it("keeps the previous identity when every element shallow-matches", () => {
    const prev = [{ id: "a", y: 1 }, { id: "b", y: 2 }];
    const next = [{ id: "a", y: 1 }, { id: "b", y: 2 }];
    expect(stableArray(prev, next)).toBe(prev);
  });

  it("returns the next array when an element differs", () => {
    const prev = [{ id: "a", y: 1 }];
    const next = [{ id: "a", y: 2 }];
    expect(stableArray(prev, next)).toBe(next);
  });

  it("returns the next array when the length differs", () => {
    const prev = [{ id: "a", y: 1 }];
    const next: Array<{ id: string; y: number }> = [];
    expect(stableArray(prev, next)).toBe(next);
  });
});
