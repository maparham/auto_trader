// Trade selection coupling: setTradeSelected is the single writer of editTradeSignal
// and drives the panel + per-switch pending discard. These are plain signals, so the
// highest-risk wiring is unit-testable without a runtime.

import { describe, it, expect, beforeEach } from "vitest";
import {
  tradeLineUiSignal,
  editTradeSignal,
  tradePanelOpen,
  pendingEditsSignal,
  setTradeSelected,
  toggleTradeSelected,
  toggleTradeHidden,
} from "./signals";

describe("setTradeSelected coupling", () => {
  beforeEach(() => {
    tradeLineUiSignal.set({ hidden: [], hovered: null, selected: null, selectedField: null });
    editTradeSignal.set(null);
    tradePanelOpen.set(false);
    pendingEditsSignal.set({});
  });

  it("loads the trade into edit mode and reveals the panel", () => {
    setTradeSelected("A");
    expect(tradeLineUiSignal.value.selected).toBe("A");
    expect(editTradeSignal.value).toBe("A");
    expect(tradePanelOpen.value).toBe(true);
  });

  it("switching trades discards the outgoing trade's pending, not the incoming's", () => {
    pendingEditsSignal.set({ A: { stop: 1 }, B: { takeProfit: 2 } });
    setTradeSelected("A");
    setTradeSelected("B");
    expect(pendingEditsSignal.value.A).toBeUndefined();
    expect(pendingEditsSignal.value.B).toEqual({ takeProfit: 2 });
    expect(tradeLineUiSignal.value.selected).toBe("B");
    expect(editTradeSignal.value).toBe("B");
  });

  it("toggle clears the selection when re-selecting the same trade", () => {
    setTradeSelected("A");
    toggleTradeSelected("A");
    expect(tradeLineUiSignal.value.selected).toBeNull();
    expect(editTradeSignal.value).toBeNull();
  });

  it("deselecting exits edit mode AND closes the panel", () => {
    setTradeSelected("A");
    expect(tradePanelOpen.value).toBe(true);
    setTradeSelected(null);
    expect(tradeLineUiSignal.value.selected).toBeNull();
    expect(editTradeSignal.value).toBeNull();
    expect(tradePanelOpen.value).toBe(false);
  });

  it("hiding the selected trade deselects it (edit mode clears in lockstep)", () => {
    setTradeSelected("A");
    toggleTradeHidden("A");
    expect(tradeLineUiSignal.value.hidden).toContain("A");
    expect(tradeLineUiSignal.value.selected).toBeNull();
    expect(editTradeSignal.value).toBeNull();
  });
});
