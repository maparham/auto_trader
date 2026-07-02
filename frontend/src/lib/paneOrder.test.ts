import { describe, it, expect } from "vitest";
import { arrayMove, planPaneReorder, reorderInstanceList } from "./paneOrder";
import type { IndicatorInstance } from "./persist";

describe("arrayMove", () => {
  it("moves an element down", () => {
    expect(arrayMove(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
  });
  it("moves an element up", () => {
    expect(arrayMove(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
  });
  it("returns a copy, does not mutate", () => {
    const src = ["a", "b"];
    const out = arrayMove(src, 0, 1);
    expect(src).toEqual(["a", "b"]);
    expect(out).toEqual(["b", "a"]);
  });
});

describe("planPaneReorder", () => {
  it("plans a move-down and reports the first divergence index", () => {
    const plan = planPaneReorder(["p1", "p2", "p3"], "p1", 2);
    expect(plan).toEqual({ desired: ["p2", "p3", "p1"], divIndex: 0 });
  });
  it("plans a move-down by one (tail starts at the smaller index)", () => {
    const plan = planPaneReorder(["p1", "p2", "p3"], "p2", 2);
    expect(plan).toEqual({ desired: ["p1", "p3", "p2"], divIndex: 1 });
  });
  it("clamps the target into range", () => {
    const plan = planPaneReorder(["p1", "p2", "p3"], "p3", 99);
    expect(plan).toBeNull(); // already last → clamped to same slot → no-op
  });
  it("returns null when the pane is unknown", () => {
    expect(planPaneReorder(["p1", "p2"], "nope", 0)).toBeNull();
  });
  it("returns null on a no-op (target === current)", () => {
    expect(planPaneReorder(["p1", "p2", "p3"], "p2", 1)).toBeNull();
  });
});

describe("reorderInstanceList", () => {
  const inst = (id: string): IndicatorInstance => ({ id, type: id.replace(/#.*/, "") });
  it("reorders sub-pane ids in place, leaving other entries fixed", () => {
    // EMA is a candle-pane overlay (not in the sub-order); VOL/RSI/MACD are sub-panes.
    const current = [inst("VOL"), inst("EMA"), inst("RSI"), inst("MACD")];
    const out = reorderInstanceList(current, ["RSI", "MACD", "VOL"]);
    expect(out.map((i) => i.id)).toEqual(["RSI", "EMA", "MACD", "VOL"]);
  });
  it("keeps the list unchanged when the sub-order matches", () => {
    const current = [inst("VOL"), inst("RSI")];
    const out = reorderInstanceList(current, ["VOL", "RSI"]);
    expect(out.map((i) => i.id)).toEqual(["VOL", "RSI"]);
  });
});
