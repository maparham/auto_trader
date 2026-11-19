// @vitest-environment jsdom
// A broker account margins at the leverage its broker states (Capital's
// account preferences, mt5-self's margin calc); Settings is the fallback.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import OrderTicket from "./OrderTicket";
import type { TradingSettings } from "./theme";

vi.mock("./lib/trading", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/trading")>()),
  fetchQuote: vi.fn(async () => ({ bid: 99.9, ask: 100.1, mid: 100 })),
  subscribeTrades: vi.fn(() => () => {}),
  getLivePrice: vi.fn(() => 100),
  refreshTrades: vi.fn(),
  placeOrder: vi.fn(async () => ({})),
}));
vi.mock("./lib/useMarketClosed", () => ({ useMarketClosed: () => ({ closed: false, nextOpen: null }) }));
const hook = vi.hoisted(() => ({ useBrokerLeverage: vi.fn((): number | null => 20) }));
vi.mock("./lib/useBrokerLeverage", () => hook);

const trading = {
  confirmLineEdits: true,
  defaultLeverage: 5,
  leverage: {},
  accountBalance: 10_000,
  accountCurrency: "EUR",
} as unknown as TradingSettings;

const leverageRow = async () => (await screen.findByText("Leverage")).nextElementSibling?.textContent;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("OrderTicket leverage", () => {
  it("uses the broker's leverage on a broker account", async () => {
    render(<OrderTicket epic="GOLD" account="mt5-self:live" trading={trading} />);
    expect(hook.useBrokerLeverage).toHaveBeenCalledWith("GOLD", "mt5-self", true);
    expect(await leverageRow()).toBe("20:1");
  });

  it("falls back to Settings when the broker does not say", async () => {
    hook.useBrokerLeverage.mockReturnValue(null);
    render(<OrderTicket epic="GOLD" account="capital:demo" trading={trading} />);
    expect(await leverageRow()).toBe("5:1");
  });

  it("never asks for a paper account", () => {
    render(<OrderTicket epic="GOLD" account="mt5-self:paper" trading={trading} />);
    expect(hook.useBrokerLeverage).toHaveBeenCalledWith("GOLD", "mt5-self", false);
  });
});
