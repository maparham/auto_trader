import { describe, it, expect, beforeEach } from "vitest";
import { installMemStorage } from "./testMemStorage";

installMemStorage();
const {
  HistoryManager,
  registerHistory,
  unregisterHistory,
  historyCapture,
  clearHistoryForKey,
  withHistorySuppressed,
  partitionHistorySuffixes,
} = await import("./history");

const SCOPE = "tab.T.cell.c";
const KEY = `auto-trader.${SCOPE}.drawings.US100`;
const KEY2 = `auto-trader.${SCOPE}.indicators`;

let mgr: InstanceType<typeof HistoryManager>;
beforeEach(() => {
  localStorage.clear();
  mgr = new HistoryManager(SCOPE);
  registerHistory(SCOPE, mgr);
});

describe("push / undo / redo", () => {
  it("undo restores `before` through save() and redo restores `after`", () => {
    localStorage.setItem(KEY, JSON.stringify(["a"]));
    mgr.push(KEY, ["a"], ["a", "b"], 1000);
    localStorage.setItem(KEY, JSON.stringify(["a", "b"]));
    expect(mgr.undo()).toBe(true);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(["a"]);
    expect(mgr.redo()).toBe(true);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(["a", "b"]);
  });

  it("undo of a create (before === undefined) removes the key", () => {
    mgr.push(KEY, undefined, ["a"], 1000);
    localStorage.setItem(KEY, JSON.stringify(["a"]));
    expect(mgr.undo()).toBe(true);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("undo with an empty stack returns false", () => {
    expect(mgr.undo()).toBe(false);
    expect(mgr.redo()).toBe(false);
  });

  it("a new push clears the redo stack", () => {
    mgr.push(KEY, ["a"], ["b"], 1000);
    mgr.undo();
    mgr.push(KEY, ["a"], ["c"], 99999);
    expect(mgr.canRedo).toBe(false);
  });
});

describe("grouping and coalescing", () => {
  it("same-key pushes within 800ms coalesce (keep first before, last after)", () => {
    mgr.push(KEY, ["a"], ["b"], 1000);
    mgr.push(KEY, ["b"], ["c"], 1500);
    mgr.undo();
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(["a"]);
    expect(mgr.canUndo).toBe(false); // one step, not two
  });

  it("different-key pushes within 800ms group into ONE step", () => {
    mgr.push(KEY, ["a"], ["b"], 1000);
    mgr.push(KEY2, [{ id: "RSI", type: "RSI" }], [], 1200);
    expect(mgr.undo()).toBe(true);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(["a"]);
    expect(JSON.parse(localStorage.getItem(KEY2)!)).toEqual([{ id: "RSI", type: "RSI" }]);
    expect(mgr.canUndo).toBe(false);
  });

  it("pushes beyond 800ms start a new step", () => {
    mgr.push(KEY, ["a"], ["b"], 1000);
    mgr.push(KEY, ["b"], ["c"], 2000);
    mgr.undo();
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(["b"]);
    expect(mgr.canUndo).toBe(true);
  });

  it("a push after undo/redo never merges into the surviving top step", () => {
    mgr.push(KEY, ["a"], ["b"], 1000);
    mgr.push(KEY, ["b"], ["c"], 2000);
    mgr.undo(); // pops the 2000 step; top is now the 1000 step
    mgr.push(KEY, ["b"], ["d"], 2100); // close in time, must NOT merge
    mgr.undo();
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(["b"]);
    expect(mgr.canUndo).toBe(true);
  });

  it("no-op pushes (before deep-equals after) are discarded", () => {
    mgr.push(KEY, ["a"], ["a"], 1000);
    expect(mgr.canUndo).toBe(false);
  });

  it("caps the undo stack at 100 steps, dropping the oldest", () => {
    for (let i = 0; i < 105; i++) mgr.push(KEY, [i], [i + 1], i * 10000);
    let n = 0;
    while (mgr.undo()) n++;
    expect(n).toBe(100);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual([5]);
  });
});

describe("registry, capture, suppression", () => {
  it("historyCapture reads `before` from storage and records on the scope's manager", () => {
    localStorage.setItem(KEY, JSON.stringify(["a"]));
    historyCapture(SCOPE, KEY, ["a", "b"], 1000);
    localStorage.setItem(KEY, JSON.stringify(["a", "b"]));
    expect(mgr.undo()).toBe(true);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(["a"]);
  });

  it("capture for an unregistered scope is a no-op", () => {
    historyCapture("tab.other", "auto-trader.tab.other.indicators", ["x"], 1000);
    // nothing throws, nothing recorded anywhere
    expect(mgr.canUndo).toBe(false);
  });

  it("withHistorySuppressed drops captures", () => {
    withHistorySuppressed(() => historyCapture(SCOPE, KEY, ["a"], 1000));
    expect(mgr.canUndo).toBe(false);
  });

  it("clearHistoryForKey clears the owning scope's stacks (prefix match, no scope bleed)", () => {
    mgr.push(KEY, ["a"], ["b"], 1000);
    clearHistoryForKey("auto-trader.tab.T.cell.OTHER.drawings.US100");
    expect(mgr.canUndo).toBe(true); // different scope untouched
    clearHistoryForKey(KEY);
    expect(mgr.canUndo).toBe(false);
    expect(mgr.canRedo).toBe(false);
  });

  it("unregisterHistory only removes the registered instance", () => {
    const other = new HistoryManager(SCOPE);
    unregisterHistory(SCOPE, other); // not the registered one: no-op
    historyCapture(SCOPE, KEY, ["z"], 1000);
    expect(mgr.canUndo).toBe(true);
    unregisterHistory(SCOPE, mgr);
    historyCapture(SCOPE, KEY, ["zz"], 5000);
    // Verify only one step exists: the pre-unregister capture; post-unregister must not have landed
    expect(mgr.undo()).toBe(true); // first step exists
    expect(mgr.undo()).toBe(false); // no second step: unregistration worked
  });
});

describe("applier", () => {
  it("undo notifies the applier with deltas carrying before/after and suffix", () => {
    const seen: Array<Array<{ suffix: string; before: unknown; after: unknown }>> = [];
    mgr.setApplier((d) => seen.push(d));
    mgr.push(KEY, ["a"], ["b"], 1000);
    mgr.push(KEY2, ["x"], ["y"], 1100);
    mgr.undo();
    // Verify suffixes match old expectation
    expect(seen[0]!.map((d) => d.suffix)).toEqual(["drawings.US100", "indicators"]);
    // Verify before/after values
    expect(seen[0]![0]).toEqual({ suffix: "drawings.US100", before: ["a"], after: ["b"] });
    expect(seen[0]![1]).toEqual({ suffix: "indicators", before: ["x"], after: ["y"] });
  });
});

describe("partitionHistorySuffixes", () => {
  it("classifies suffixes for the current epic", () => {
    expect(
      partitionHistorySuffixes(
        ["drawings.US100", "indicators", "indicatorConfig", "avwap.US100.AVWAP", "avwap.DE40.x"],
        "US100",
      ),
    ).toEqual({ drawings: true, indicators: true, avwapIds: ["AVWAP"] });
    expect(partitionHistorySuffixes(["drawings.DE40"], "US100")).toEqual({
      drawings: false,
      indicators: false,
      avwapIds: [],
    });
  });
});
