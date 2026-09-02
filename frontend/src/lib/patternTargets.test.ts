import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  registerPatternTarget,
  listPatternTargets,
  getPatternTarget,
  clearPatternTargets,
  setPendingPatternJump,
  takePendingPatternJump,
  clearPendingPatternJumps,
  type PatternTarget,
} from "./patternTargets";
import type { PatternMatch } from "./patternSearch";

const target = (cellId: string, epic = "US100", resolution = "MINUTE_5"): PatternTarget => ({
  cellId,
  epic,
  resolution,
  label: "5m",
  showMatch: vi.fn(),
  clearMatchBands: vi.fn(),
});

beforeEach(() => clearPatternTargets());

describe("patternTargets", () => {
  it("lists registered targets in registration order", () => {
    registerPatternTarget(target("a"));
    registerPatternTarget(target("b", "GOLD"));
    expect(listPatternTargets().map((t) => t.cellId)).toEqual(["a", "b"]);
  });

  it("re-registering a cell replaces its entry instead of duplicating it", () => {
    registerPatternTarget(target("a", "US100"));
    registerPatternTarget(target("a", "GOLD"));
    const targets = listPatternTargets();
    expect(targets).toHaveLength(1);
    expect(targets[0].epic).toBe("GOLD");
  });

  it("unregistering removes the cell", () => {
    const off = registerPatternTarget(target("a"));
    registerPatternTarget(target("b"));
    off();
    expect(listPatternTargets().map((t) => t.cellId)).toEqual(["b"]);
  });

  it("a stale unregister does not remove a newer registration for the same cell", () => {
    // ChartCore re-registers on epic change; effect cleanup order can run the
    // OLD registration's cleanup after the new registration landed.
    const offOld = registerPatternTarget(target("a", "US100"));
    registerPatternTarget(target("a", "GOLD"));
    offOld();
    expect(getPatternTarget("a")?.epic).toBe("GOLD");
  });

  it("getPatternTarget finds a cell by id", () => {
    registerPatternTarget(target("a"));
    expect(getPatternTarget("a")?.cellId).toBe("a");
    expect(getPatternTarget("missing")).toBeUndefined();
  });
});

describe("pending pattern jumps", () => {
  const match: PatternMatch = {
    ts: 100, endTs: 200, distance: 0.3,
    bars: [], forward: [], forwardComplete: true, forwardPct: 1,
  };

  beforeEach(() => clearPendingPatternJumps());

  it("take consumes a parked jump exactly once", () => {
    setPendingPatternJump("cell-9", match);
    expect(takePendingPatternJump("cell-9")).toBe(match);
    expect(takePendingPatternJump("cell-9")).toBeUndefined();
  });

  it("take for a cell with nothing parked yields nothing", () => {
    expect(takePendingPatternJump("cell-9")).toBeUndefined();
  });

  it("a newer park for the same cell replaces the older one", () => {
    setPendingPatternJump("cell-9", match);
    const newer = { ...match, ts: 999 };
    setPendingPatternJump("cell-9", newer);
    expect(takePendingPatternJump("cell-9")?.ts).toBe(999);
  });

  it("clear drops every parked jump", () => {
    setPendingPatternJump("cell-9", match);
    clearPendingPatternJumps();
    expect(takePendingPatternJump("cell-9")).toBeUndefined();
  });
});
