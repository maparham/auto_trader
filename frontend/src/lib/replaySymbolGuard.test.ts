import { describe, it, expect } from "vitest";
import { cellsChangingSymbol, replayLossMessage } from "./replaySymbolGuard";

const cell = (id: string, epic: string) => ({ id, symbol: { epic } });
const GRID = [cell("a", "US100"), cell("b", "EURUSD"), cell("c", "US100")];

describe("cellsChangingSymbol", () => {
  it("is just the focused cell when symbol-sync is off", () => {
    expect(
      cellsChangingSymbol(GRID, { focusedId: "b", broadcast: false, nextEpic: "GOLD" }),
    ).toEqual(["b"]);
  });

  it("is every cell in the tab when symbol-sync is on", () => {
    expect(
      cellsChangingSymbol(GRID, { focusedId: "b", broadcast: true, nextEpic: "GOLD" }),
    ).toEqual(["a", "b", "c"]);
  });

  // The half that keeps the dialog from becoming noise: a cell already showing
  // the target symbol is not changing, so it has nothing to lose. Without this,
  // re-picking the symbol a chart already shows would ask to end its session.
  it("skips cells that already show the target symbol", () => {
    expect(
      cellsChangingSymbol(GRID, { focusedId: "a", broadcast: true, nextEpic: "US100" }),
    ).toEqual(["b"]);
  });

  it("skips the focused cell itself when it already shows the target", () => {
    expect(
      cellsChangingSymbol(GRID, { focusedId: "a", broadcast: false, nextEpic: "US100" }),
    ).toEqual([]);
  });

  // Turning symbol-sync ON with every cell already on the same symbol changes
  // nothing, so it must not ask.
  it("is empty when a broadcast would change nothing", () => {
    const same = [cell("a", "US100"), cell("b", "US100")];
    expect(
      cellsChangingSymbol(same, { focusedId: "a", broadcast: true, nextEpic: "US100" }),
    ).toEqual([]);
  });

  it("handles an empty grid", () => {
    expect(cellsChangingSymbol([], { focusedId: "a", broadcast: true, nextEpic: "X" })).toEqual([]);
  });
});

describe("replayLossMessage", () => {
  it("is singular for one session", () => {
    expect(replayLossMessage(1)).toMatch(/^This chart is running/);
    expect(replayLossMessage(1)).not.toMatch(/\d/);
  });

  it("counts them when more than one is at stake", () => {
    expect(replayLossMessage(3)).toMatch(/^3 charts are running/);
  });

  // House style: no em dashes in end-user copy.
  it("uses no em dashes", () => {
    expect(replayLossMessage(1) + replayLossMessage(2)).not.toMatch(/—/);
  });
});
