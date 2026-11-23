// @vitest-environment jsdom
//
// "Move SL / Move TP" controls on the new-order form: disabled for limit orders;
// after a filled market order each switched-on side creates a move rule for the
// new deal; a failed create is reported on the form.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import OrderTicket from "./OrderTicket";
import type { TradingSettings } from "./theme";
import { draftOrderSignal, setTradeSelected } from "./lib/signals";
import { moveDraftSignal } from "./lib/moveRuleDraft";

const mocks = vi.hoisted(() => ({
  placeOrder: vi.fn(),
  addMoveRule: vi.fn(async () => null as string | null),
}));
vi.mock("./lib/trading", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/trading")>()),
  fetchQuote: vi.fn(async () => ({ bid: 99, ask: 101, mid: 100 })),
  subscribeTrades: vi.fn(() => () => {}),
  getLivePrice: vi.fn(() => 100),
  refreshTrades: vi.fn(),
  placeOrder: mocks.placeOrder,
}));
vi.mock("./lib/alertsApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/alertsApi")>()),
  addMoveRule: mocks.addMoveRule,
}));

const trading = { confirmLineEdits: true } as unknown as TradingSettings;

beforeEach(() => {
  mocks.placeOrder.mockReset();
  mocks.addMoveRule.mockReset();
  mocks.addMoveRule.mockResolvedValue(null);
});
afterEach(() => {
  cleanup();
  setTradeSelected(null);
  draftOrderSignal.set(null);
  moveDraftSignal.set(null);
});

async function renderTicket() {
  render(<OrderTicket epic="US100" trading={trading} account="capital:paper" precision={1} />);
  await waitFor(() => expect(draftOrderSignal.value).not.toBeNull());
}
const moveSl = () => screen.getByLabelText("Move SL") as HTMLButtonElement;
const fill = () => act(async () => fireEvent.click(document.querySelector(".ot-action")!));

describe("OrderTicket move rules", () => {
  it("posts a rule for the filled deal", async () => {
    mocks.placeOrder.mockResolvedValue({ status: "filled", deal_id: "D1", fill_price: 100, filled_quantity: 1 });
    await renderTicket();
    await act(async () => fireEvent.click(moveSl()));
    expect(moveDraftSignal.value?.sl).toMatchObject({ on: true, condition: "crossing_up" });
    await fill();
    await waitFor(() => expect(mocks.addMoveRule).toHaveBeenCalledTimes(1));
    expect(mocks.addMoveRule).toHaveBeenCalledWith(
      expect.objectContaining({
        broker: "capital",
        epic: "US100",
        triggerKind: "price_level",
        precision: 1,
        params: expect.objectContaining({ condition: "crossing_up" }),
        action: expect.objectContaining({ dealId: "D1", account: "capital:paper", field: "sl", target: { type: "breakeven", offset: 0 } }),
      }),
    );
    expect(moveDraftSignal.value).toBeNull();
  });

  it("shows the reason when the server refuses", async () => {
    mocks.placeOrder.mockResolvedValue({ status: "filled", deal_id: "D2", fill_price: 100, filled_quantity: 1 });
    mocks.addMoveRule.mockResolvedValue("A move rule already exists");
    await renderTicket();
    await act(async () => fireEvent.click(moveSl()));
    await fill();
    expect(await screen.findByText("Order filled. Move SL not set: A move rule already exists")).toBeTruthy();
  });

  it("disables the switch for a limit order", async () => {
    await renderTicket();
    fireEvent.click(screen.getByRole("button", { name: /limit/i }));
    await waitFor(() => expect(moveSl().disabled).toBe(true));
    expect((screen.getByLabelText("Move TP") as HTMLButtonElement).disabled).toBe(true);
  });
});
