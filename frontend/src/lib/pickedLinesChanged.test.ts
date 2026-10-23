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
    setScreenerDraft("capital", EMPTY_SCREENER_DRAFT);
    off();
    expect(seen).toHaveBeenCalledTimes(3);
  });
});
