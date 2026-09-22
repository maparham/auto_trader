// @vitest-environment jsdom
//
// In demo mode a signed-out visitor has no recent picks, so the modal opens on
// "All" (not "Recent", which would be empty) and lists the demo broker's
// catalogue straight away.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { installMemStorage } from "./lib/testMemStorage";

installMemStorage();

vi.mock("./lib/demoMode", () => ({
  isDemoMode: () => true,
  setDemoMode: () => {},
}));

vi.mock("./lib/feed", async () => {
  const actual = await vi.importActual<typeof import("./lib/feed")>("./lib/feed");
  return {
    ...actual,
    fetchAllMarkets: vi.fn().mockResolvedValue([
      { epic: "OIL_CRUDE", name: "Crude Oil", status: "TRADEABLE", type: "COMMODITIES" },
      { epic: "DXY", name: "US Dollar Index", status: "TRADEABLE", type: "INDICES" },
    ]),
    fetchFavorites: vi.fn().mockResolvedValue([]),
    searchInstruments: vi.fn().mockResolvedValue([]),
    addFavorite: vi.fn().mockResolvedValue(undefined),
    removeFavorite: vi.fn().mockResolvedValue(undefined),
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
  it("opens on All with the broker catalogue listed", async () => {
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
