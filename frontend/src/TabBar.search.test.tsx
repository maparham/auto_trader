// @vitest-environment jsdom
// Tab-bar search catalogue fallback (spec
// 2026-08-12-tab-search-catalogue-fallback): when the query matches no OPEN
// tab, a dropdown lists full-catalogue symbols and picking one opens a new tab.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";

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

  // The closer runs on click, not mousedown, precisely so this works: closing
  // reflows the strip, which on mousedown would move the chip out from under
  // the cursor before its own click landed.
  it("clicking a tab chip selects it AND closes the search", async () => {
    const { props } = await openSearchWithQuery("eur");
    fireEvent.click(screen.getByText("EURUSD"));
    expect(props.onSelect).toHaveBeenCalledWith("t1");
    expect(props.onSearchQuery).toHaveBeenCalledWith("");
    expect(screen.queryByPlaceholderText("Find symbol…")).toBeNull();
  });

  // Regression: a trusted click on the magnifier reaches the document-level
  // closer with its target ALREADY unmounted (React swaps in the input during
  // the same dispatch, and the effect attaches the listener mid-propagation),
  // so a plain box.contains(target) test read it as an outside click and shut
  // the search the instant it opened.
  it("a click that unmounts its own target doesn't close the search", async () => {
    await openSearchWithQuery("eur");
    const box = document.querySelector(".tab-bar-search");
    const ghost = document.createElement("span");
    box?.appendChild(ghost);
    ghost.addEventListener("click", () => ghost.remove());
    ghost.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    // The closer's setState lands outside React's own event, so it only
    // flushes on the next tick — assert after that, or the stale input passes.
    await act(async () => {});
    expect(screen.queryByPlaceholderText("Find symbol…")).not.toBeNull();
  });

  it("clicking inside the search control leaves it open", async () => {
    await openSearchWithQuery("eur");
    fireEvent.click(screen.getByPlaceholderText("Find symbol…"));
    await act(async () => {});
    expect(screen.queryByPlaceholderText("Find symbol…")).not.toBeNull();
  });

  it("shows an empty state when the catalogue has no match either", async () => {
    await openSearchWithQuery("zzz");
    expect(await screen.findByText("No open tab matches")).not.toBeNull();
    expect(await screen.findByText(/No symbols match/)).not.toBeNull();
  });
});
