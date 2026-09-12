// @vitest-environment jsdom
//
// Finding 3 (public-demo fix wave): in demo mode /api/markets/all and
// /api/favorites are unauthenticated (401 -> []), so the modal's usual
// catalogue/favorites fetch comes back empty and the opening view has
// nothing to browse. The demo path instead fetches /api/market/{epic} per
// whitelisted epic and uses that as the catalogue.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { installMemStorage } from "./lib/testMemStorage";

installMemStorage();

vi.mock("./lib/demoBoot", () => ({
  demoAllowedEpics: () => ["OIL_CRUDE", "DXY"],
}));

vi.mock("./lib/feed", async () => {
  const actual = await vi.importActual<typeof import("./lib/feed")>("./lib/feed");
  return {
    ...actual,
    fetchAllMarkets: vi.fn().mockResolvedValue([]),
    fetchFavorites: vi.fn().mockResolvedValue([]),
    searchInstruments: vi.fn().mockResolvedValue([]),
    addFavorite: vi.fn().mockResolvedValue(undefined),
    removeFavorite: vi.fn().mockResolvedValue(undefined),
    fetchMarketMeta: vi.fn(async (epic: string) => ({
      pricePrecision: epic === "OIL_CRUDE" ? 3 : 2,
      closed: false,
      nextOpen: null,
    })),
  };
});

import SymbolSearchModal from "./SymbolSearchModal";
import type { Instrument } from "./lib/feed";

afterEach(cleanup);

const CURRENT: Instrument = {
  epic: "OIL_CRUDE",
  name: "Crude Oil",
  status: "TRADEABLE",
  type: "COMMODITIES",
};

describe("SymbolSearchModal in demo mode", () => {
  it("opens on a browsable curated watchlist built from per-epic market fetches", async () => {
    render(
      <SymbolSearchModal current={CURRENT} brokerId="dukascopy" onPick={vi.fn()} onClose={vi.fn()} />,
    );
    // Opening view is "All" in demo (not "Recent", which would be empty for a
    // signed-out visitor with no prior picks).
    expect(screen.getByText("All").className).toContain("on");
    await waitFor(() => expect(screen.queryAllByText("OIL_CRUDE").length).toBeGreaterThan(0));
    expect(screen.queryAllByText("DXY").length).toBeGreaterThan(0);
  });
});
