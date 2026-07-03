// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { installMemStorage } from "./lib/testMemStorage";

// registerSynthetic persists to localStorage; SymbolSearchModal also uses
// persist.ts's recent-symbols helpers, which touch localStorage too.
installMemStorage();

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

// Vitest doesn't run with jest-style `globals: true`, so RTL's automatic
// afterEach cleanup never registers here without this explicit call.
afterEach(cleanup);

const CURRENT: Instrument = {
  epic: "OIL_CRUDE",
  name: "Crude Oil",
  status: "TRADEABLE",
  type: "COMMODITIES",
};

async function renderModal(onPick = vi.fn()) {
  render(
    <SymbolSearchModal current={CURRENT} brokerId="capital" onPick={onPick} onClose={vi.fn()} />,
  );
  // Switch to "All" so the catalogue-derived rows are queryable once loaded,
  // confirming the async catalogue fetch has resolved before we type.
  fireEvent.click(screen.getByText("All"));
  await waitFor(() => expect(screen.queryByText("DXY")).not.toBeNull());
  return onPick;
}

describe("SymbolSearchModal — synthetic creation", () => {
  it("offers a create-synthetic row for a valid expression and opens it via onPick", async () => {
    const onPick = await renderModal();

    const input = screen.getByPlaceholderText("Symbol or name…");
    fireEvent.change(input, { target: { value: "OIL_CRUDE/DXY" } });

    const row = await screen.findByText("= OIL_CRUDE/DXY");
    expect(screen.queryByText("Synthetic · OIL_CRUDE, DXY")).not.toBeNull();

    fireEvent.click(row.closest("button")!);

    expect(onPick).toHaveBeenCalledTimes(1);
    const picked = onPick.mock.calls[0][0];
    expect(picked.epic).toMatch(/^SYN_/);
    expect(picked.type).toBe("SYNTHETIC");
    expect(picked.name).toBe("OIL_CRUDE/DXY");
    expect(picked.status).toBe("TRADEABLE");
  });

  it("shows an unknown-instrument message and no actionable row for a missing leg", async () => {
    await renderModal();

    const input = screen.getByPlaceholderText("Symbol or name…");
    fireEvent.change(input, { target: { value: "OIL_CRUDE/NOPE" } });

    expect(await screen.findByText(/Unknown instrument: NOPE/)).not.toBeNull();
    expect(screen.queryByText("= OIL_CRUDE/NOPE")).toBeNull();
  });
});
