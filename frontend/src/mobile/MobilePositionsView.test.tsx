// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
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
