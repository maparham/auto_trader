// @vitest-environment jsdom
//
// The real-money guard must not use window.confirm: the Tauri shell renders in
// WKWebView via wry, whose WKUIDelegate never shows the JS confirm panel, so
// confirm() silently returns false and the buy/sell button looks dead. The
// guard is instead a two-step arm on the action button itself: the first click
// arms it ("Confirm ..."), the second click deals, and the armed state expires
// on its own so a stray click cannot linger as a loaded gun.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import OrderTicket from "./OrderTicket";
import type { TradingSettings } from "./theme";
import { setTradeSelected } from "./lib/signals";

const market = vi.hoisted(() => ({
  fetchQuote: vi.fn(async () => ({ bid: 30008.4, ask: 30010.4, mid: 30009.4 })),
  subscribeTrades: vi.fn<(cb: (t: unknown[]) => void) => () => void>(() => () => {}),
  getLivePrice: vi.fn(() => 30009.4),
  refreshTrades: vi.fn(),
  placeOrder: vi.fn(async (_req: unknown) => ({ status: "filled", filled_quantity: 1, fill_price: 30010.4 })),
}));
vi.mock("./lib/trading", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/trading")>()),
  ...market,
}));

const trading = { confirmLineEdits: true } as unknown as TradingSettings;

const actionButton = () => document.querySelector(".ot-action") as HTMLButtonElement;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
  setTradeSelected(null);
});
beforeEach(() => vi.clearAllMocks());

describe("real-money confirm (no window.confirm: dead in WKWebView)", () => {
  it("paper account deals on the first click", async () => {
    render(<OrderTicket epic="US100" trading={trading} account="capital:paper" />);
    fireEvent.click(actionButton());
    await Promise.resolve();
    expect(market.placeOrder).toHaveBeenCalledTimes(1);
  });

  it("live account arms on the first click and deals on the second", async () => {
    render(<OrderTicket epic="US100" trading={trading} account="capital:live" />);
    fireEvent.click(actionButton());
    await Promise.resolve();
    expect(market.placeOrder).not.toHaveBeenCalled();
    expect(screen.getByText(/confirm/i)).toBeTruthy();
    fireEvent.click(actionButton());
    await Promise.resolve();
    expect(market.placeOrder).toHaveBeenCalledTimes(1);
    expect(market.placeOrder.mock.calls[0][0]).toMatchObject({
      account: "capital:live",
      confirm: true,
    });
  });

  it("the armed state expires instead of lingering", async () => {
    vi.useFakeTimers();
    render(<OrderTicket epic="US100" trading={trading} account="capital:live" />);
    fireEvent.click(actionButton());
    expect(screen.getByText(/confirm/i)).toBeTruthy();
    act(() => vi.advanceTimersByTime(6000));
    expect(screen.queryByText(/confirm/i)).toBeNull();
    // The next click starts a fresh arm, not a deal.
    fireEvent.click(actionButton());
    expect(market.placeOrder).not.toHaveBeenCalled();
  });

  it("never calls window.confirm", () => {
    const spy = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<OrderTicket epic="US100" trading={trading} account="capital:live" />);
    fireEvent.click(actionButton());
    fireEvent.click(actionButton());
    expect(spy).not.toHaveBeenCalled();
  });
});
