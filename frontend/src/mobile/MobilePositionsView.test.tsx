// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const subscribeTrades = vi.fn();
const refreshTrades = vi.fn();
const getTradesAccount = vi.fn();
const fetchAccountSummary = vi.fn();
const closePosition = vi.fn();
const cancelWorkingOrder = vi.fn();

vi.mock("../lib/trading", async (orig) => ({
  ...(await orig<object>()),
  subscribeTrades: (...args: unknown[]) => subscribeTrades(...args),
  refreshTrades: (...args: unknown[]) => refreshTrades(...args),
  getTradesAccount: (...args: unknown[]) => getTradesAccount(...args),
  fetchAccountSummary: (...args: unknown[]) => fetchAccountSummary(...args),
  closePosition: (...args: unknown[]) => closePosition(...args),
  cancelWorkingOrder: (...args: unknown[]) => cancelWorkingOrder(...args),
}));

const toast = vi.fn();
vi.mock("../lib/notify", async (orig) => ({
  ...(await orig<object>()),
  toast: (...args: unknown[]) => toast(...args),
}));

import MobilePositionsView from "./MobilePositionsView";
import { confirmRequest } from "../lib/signals";
import { mobileSymbol, mobileTabSignal } from "./mobileChartState";
import type { TradeView, AccountSummary } from "../lib/trading";

afterEach(() => {
  cleanup();
  confirmRequest.set(null);
});

const position: TradeView = {
  kind: "position",
  id: "pos-1",
  epic: "US100",
  side: "buy",
  quantity: 2,
  priceLevel: 15000,
  stop: 14900,
  takeProfit: 15200,
  upnl: 42.5,
  openedAt: Date.now(),
  expiresAt: null,
  leverage: 20,
  margin: 150,
};

const order: TradeView = {
  kind: "order",
  id: "ord-1",
  epic: "EURUSD",
  side: "sell",
  quantity: 1,
  priceLevel: 1.085,
  stop: null,
  takeProfit: null,
  upnl: null,
  openedAt: Date.now(),
  expiresAt: null,
  leverage: null,
  margin: null,
};

const summary: AccountSummary = {
  balance: 10000,
  available: 9500,
  deposit: null,
  profitLoss: 42.5,
  currency: "USD",
};

