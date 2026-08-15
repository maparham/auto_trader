// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { installMemStorage } from "./testMemStorage";

installMemStorage();
const { diffIndicatorSync } = await import("./indicators");

describe("diffIndicatorSync", () => {
  it("stored=[a,b], live=[b,c], rebuild={b} → {remove:[c], build:[a,b], keep:[]}", () => {
    expect(diffIndicatorSync(["a", "b"], ["b", "c"], new Set(["b"]))).toEqual({
      remove: ["c"],
      build: ["a", "b"],
      keep: [],
    });
  });
  it("stored=[a,b], live=[b,c], rebuild={} → {remove:[c], build:[a], keep:[b]}", () => {
    expect(diffIndicatorSync(["a", "b"], ["b", "c"], new Set())).toEqual({
      remove: ["c"],
      build: ["a"],
      keep: ["b"],
    });
  });
  it("empty storage removes everything", () => {
    expect(diffIndicatorSync([], ["x"], new Set())).toEqual({
      remove: ["x"],
      build: [],
      keep: [],
    });
  });
});
