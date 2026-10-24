import { describe, expect, it, vi } from "vitest";
import { installMemStorage } from "./testMemStorage";
installMemStorage();
vi.mock("klinecharts", () => ({ registerOverlay: () => {}, registerIndicator: () => {}, registerYAxis: () => {}, getSupportedIndicators: () => [] }));
const { pickedLinesChanged } = await import("./signals");
const { saveBacktestLastUsed } = await import("./persist/defaults");
const { saveArmed } = await import("./liveEngine");
const { setScreenerDraft, EMPTY_SCREENER_DRAFT } = await import("./screenerDraft");
const { defaultBacktestConfig } = await import("./backtestConfig");

describe("pickedLinesChanged", () => {
  it("bumps on every write of a lines holder", () => {
    const seen = vi.fn();
    const off = pickedLinesChanged.subscribe(seen);
    saveBacktestLastUsed(defaultBacktestConfig() as never);
    saveArmed("US100", "capital:demo", null);
    setScreenerDraft("capital", { ...EMPTY_SCREENER_DRAFT, lines: {} });
    off();
    expect(seen).toHaveBeenCalledTimes(3);
  });

  it("bumps on a screener draft write only when its lines change", () => {
    const lines = {};
    setScreenerDraft("ig", { ...EMPTY_SCREENER_DRAFT, lines });
    const seen = vi.fn();
    const off = pickedLinesChanged.subscribe(seen);
    setScreenerDraft("ig", { ...EMPTY_SCREENER_DRAFT, lines, expression: "close > 1" });
    expect(seen).not.toHaveBeenCalled();
    setScreenerDraft("ig", { ...EMPTY_SCREENER_DRAFT, expression: "close > 1" });
    off();
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("bumps when an edit changes which held lines the screener text names", () => {
    const lines = { L1: {} as never };
    setScreenerDraft("oanda", { ...EMPTY_SCREENER_DRAFT, lines, expression: "close > L1" });
    const seen = vi.fn();
    const off = pickedLinesChanged.subscribe(seen);
    setScreenerDraft("oanda", { ...EMPTY_SCREENER_DRAFT, lines, expression: "close > L1 + 1" });
    expect(seen).not.toHaveBeenCalled();
    setScreenerDraft("oanda", { ...EMPTY_SCREENER_DRAFT, lines, expression: "close > 1" });
    off();
    expect(seen).toHaveBeenCalledTimes(1);
  });
});
