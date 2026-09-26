// @vitest-environment jsdom
//
// Exits set in ATRs: the row shows and takes a multiple of ATR(length) on the
// focused chart's timeframe, while the draft keeps holding a PRICE (the chart
// lines and validation read that), so typing a multiple writes ref ± m·ATR.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import OrderTicket from "./OrderTicket";
import type { TradingSettings } from "./theme";
import { draftOrderSignal, setTradeSelected } from "./lib/signals";

vi.mock("./lib/trading", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/trading")>()),
  fetchQuote: vi.fn(async () => ({ bid: 99, ask: 101, mid: 100 })),
  subscribeTrades: vi.fn(() => () => {}),
  getLivePrice: vi.fn(() => 100),
  refreshTrades: vi.fn(),
  placeOrder: vi.fn(async () => ({})),
}));

// Every bar spans 2 points with no gaps, so ATR(any length) is exactly 2.
const feed = vi.hoisted(() => ({
  fetchRecent: vi.fn(async () =>
    Array.from({ length: 300 }, (_, i) => ({
      timestamp: i * 3_600_000, open: 100, high: 101, low: 99, close: 100,
    })),
  ),
}));
vi.mock("./lib/feed", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/feed")>()),
  ...feed,
}));

const trading = { confirmLineEdits: true } as unknown as TradingSettings;

afterEach(() => {
  cleanup();
  feed.fetchRecent.mockClear();
  setTradeSelected(null);
  draftOrderSignal.set(null);
});

describe("OrderTicket exits in ATRs", () => {
  it("writes entry + multiple × ATR to the draft and fetches on the chart timeframe", async () => {
    render(<OrderTicket epic="US100" trading={trading} resolution="HOUR" brokerId="capital" />);
    await waitFor(() => expect(draftOrderSignal.value).not.toBeNull());

    fireEvent.click(screen.getByLabelText("Take profit unit"));
    fireEvent.click(screen.getByRole("option", { name: "ATR" }));
    await waitFor(() =>
      expect(feed.fetchRecent).toHaveBeenCalledWith("US100", "HOUR", 500, "mid", "capital"),
    );

    // Toggling on in ATR mode seeds 1 ATR above a long's entry.
    await act(async () => fireEvent.click(screen.getAllByRole("switch")[0]));
    await waitFor(() => expect(draftOrderSignal.value?.takeProfit).toBe(102));

    const input = screen.getByLabelText("Take profit in ATRs") as HTMLInputElement;
    expect(input.value).toBe("1");
    fireEvent.change(input, { target: { value: "2.5" } });
    expect(draftOrderSignal.value?.takeProfit).toBe(105);
    expect(screen.getByText("105.00 · +5.00%")).toBeTruthy();
  });

  // Each test picks ATR itself: the unit preference is module-global, so a
  // test must not lean on one an earlier test left behind.
  async function renderInAtrMode() {
    render(<OrderTicket epic="US100" trading={trading} resolution="HOUR" brokerId="capital" />);
    await waitFor(() => expect(draftOrderSignal.value).not.toBeNull());
    fireEvent.click(screen.getByLabelText("Take profit unit"));
    fireEvent.click(screen.getByRole("option", { name: "ATR" }));
    await waitFor(() => expect(feed.fetchRecent).toHaveBeenCalled());
    // Let the ATR fetch land before toggling, so the seed is ATR-based.
    await act(async () => {
      await feed.fetchRecent.mock.results.at(-1)?.value;
    });
    await act(async () => fireEvent.click(screen.getAllByRole("switch")[0]));
    await waitFor(() => expect(draftOrderSignal.value?.takeProfit).toBe(102));
    return screen.getByLabelText("Take profit in ATRs") as HTMLInputElement;
  }

  it("flags a zero multiple as wrong-sided", async () => {
    const input = await renderInAtrMode();
    fireEvent.change(input, { target: { value: "0" } });
    expect(draftOrderSignal.value?.takeProfit).toBe(100);
    expect(input.closest(".ot-input-row")?.classList.contains("invalid")).toBe(true);
  });

  it("clearing the multiple and leaving the field keeps the level", async () => {
    const input = await renderInAtrMode();
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(draftOrderSignal.value?.takeProfit).toBe(102);
    expect(input.value).toBe("1");
  });
});
