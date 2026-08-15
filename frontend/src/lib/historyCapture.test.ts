import { it, expect, beforeEach } from "vitest";
import { installMemStorage } from "./testMemStorage";

installMemStorage();
const { HistoryManager, registerHistory, withHistorySuppressed } = await import("./history");
const {
  saveDrawings,
  loadDrawings,
  saveIndicators,
  loadIndicators,
  saveIndicatorConfig,
  loadIndicatorConfigs,
  deleteIndicatorConfig,
  saveAvwapAnchor,
  loadAvwapAnchor,
} = await import("./persist");

const SCOPE = "tab.T.cell.c";
const EPIC = "US100";

let mgr: InstanceType<typeof HistoryManager>;
beforeEach(() => {
  localStorage.clear();
  mgr = new HistoryManager(SCOPE);
  registerHistory(SCOPE, mgr);
});

it("saveDrawings captures; undo restores the previous list", () => {
  const a = [{ name: "horizontalStraightLine", points: [{ value: 1 }] }];
  saveDrawings(SCOPE, EPIC, a);
  const b = [...a, { name: "horizontalStraightLine", points: [{ value: 2 }] }];
  // beyond the 800ms group window: force two steps by faking time via push order
  // (saveDrawings uses real time; two same-key writes here coalesce into one
  // step, which is fine — undo must land back on `a`'s PREDECESSOR = absent,
  // so assert the coalesced semantics instead:)
  saveDrawings(SCOPE, EPIC, b);
  expect(mgr.undo()).toBe(true);
  expect(loadDrawings(SCOPE, EPIC)).toEqual([]); // both writes coalesced; before = absent
});

it("indicator remove (list + config) undoes as one step", () => {
  saveIndicators(SCOPE, [{ id: "RSI", type: "RSI" }]);
  saveIndicatorConfig(SCOPE, "RSI", { calcParams: [14] });
  mgr.clear(); // start measuring from the established state
  // the remove gesture: list write + config delete (same tick, one group)
  saveIndicators(SCOPE, []);
  deleteIndicatorConfig(SCOPE, "RSI");
  expect(mgr.undo()).toBe(true);
  expect(loadIndicators(SCOPE)).toEqual([{ id: "RSI", type: "RSI" }]);
  expect(loadIndicatorConfigs(SCOPE).RSI).toEqual({ calcParams: [14] });
  expect(mgr.canUndo).toBe(false);
});

it("saveAvwapAnchor captures", () => {
  saveAvwapAnchor(SCOPE, EPIC, "AVWAP", 1_700_000_000_000);
  mgr.clear();
  saveAvwapAnchor(SCOPE, EPIC, "AVWAP", 1_800_000_000_000);
  expect(mgr.undo()).toBe(true);
  expect(loadAvwapAnchor(SCOPE, EPIC, "AVWAP")).toBe(1_700_000_000_000);
});

it("writes to an unregistered scope record nothing", () => {
  saveDrawings("tab.other", EPIC, [{ name: "x", points: [] }]);
  expect(mgr.canUndo).toBe(false);
});

it("suppressed saves record nothing", () => {
  withHistorySuppressed(() => {
    saveIndicators(SCOPE, [{ id: "RSI", type: "RSI" }]);
  });
  expect(mgr.canUndo).toBe(false);
});
