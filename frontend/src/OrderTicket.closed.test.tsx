// @vitest-environment jsdom
// A closed market: the ticket names the reopen time and blocks a market order
// on a broker account (the broker would refuse it, e.g. MT5 retcode 10018).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import OrderTicket from "./OrderTicket";
import type { TradingSettings } from "./theme";

const market = vi.hoisted(() => ({
  fetchQuote: vi.fn(async () => ({ bid: 42.53, ask: 42.74, mid: 42.635 })),
  subscribeTrades: vi.fn(() => () => {}),
  getLivePrice: vi.fn(() => 42.6),
  refreshTrades: vi.fn(),
  placeOrder: vi.fn(async () => ({})),
}));
vi.mock("./lib/trading", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/trading")>()),
  ...market,
}));
const status = vi.hoisted(() => ({ closed: true, nextOpen: "2026-11-18T14:30:00Z" as string | null }));
const hook = vi.hoisted(() => ({ useMarketClosed: vi.fn(() => status) }));
vi.mock("./lib/useMarketClosed", () => hook);

const trading = { confirmLineEdits: true } as unknown as TradingSettings;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("OrderTicket on a closed market", () => {
  it("asks the account's own broker", () => {
    render(<OrderTicket epic="#SLV" account="mt5-self:live" trading={trading} />);
    expect(hook.useMarketClosed).toHaveBeenCalledWith("#SLV", "mt5-self", true);
  });

  it("shows the reopen time and blocks a market order", () => {
    render(<OrderTicket epic="#SLV" account="mt5-self:live" trading={trading} />);
    expect(screen.getByRole("status").textContent).toMatch(/^Market closed · opens /);
    const btn = document.querySelector(".ot-action") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(market.placeOrder).not.toHaveBeenCalled();
  });

  it("lets a limit order rest", () => {
    render(<OrderTicket epic="#SLV" account="mt5-self:live" trading={trading} />);
    fireEvent.click(screen.getByText("Limit"));
    expect((document.querySelector(".ot-action") as HTMLButtonElement).disabled).toBe(false);
  });

  it("does not block a paper account", () => {
    render(<OrderTicket epic="#SLV" account="mt5-self:paper" trading={trading} />);
    expect((document.querySelector(".ot-action") as HTMLButtonElement).disabled).toBe(false);
  });
});
