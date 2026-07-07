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
import { searchInstruments, type Instrument } from "./lib/feed";

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
  it("shows NO open-row for a valid expression; Enter opens the synthetic", async () => {
    const onPick = await renderModal();

    const input = screen.getByPlaceholderText("Symbol or name…");
    fireEvent.change(input, { target: { value: "OIL_CRUDE/DXY" } });

    // No clickable "= …" / "Synthetic · …" row is rendered anymore.
    expect(screen.queryByText("= OIL_CRUDE/DXY")).toBeNull();
    expect(screen.queryByText("Synthetic · OIL_CRUDE, DXY")).toBeNull();

    fireEvent.keyDown(input, { key: "Enter" });

    expect(onPick).toHaveBeenCalledTimes(1);
    const picked = onPick.mock.calls[0][0];
    expect(picked.epic).toMatch(/^SYN_/);
    expect(picked.type).toBe("SYNTHETIC");
    expect(picked.name).toBe("OIL_CRUDE/DXY");
    expect(picked.status).toBe("TRADEABLE");
  });

  it("shows an unknown-instrument message and no actionable row for a missing symbol", async () => {
    await renderModal();

    const input = screen.getByPlaceholderText("Symbol or name…");
    fireEvent.change(input, { target: { value: "OIL_CRUDE/NOPE" } });

    expect(await screen.findByText(/Unknown instrument: NOPE/)).not.toBeNull();
    expect(screen.queryByText("= OIL_CRUDE/NOPE")).toBeNull();
  });
});

describe("SymbolSearchModal — inline symbol autocomplete", () => {
  it("clicking a result row with the operators toggle OFF opens the chart immediately", async () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(
      <SymbolSearchModal current={CURRENT} brokerId="capital" onPick={onPick} onClose={onClose} />,
    );
    fireEvent.click(screen.getByText("All"));
    await waitFor(() => expect(screen.queryByText("DXY")).not.toBeNull());

    fireEvent.click(screen.getByText("DXY"));

    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ epic: "DXY" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("clicking a result row with the operators toggle ON appends a symbol and does NOT open the chart", async () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(
      <SymbolSearchModal current={CURRENT} brokerId="capital" onPick={onPick} onClose={onClose} />,
    );
    const input = screen.getByPlaceholderText("Symbol or name…") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "OIL_CRUDE / dx" } });
    // Activating the spread-operators toggle switches to "building a spread" mode.
    fireEvent.click(screen.getByLabelText("Show spread operators"));
    await waitFor(() => expect(screen.queryByText("DXY")).not.toBeNull());

    fireEvent.click(screen.getByText("DXY"));

    expect(onPick).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(input.value).toBe("OIL_CRUDE / DXY");
  });

  it("the spread-operators toggle reveals operator buttons that insert into the box", async () => {
    await renderModal();
    const input = screen.getByPlaceholderText("Symbol or name…") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "OIL_CRUDE" } });

    // Operators hidden until the toggle is clicked.
    expect(screen.queryByLabelText("Divide")).toBeNull();
    fireEvent.click(screen.getByLabelText("Show spread operators"));

    fireEvent.click(screen.getByLabelText("Divide"));
    expect(input.value).toBe("OIL_CRUDE / ");
  });

  it("Enter on a single resolved symbol opens it", async () => {
    const onPick = await renderModal();
    const input = screen.getByPlaceholderText("Symbol or name…");
    fireEvent.change(input, { target: { value: "DXY" } });

    fireEvent.keyDown(input, { key: "Enter" });

    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ epic: "DXY" }));
  });

  it("shows a catalogue symbol matched by its exact epic even when broker search returns nothing", async () => {
    // The broker `searchInstruments` mock resolves [] (it matches display names,
    // not the underscored epic). The local catalogue match must still surface it.
    await renderModal();
    const input = screen.getByPlaceholderText("Symbol or name…");
    fireEvent.change(input, { target: { value: "OIL_CRUDE" } });

    expect((await screen.findAllByText("OIL_CRUDE")).length).toBeGreaterThan(0);
    expect(screen.queryByText(/No symbols match/)).toBeNull();
  });

  it("formula-mode search targets the active symbol fragment, not the whole box", async () => {
    await renderModal();
    const input = screen.getByPlaceholderText("Symbol or name…");
    fireEvent.change(input, { target: { value: "OIL_CRUDE / dx" } });
    await waitFor(() =>
      expect(searchInstruments).toHaveBeenCalledWith("dx", "capital"),
    );
  });

});
