// @vitest-environment jsdom
// Tab-bar search catalogue fallback (spec
// 2026-08-12-tab-search-catalogue-fallback): when the query matches no OPEN
// tab, a dropdown lists full-catalogue symbols and picking one opens a new tab.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

vi.mock("./lib/feed", async () => {
  const actual = await vi.importActual<typeof import("./lib/feed")>("./lib/feed");
  return {
    ...actual,
    fetchAllMarkets: vi.fn().mockResolvedValue([
      { epic: "BTCUSD", name: "Bitcoin", status: "TRADEABLE", type: "CRYPTOCURRENCIES" },
      { epic: "BTCEUR", name: "Bitcoin / EUR", status: "TRADEABLE", type: "CRYPTOCURRENCIES" },
      { epic: "GOLD", name: "Gold Spot", status: "TRADEABLE", type: "COMMODITIES" },
    ]),
  };
});

import TabBar from "./TabBar";
import type { ChartTab } from "./lib/persist";
import type { Period } from "./lib/feed";

afterEach(cleanup);

const PERIOD = { label: "1h" } as Period;

function tab(id: string, epic: string, name: string): ChartTab {
  return {
    id,
    layout: "1",
    activeCellId: `${id}-c0`,
    cells: [{ id: `${id}-c0`, symbol: { epic, name, status: null }, period: PERIOD, scope: id }],
  };
}

const TABS: ChartTab[] = [tab("t1", "EURUSD", "Euro / US Dollar")];

function renderBar(overrides: Partial<React.ComponentProps<typeof TabBar>> = {}) {
  const onOpenSymbol = vi.fn();
  const props: React.ComponentProps<typeof TabBar> = {
    tabs: TABS,
    activeId: "t1",
    closedEpics: {},
    alertTabIds: new Set(),
    onSelect: vi.fn(),
    onAdd: vi.fn(),
    onClose: vi.fn(),
    onReorder: vi.fn(),
    canMerge: () => false,
    onMerge: vi.fn(),
    onDragActive: vi.fn(),
    searchQuery: "",
    onSearchQuery: vi.fn(),
    brokerId: "capital",
    onOpenSymbol,
    ...overrides,
  };
  const view = render(<TabBar {...props} />);
  return { view, onOpenSymbol, props };
}

async function openSearchWithQuery(query: string) {
  const utils = renderBar({ searchQuery: query });
  fireEvent.click(screen.getByRole("button", { name: "Find open symbol" }));
  // The catalogue fetch resolves on a microtask; the dropdown (if eligible)
  // then renders rows.
  await screen.findByPlaceholderText("Find symbol…");
  return utils;
}

describe("TabBar search catalogue fallback", () => {
  it("shows catalogue rows when the query matches no open tab", async () => {
    await openSearchWithQuery("btc");
    expect(await screen.findByText("No open tab matches")).not.toBeNull();
    expect(await screen.findByText("BTCUSD")).not.toBeNull();
    expect(screen.getByText("BTCEUR")).not.toBeNull();
    expect(screen.queryByText("GOLD")).toBeNull();
  });

  it("shows no dropdown when an open tab matches", async () => {
    await openSearchWithQuery("eur");
    expect(screen.queryByText("No open tab matches")).toBeNull();
    expect(screen.queryByText("BTCEUR")).toBeNull(); // catalogue would match "eur"
  });

  it("clicking a row opens the symbol and closes the search", async () => {
    const { onOpenSymbol, props } = await openSearchWithQuery("btc");
    fireEvent.click(await screen.findByText("BTCUSD"));
    expect(onOpenSymbol).toHaveBeenCalledTimes(1);
    expect(onOpenSymbol.mock.calls[0][0].epic).toBe("BTCUSD");
    expect(props.onSearchQuery).toHaveBeenCalledWith("");
  });

  it("Enter opens the highlighted row; arrows move the highlight", async () => {
    const { onOpenSymbol } = await openSearchWithQuery("btc");
    await screen.findByText("BTCUSD");
    const input = screen.getByPlaceholderText("Find symbol…");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpenSymbol).toHaveBeenCalledTimes(1);
    expect(onOpenSymbol.mock.calls[0][0].epic).toBe("BTCEUR");
  });

  it("shows an empty state when the catalogue has no match either", async () => {
    await openSearchWithQuery("zzz");
    expect(await screen.findByText("No open tab matches")).not.toBeNull();
    expect(await screen.findByText(/No symbols match/)).not.toBeNull();
  });
});
