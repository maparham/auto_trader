// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

const getTradesAccount = vi.fn();
const fetchAccountSummary = vi.fn();
const isDataOnlyBroker = vi.fn();
const brokerOf = vi.fn();
const isSynthetic = vi.fn();

vi.mock("../lib/trading", async (orig) => ({
  ...(await orig<object>()),
  getTradesAccount: (...args: unknown[]) => getTradesAccount(...args),
  fetchAccountSummary: (...args: unknown[]) => fetchAccountSummary(...args),
  isDataOnlyBroker: (...args: unknown[]) => isDataOnlyBroker(...args),
  brokerOf: (...args: unknown[]) => brokerOf(...args),
}));

vi.mock("../lib/syntheticRegistry", async (orig) => ({
  ...(await orig<object>()),
  isSynthetic: (...args: unknown[]) => isSynthetic(...args),
}));

vi.mock("../OrderTicket", () => ({
  default: (p: { epic: string }) => <div data-testid="ticket" data-epic={p.epic} />,
}));

import MobileTradeView from "./MobileTradeView";
import { mobileSymbol } from "./mobileChartState";

afterEach(() => {
  cleanup();
  mobileSymbol.set(null);
});

describe("MobileTradeView", () => {
  it("renders the order ticket for the focused symbol when the broker is tradeable", () => {
    getTradesAccount.mockReturnValue("capital:paper");
    brokerOf.mockReturnValue("capital");
    isDataOnlyBroker.mockReturnValue(false);
    isSynthetic.mockReturnValue(false);
    fetchAccountSummary.mockResolvedValue(null);
    mobileSymbol.set({ epic: "US100", name: "US 100", status: "TRADEABLE", type: "INDICES", pricePrecision: 2 });

    render(<MobileTradeView />);

    expect(screen.getByTestId("ticket").getAttribute("data-epic")).toBe("US100");
  });

  it("shows an empty state when no symbol is focused", () => {
    getTradesAccount.mockReturnValue("capital:paper");
    brokerOf.mockReturnValue("capital");
    isDataOnlyBroker.mockReturnValue(false);
    isSynthetic.mockReturnValue(false);
    mobileSymbol.set(null);

    render(<MobileTradeView />);

    expect(screen.queryByTestId("ticket")).toBeNull();
    expect(screen.getByText(/Pick a market on the Chart tab/i)).toBeTruthy();
  });

  it("shows an empty state when the broker is data-only", () => {
    getTradesAccount.mockReturnValue("dukascopy:paper");
    brokerOf.mockReturnValue("dukascopy");
    isDataOnlyBroker.mockReturnValue(true);
    isSynthetic.mockReturnValue(false);
    mobileSymbol.set({ epic: "US100", name: "US 100", status: "TRADEABLE", type: "INDICES", pricePrecision: 2 });

    render(<MobileTradeView />);

    expect(screen.queryByTestId("ticket")).toBeNull();
    expect(screen.getByText(/Pick a market on the Chart tab/i)).toBeTruthy();
  });

  it("shows an empty state when the focused symbol is synthetic", () => {
    getTradesAccount.mockReturnValue("capital:paper");
    brokerOf.mockReturnValue("capital");
    isDataOnlyBroker.mockReturnValue(false);
    isSynthetic.mockReturnValue(true);
    mobileSymbol.set({ epic: "SYN_abc123", name: "Synthetic", status: "TRADEABLE", type: null, pricePrecision: 2 });

    render(<MobileTradeView />);

    expect(screen.queryByTestId("ticket")).toBeNull();
    expect(screen.getByText(/Pick a market on the Chart tab/i)).toBeTruthy();
  });
});
