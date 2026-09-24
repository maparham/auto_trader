// @vitest-environment jsdom
//
// Category chips come from the active broker (GET /api/brokers -> categories),
// not from a hardcoded vocabulary. The regression this pins: the chips used to
// filter on Capital's instrumentType words, so on a broker whose rows say
// "stock"/"fx" every chip was empty ("Nothing to browse here").
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { installMemStorage } from "./lib/testMemStorage";

installMemStorage();

vi.mock("./lib/feed", async () => {
  const actual = await vi.importActual<typeof import("./lib/feed")>("./lib/feed");
  return {
    ...actual,
    fetchAllMarkets: vi.fn().mockResolvedValue([
      { epic: "AAPL", name: "Apple", status: "TRADEABLE", type: "stock" },
      { epic: "SPY", name: "SPDR S&P 500 ETF", status: "TRADEABLE", type: "etf" },
      { epic: "EURUSD", name: "EUR/USD", status: "TRADEABLE", type: "fx" },
    ]),
    fetchFavorites: vi.fn().mockResolvedValue([]),
    fetchMarketMeta: vi.fn().mockResolvedValue({ pricePrecision: null, closed: null, nextOpen: null }),
    searchInstruments: vi.fn().mockResolvedValue([]),
    addFavorite: vi.fn().mockResolvedValue(undefined),
    removeFavorite: vi.fn().mockResolvedValue(undefined),
  };
});

import SymbolSearchModal from "./SymbolSearchModal";
import { noteBrokerCategories } from "./lib/trading";
import type { Instrument } from "./lib/feed";

afterEach(cleanup);

beforeEach(() => {
  noteBrokerCategories({
    yfinance: [
      { key: "stock", label: "Stocks", types: ["stock"], row: "stock" },
      { key: "etf", label: "ETFs", types: ["etf", "fund"], row: "fund" },
      { key: "fx", label: "Forex", types: ["fx"], row: "forex" },
    ],
    capital: [
      { key: "SHARES", label: "Stocks", types: ["SHARES"], row: "stock cfd" },
    ],
  });
  // The modal refreshes the declaration on open; keep that off the network.
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
});

const CURRENT: Instrument = {
  epic: "AAPL",
  name: "Apple",
  status: "TRADEABLE",
  type: "stock",
};

function renderModal(brokerId: string) {
  render(
    <SymbolSearchModal current={CURRENT} brokerId={brokerId} onPick={vi.fn()} onClose={vi.fn()} />,
  );
}

describe("SymbolSearchModal — broker-declared categories", () => {
  it("renders the active broker's chips and filters on its own type words", async () => {
    renderModal("yfinance");
    // Yahoo's own chips, not Capital's five.
    expect(screen.queryByText("ETFs")).not.toBeNull();
    expect(screen.queryByText("Commodities")).toBeNull();

    fireEvent.click(screen.getByText("Stocks"));
    await waitFor(() => expect(screen.queryByText("AAPL")).not.toBeNull());
    expect(screen.queryByText("SPY")).toBeNull();

    fireEvent.click(screen.getByText("ETFs"));
    await waitFor(() => expect(screen.queryByText("SPY")).not.toBeNull());
    expect(screen.queryByText("AAPL")).toBeNull();
  });

  it("labels a row from the broker's declaration, not a CFD assumption", async () => {
    renderModal("yfinance");
    fireEvent.click(screen.getByText("ETFs"));
    await waitFor(() => expect(screen.queryByText("SPY")).not.toBeNull());
    expect(screen.queryByText("fund")).not.toBeNull();
    expect(screen.queryByText("etf cfd")).toBeNull();
  });

  it("keeps a typed search inside the selected chip", async () => {
    renderModal("yfinance");
    fireEvent.click(screen.getByText("Stocks"));
    await waitFor(() => expect(screen.queryByText("AAPL")).not.toBeNull());
    // "p" matches Apple (stock) and SPDR S&P 500 ETF by name.
    fireEvent.change(screen.getByPlaceholderText("Symbol or name…"), {
      target: { value: "p" },
    });
    await waitFor(() => expect(screen.queryByText("AAPL")).not.toBeNull());
    expect(screen.queryByText("SPY")).toBeNull();
    expect(screen.getByText("Stocks").className).toBe("on");

    // Switching chips narrows the same search instead of clearing it.
    fireEvent.click(screen.getByText("ETFs"));
    await waitFor(() => expect(screen.queryByText("SPY")).not.toBeNull());
    expect(screen.queryByText("AAPL")).toBeNull();

    // All searches the whole catalogue.
    fireEvent.click(screen.getByText("All"));
    await waitFor(() => expect(screen.queryByText("AAPL")).not.toBeNull());
    expect(screen.queryByText("SPY")).not.toBeNull();
  });

  it("shows no type chips for a broker that declares none", async () => {
    renderModal("oanor");
    await waitFor(() => expect(screen.queryByText("All")).not.toBeNull());
    expect(screen.queryByText("Stocks")).toBeNull();
    expect(screen.queryByText("Forex")).toBeNull();
  });
});
