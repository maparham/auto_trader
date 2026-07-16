import { describe, expect, it } from "vitest";
import type { SweepAxis } from "./sweep";
import { refineAxesAround, sampleCombos } from "./sweepSearch";

const range = (target: string, from: number, to: number, step: number): SweepAxis =>
  ({ kind: "range", target, label: target, from, to, step });

describe("refineAxesAround", () => {
  it("halves the step and re-centers within the original bounds", () => {
    const [a] = refineAxesAround([range("param:p", 5, 50, 5)], { "param:p": 20 });
    // Integer-domain axis: halved step (2.5) rounds up to a whole 3 so refined
    // grid values stay integers, never fractional lengths/counts.
    expect(a).toMatchObject({ kind: "range", from: 15, to: 25, step: 3 });
  });
  it("clamps at the original endpoints", () => {
    const [a] = refineAxesAround([range("param:p", 5, 50, 5)], { "param:p": 5 });
    expect(a).toMatchObject({ from: 5, to: 10 });
  });
  it("keeps an integer step-1 axis integer (from v-1 to v+1, step 1)", () => {
    const [a] = refineAxesAround([range("param:p", 5, 50, 1)], { "param:p": 20 });
    expect(a).toMatchObject({ kind: "range", from: 19, to: 21, step: 1 });
  });
  it("rounds a halved integer step to a whole number", () => {
    const [a] = refineAxesAround([range("param:p", 5, 50, 4)], { "param:p": 20 });
    expect(a).toMatchObject({ kind: "range", from: 16, to: 24, step: 2 });
  });
  it("still halves a fractional-domain axis into fractional steps", () => {
    const [a] = refineAxesAround([range("param:p", 0.5, 5, 0.5)], { "param:p": 2 });
    expect(a).toMatchObject({ kind: "range", step: 0.25 });
  });
  it("falls back to the float path when the combo value is fractional", () => {
    const [a] = refineAxesAround([range("param:p", 5, 50, 4)], { "param:p": 20.5 });
    expect(a).toMatchObject({ kind: "range", step: 2 });
  });
  it("collapses a list axis to the selected option", () => {
    const list: SweepAxis = { kind: "list", target: "op:x", label: "op", options: [
      { label: "gt", patch: { "op:x": "gt" } }, { label: "lt", patch: { "op:x": "lt" } }] };
    const [a] = refineAxesAround([list], { "op:x": "lt" });
    expect(a.kind === "list" && a.options).toEqual([{ label: "lt", patch: { "op:x": "lt" } }]);
  });
});

describe("sampleCombos", () => {
  const axes = [range("param:a", 1, 100, 1), range("param:b", 1, 100, 1)];

  it("is deterministic for a seed and unique", () => {
    const s1 = sampleCombos(axes, 50, 42);
    const s2 = sampleCombos(axes, 50, 42);
    expect(s1).toEqual(s2);
    expect(new Set(s1.map((c) => JSON.stringify(c))).size).toBe(50);
  });

  it("draws only grid values", () => {
    for (const c of sampleCombos(axes, 20, 7)) {
      expect(Number.isInteger(c["param:a"])).toBe(true);
      expect(c["param:a"]).toBeGreaterThanOrEqual(1);
      expect(c["param:a"]).toBeLessThanOrEqual(100);
    }
  });

  it("caps at the grid size when n exceeds it", () => {
    const tiny = [range("param:a", 1, 3, 1)];
    expect(sampleCombos(tiny, 10, 1).length).toBeLessThanOrEqual(3);
  });

  it("writes a synced-risk axis's mirror key with the same value", () => {
    const mirrored: SweepAxis = { kind: "range", target: "risk:long.stop.value",
      label: "stop", from: 1, to: 100, step: 1, mirrorTarget: "risk:short.stop.value" };
    for (const c of sampleCombos([mirrored], 10, 3)) {
      expect(c["risk:short.stop.value"]).toBe(c["risk:long.stop.value"]);
    }
  });
});