describe("MobilePositionsView", () => {
  beforeEach(() => {
    subscribeTrades.mockReset();
    refreshTrades.mockReset();
    getTradesAccount.mockReset();
    fetchAccountSummary.mockReset();
    closePosition.mockReset();
    cancelWorkingOrder.mockReset();
    toast.mockReset();

    getTradesAccount.mockReturnValue("capital:paper");
    subscribeTrades.mockImplementation((fn: (t: TradeView[]) => void) => {
      fn([position, order]);
      return () => {};
    });
    fetchAccountSummary.mockResolvedValue(summary);
    closePosition.mockResolvedValue({});
    cancelWorkingOrder.mockResolvedValue({});
  });

  it("renders the dock's stat strip, tabs with counts, and the table columns", async () => {
    render(<MobilePositionsView />);
    await waitFor(() => expect(screen.getByText(/10,000 USD/)).toBeTruthy());
    expect(screen.getByText("Balance")).toBeTruthy();
    expect(screen.getByText("Equity")).toBeTruthy();
    expect(screen.getByText("Margin level")).toBeTruthy();
    // Positions tab first, with its count; the orders tab carries its own.
    expect(screen.getByRole("button", { name: /^Positions\s*1$/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Orders\s*1$/ })).toBeTruthy();
    expect(screen.getByText("US100")).toBeTruthy();
    expect(screen.getByText("Long")).toBeTruthy();
    expect(screen.queryByText("EURUSD")).toBeNull();
    for (const col of ["Symbol", "Side", "Qty", "Avg fill", "TP", "SL", "Last", "P&L", "P&L %", "Margin", "Time"])
      expect(screen.getByRole("columnheader", { name: col })).toBeTruthy();
    expect(screen.getByText("+42.50")).toBeTruthy();
  });

  it("groups same-symbol positions under a roll-up header that folds on tap", async () => {
    const second: TradeView = { ...position, id: "pos-2", quantity: 1, priceLevel: 15300, upnl: -10 };
    subscribeTrades.mockImplementation((fn: (t: TradeView[]) => void) => {
      fn([position, second, order]);
      return () => {};
    });
    render(<MobilePositionsView />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Hide positions" })).toBeTruthy());
    // Header: net size 3, size-weighted entry 15100, summed P&L, count badge.
    const header = screen.getByRole("button", { name: "Hide positions" }).closest("tr")!;
    expect(header.className).toContain("pp-group");
    expect(header.textContent).toContain("15100");
    expect(header.textContent).toContain("+32.50");
    expect(document.querySelectorAll(".pp-row.pp-member").length).toBe(2);
    await userEvent.click(screen.getByRole("button", { name: "Hide positions" }));
    expect(document.querySelectorAll(".pp-row.pp-member").length).toBe(0);
    expect(screen.getByRole("button", { name: "Show positions" })).toBeTruthy();
  });

  it("lays the columns out in the dock's order", async () => {
    render(<MobilePositionsView />);
    await waitFor(() => expect(screen.getByText("US100")).toBeTruthy());
    const heads = screen.getAllByRole("columnheader").map((th) => th.textContent);
    expect(heads).toEqual([
      "Symbol", "Side", "Qty", "P&L", "P&L %", "Avg fill", "TP", "SL",
      "Last", "Trade val", "Mkt val", "Lev", "Margin", "Time▼",
    ]);
  });

  it("shows the full date and time on every row, today's included", async () => {
    // Only Date is faked, so the clock (and the row's "today") is pinned.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2025, 5, 10, 15, 30, 45));
    try {
      subscribeTrades.mockImplementation((fn: (t: TradeView[]) => void) => {
        fn([{ ...position, openedAt: new Date(2025, 5, 10, 9, 5, 7).getTime() }]);
        return () => {};
      });
      render(<MobilePositionsView />);
      await waitFor(() => expect(screen.getByText("US100")).toBeTruthy());
      const time = document.querySelector(".pp-row .pp-c-time")!.textContent!;
      expect(time).toContain("2025");
      expect(time).toContain("10");
      expect(time).toMatch(/09:05:07/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the row order while values change, until the sort or the rows do", async () => {
    let push: (t: TradeView[]) => void = () => {};
    const other: TradeView = { ...position, id: "pos-2", epic: "AAPL", upnl: -5 };
    subscribeTrades.mockImplementation((fn: (t: TradeView[]) => void) => {
      push = fn;
      fn([position, other]);
      return () => {};
    });
    render(<MobilePositionsView />);
    await waitFor(() => expect(screen.getByText("US100")).toBeTruthy());
    const symbols = () => [...document.querySelectorAll(".pp-row .pp-c-sym")].map((td) => td.textContent);
    await userEvent.click(screen.getByRole("button", { name: /^P&L$/ }));
    expect(symbols()).toEqual(["US100", "AAPL"]);
    // A P&L swap alone (same rows) must not move anything under the finger.
    act(() => push([{ ...position, upnl: -50 }, { ...other, upnl: 80 }]));
    expect(symbols()).toEqual(["US100", "AAPL"]);
    // A new row re-sorts on the current values.
    act(() => push([{ ...position, upnl: -50 }, { ...other, upnl: 80 }, { ...position, id: "pos-3", epic: "NVDA", upnl: 10 }]));
    expect(symbols()).toEqual(["AAPL", "NVDA", "US100"]);
  });

  it("sorts on a header tap, flipping direction on a second tap", async () => {
    const other: TradeView = { ...position, id: "pos-2", epic: "AAPL", upnl: -5 };
    subscribeTrades.mockImplementation((fn: (t: TradeView[]) => void) => {
      fn([position, other, order]);
      return () => {};
    });
    render(<MobilePositionsView />);
    await waitFor(() => expect(screen.getByText("US100")).toBeTruthy());
    const symbols = () => [...document.querySelectorAll(".pp-row .pp-c-sym")].map((td) => td.textContent);
    await userEvent.click(screen.getByRole("button", { name: /^Symbol/ }));
    expect(symbols()).toEqual(["AAPL", "US100"]);
    await userEvent.click(screen.getByRole("button", { name: /^Symbol/ }));
    expect(symbols()).toEqual(["US100", "AAPL"]);
  });

  it("switches to the orders tab, whose entry column is the limit price", async () => {
    render(<MobilePositionsView />);
    await waitFor(() => expect(screen.getByText("US100")).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: /^Orders\s*1$/ }));
    expect(screen.getByText("EURUSD")).toBeTruthy();
    expect(screen.getByText("Limit sell")).toBeTruthy();
    expect(screen.getByText("resting")).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Limit" })).toBeTruthy();
    expect(screen.queryByText("US100")).toBeNull();
  });

  it("names the paper account when the account summary is null", async () => {
    fetchAccountSummary.mockResolvedValue(null);
    render(<MobilePositionsView />);
    await waitFor(() => expect(screen.getByText(/Paper account/)).toBeTruthy());
  });

  it("opens a detail sheet on tap and routes Close through requestConfirm", async () => {
    render(<MobilePositionsView />);
    await waitFor(() => expect(screen.getByText("US100")).toBeTruthy());
    await userEvent.click(screen.getByText("US100"));
    expect(screen.getByRole("button", { name: "Close position" })).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Close position" }));
    expect(confirmRequest.value).not.toBeNull();
    expect(closePosition).not.toHaveBeenCalled();

    confirmRequest.value!.onConfirm();
    await waitFor(() => expect(closePosition).toHaveBeenCalledWith("pos-1", "capital:paper"));
    await waitFor(() => expect(refreshTrades).toHaveBeenCalled());
  });

  it("Show on chart opens the row's epic on the chart tab and closes the sheet", async () => {
    mobileTabSignal.set("positions");
    mobileSymbol.set(null);
    render(<MobilePositionsView />);
    await waitFor(() => expect(screen.getByText("US100")).toBeTruthy());
    await userEvent.click(screen.getByText("US100"));
    await userEvent.click(screen.getByRole("button", { name: "Show on chart" }));
    // showMobileEpic resolves the epic through the catalogue first.
    await waitFor(() => expect(mobileTabSignal.value).toBe("chart"));
    expect(mobileSymbol.value?.epic).toBe("US100");
    expect(screen.queryByRole("button", { name: "Close position" })).toBeNull();
  });

  it("routes Cancel order through requestConfirm for working orders", async () => {
    render(<MobilePositionsView />);
    await waitFor(() => expect(screen.getByText("US100")).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: /^Orders\s*1$/ }));
    expect(screen.getByText("EURUSD")).toBeTruthy();
    await userEvent.click(screen.getByText("EURUSD"));
    await userEvent.click(screen.getByRole("button", { name: "Cancel order" }));
    expect(confirmRequest.value).not.toBeNull();

    confirmRequest.value!.onConfirm();
    await waitFor(() => expect(cancelWorkingOrder).toHaveBeenCalledWith("ord-1", "capital:paper"));
    await waitFor(() => expect(refreshTrades).toHaveBeenCalled());
  });

  it("toasts the error and leaves the sheet open when closePosition fails", async () => {
    closePosition.mockRejectedValue(new Error("close failed (409)"));
    render(<MobilePositionsView />);
    await waitFor(() => expect(screen.getByText("US100")).toBeTruthy());
    await userEvent.click(screen.getByText("US100"));
    await userEvent.click(screen.getByRole("button", { name: "Close position" }));
    expect(confirmRequest.value).not.toBeNull();

    confirmRequest.value!.onConfirm();
    await waitFor(() => expect(closePosition).toHaveBeenCalledWith("pos-1", "capital:paper"));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("close failed (409)"));
    expect(refreshTrades).not.toHaveBeenCalled();
    // Sheet stays open on failure — the trader can retry or read the error.
    expect(screen.getByRole("button", { name: "Close position" })).toBeTruthy();
  });
});
