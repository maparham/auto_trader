// @vitest-environment jsdom
//
// The ticket is the TERMINUS of every "edit this trade" gesture on the chart:
// lib/signals' setTradeSelected raises tradePanelOpen and App mounts this beside
// the chart. Two separate things go wrong if it mounts live while the focused
// cell is replaying, and this file pins both:
//
//  1. Real money. A replay ledger id (`rp1`/`ro1`) is in no account book, so the
//     edit lookup misses and the ticket renders its LIVE NEW-ORDER form —
//     side/units/exits and a submit button that deals for real — presented as if
//     it were the practice trade the user just double-clicked.
//  2. Blindness. The quote strip polls the broker every 1.5s and prints today's
//     bid/ask for the very instrument being replayed, which tells a user
//     practising blind exactly where price ended up. Same exposure the axis tags
//     already null out during a session, through another window.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import OrderTicket from "./OrderTicket";
import type { TradingSettings } from "./theme";
import { editTradeSignal, setTradeSelected } from "./lib/signals";

const LIVE_BID = 30008.4;
const LIVE_ASK = 30010.4;

const market = vi.hoisted(() => ({
  fetchQuote: vi.fn(async () => ({ bid: 30008.4, ask: 30010.4, mid: 30009.4 })),
  // Typed on its callback so a test can push a book into it (the account-book
  // subscription the vanish guard reads).
  subscribeTrades: vi.fn<(cb: (t: unknown[]) => void) => () => void>(() => () => {}),
  getLivePrice: vi.fn(() => 30009.4),
  refreshTrades: vi.fn(),
  placeOrder: vi.fn(async () => ({})),
}));
vi.mock("./lib/trading", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/trading")>()),
  ...market,
}));

const trading = { confirmLineEdits: true } as unknown as TradingSettings;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  setTradeSelected(null);
});
beforeEach(() => vi.clearAllMocks());

describe("OrderTicket on a LIVE cell", () => {
  it("polls and shows the broker's quote, with a submit button", async () => {
    render(<OrderTicket epic="US100" trading={trading} />);
    expect(await screen.findByText(LIVE_BID.toFixed(2))).toBeTruthy();
    expect(screen.getByText(LIVE_ASK.toFixed(2))).toBeTruthy();
    expect(document.querySelector(".ot-action")).toBeTruthy();
    expect(market.fetchQuote).toHaveBeenCalled();
  });
});

describe("OrderTicket while the focused cell is REPLAYING", () => {
  it("never fetches a quote", async () => {
    render(<OrderTicket epic="US100" trading={trading} replaying />);
    await Promise.resolve();
    expect(market.fetchQuote).not.toHaveBeenCalled();
  });

  it("shows no live price and no dealing form", () => {
    render(<OrderTicket epic="US100" trading={trading} replaying />);
    expect(screen.queryByText(LIVE_BID.toFixed(2))).toBeNull();
    expect(screen.queryByText(LIVE_ASK.toFixed(2))).toBeNull();
    expect(document.querySelector(".ot-strip")).toBeNull(); // the quote strip itself
    expect(document.querySelector(".ot-action")).toBeNull(); // the submit button
  });

  it("explains itself rather than rendering an inert-looking ticket", () => {
    render(<OrderTicket epic="US100" trading={trading} replaying />);
    expect(screen.getByText("Replay session running")).toBeTruthy();
    expect(screen.getByText(/practice orders/i)).toBeTruthy();
  });

  it("leaves a selected PRACTICE trade selected", async () => {
    // The ticket's vanish guard drops the selection when the edited id is not in
    // the account book. A ledger id never is, so with the sidebar open (which is
    // the toolbar's own toggle, independent of the chart selection) that guard
    // would clear the selection the user just made and take its pill with it —
    // the pill being the only way to manage a practice trade.
    market.subscribeTrades.mockImplementation((cb: (t: unknown[]) => void) => {
      cb([{ id: "DIAAAAAB1234567", epic: "US100" }]); // a real account position
      return () => {};
    });
    setTradeSelected("rp1", "price", false);
    expect(editTradeSignal.value).toBe("rp1");
    render(<OrderTicket epic="US100" trading={trading} replaying />);
    await new Promise((r) => setTimeout(r, 0));
    expect(editTradeSignal.value).toBe("rp1");
  });
});
