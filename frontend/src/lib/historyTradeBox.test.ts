// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { createHistoryTradeBox } from "./historyTradeBox";
import type { ClosedTradeView } from "./accountHistory";

const trade = (over: Partial<ClosedTradeView> = {}): ClosedTradeView => ({
  dealId: "D1", epic: "TSLA", side: "buy", size: 2, entry: 100, exit: 110, openedAt: 1_000,
  closedAt: 5_000, closeSource: "TP", pnl: 20, currency: "EUR", ...over,
});
const fakeChart = () => {
  let n = 0;
  return {
    createOverlay: vi.fn(() => `ov${++n}`),
    removeOverlay: vi.fn(),
  };
};

describe("historyTradeBox", () => {
  it("draws a locked box for the selected trade on its own epic only", () => {
    const chart = fakeChart();
    const box = createHistoryTradeBox(chart as never);
    box.sync(trade(), "MSFT", []);
    expect(chart.createOverlay).not.toHaveBeenCalled();
    box.sync(trade(), "TSLA", []);
    expect(chart.createOverlay).toHaveBeenCalledTimes(1);
    expect(chart.createOverlay).toHaveBeenCalledWith(expect.objectContaining({ name: "tradeBox", lock: true }));
  });

  it("does not rebuild on an unchanged paint, and removes the box on deselect", () => {
    const chart = fakeChart();
    const box = createHistoryTradeBox(chart as never);
    box.sync(trade(), "TSLA", []);
    box.sync(trade(), "TSLA", []);
    expect(chart.createOverlay).toHaveBeenCalledTimes(1);
    box.sync(null, "TSLA", []);
    expect(chart.removeOverlay).toHaveBeenCalledWith({ id: "ov1" });
  });

  it("rebuilds once the loaded bars come to cover the trade", () => {
    const chart = fakeChart();
    const box = createHistoryTradeBox(chart as never);
    box.sync(trade(), "TSLA", [{ timestamp: 3_000, high: 111, low: 99 }]);
    box.sync(trade(), "TSLA", [{ timestamp: 500, high: 111, low: 95 }, { timestamp: 3_000, high: 111, low: 99 }]);
    expect(chart.createOverlay).toHaveBeenCalledTimes(2);
    expect(chart.removeOverlay).toHaveBeenCalledWith({ id: "ov1" });
  });

  it("draws nothing for a trade opened before the range", () => {
    const chart = fakeChart();
    createHistoryTradeBox(chart as never).sync(trade({ openedAt: null }), "TSLA", []);
    expect(chart.createOverlay).not.toHaveBeenCalled();
  });
});
