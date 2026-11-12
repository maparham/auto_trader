// @vitest-environment jsdom
//
// "Warn near SL/TP" switches on the new-order form: disabled while their exit
// is off or for limit orders; after a filled market order each enabled side
// creates a position alert for the new deal.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import OrderTicket from "./OrderTicket";
import type { TradingSettings } from "./theme";
import { draftOrderSignal, setTradeSelected } from "./lib/signals";

const mocks = vi.hoisted(() => ({
  placeOrder: vi.fn(),
  addPositionAlert: vi.fn(async () => null as string | null),
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
  addPositionAlert: mocks.addPositionAlert,
}));

const trading = { confirmLineEdits: true } as unknown as TradingSettings;

beforeEach(() => {
  mocks.placeOrder.mockReset();
  mocks.addPositionAlert.mockReset();
  mocks.addPositionAlert.mockResolvedValue(null);
});
afterEach(() => {
  cleanup();
  setTradeSelected(null);
  draftOrderSignal.set(null);
});

async function renderTicket() {
  render(<OrderTicket epic="US100" trading={trading} account="capital:paper" precision={1} />);
  await waitFor(() => expect(draftOrderSignal.value).not.toBeNull());
}

const warnSl = () => screen.getByLabelText("Warn near SL") as HTMLButtonElement;
const warnTp = () => screen.getByLabelText("Warn near TP") as HTMLButtonElement;
const exitSwitches = () => screen.getAllByRole("switch").filter((s) => !s.getAttribute("aria-label")?.startsWith("Warn"));

describe("OrderTicket proximity warnings", () => {
  it("disables the SL switch while the stop loss is off", async () => {
    await renderTicket();
    expect(warnSl().disabled).toBe(true);
    // exitSwitches: [take profit, stop loss]
    await act(async () => fireEvent.click(exitSwitches()[1]));
    await waitFor(() => expect(warnSl().disabled).toBe(false));
  });

  it("disables both switches for a limit order and says why", async () => {
    await renderTicket();
    fireEvent.click(screen.getByRole("button", { name: /limit/i }));
    await act(async () => fireEvent.click(exitSwitches()[1]));
    expect(warnSl().disabled).toBe(true);
    fireEvent.mouseEnter(warnSl().parentElement!);
    fireEvent.focus(warnSl().parentElement!);
    expect(
      await screen.findByText("Available for market orders. Turn it on from the position once filled."),
    ).toBeTruthy();
  });

  it("creates an SL alert for the filled deal", async () => {
    mocks.placeOrder.mockResolvedValue({ status: "filled", deal_id: "D1", fill_price: 100, filled_quantity: 1 });
    await renderTicket();
    await act(async () => fireEvent.click(exitSwitches()[1]));
    await waitFor(() => expect(warnSl().disabled).toBe(false));
    await act(async () => fireEvent.click(warnSl()));
    await act(async () => fireEvent.click(document.querySelector(".ot-action")!));
    await waitFor(() => expect(mocks.addPositionAlert).toHaveBeenCalledTimes(1));
    expect(mocks.addPositionAlert).toHaveBeenCalledWith(
      expect.objectContaining({ dealId: "D1", side: "sl", atrMult: 0.5, account: "capital:paper", epic: "US100", precision: 1 }),
    );
    expect(screen.queryByText(/Warning not set/)).toBeNull();
  });

  it("shows the reason when the broker gave no deal id", async () => {
    mocks.placeOrder.mockResolvedValue({ status: "filled", deal_id: null, fill_price: 100, filled_quantity: 1 });
    await renderTicket();
    await act(async () => fireEvent.click(exitSwitches()[0]));
    await waitFor(() => expect(warnTp().disabled).toBe(false));
    await act(async () => fireEvent.click(warnTp()));
    await act(async () => fireEvent.click(document.querySelector(".ot-action")!));
    expect(await screen.findByText("Order filled. Warning not set: no deal id from the broker")).toBeTruthy();
    expect(mocks.addPositionAlert).not.toHaveBeenCalled();
  });

  it("shows the server detail when a create fails", async () => {
    mocks.placeOrder.mockResolvedValue({ status: "filled", deal_id: "D2", fill_price: 100, filled_quantity: 1 });
    mocks.addPositionAlert.mockResolvedValue("trailing_stop");
    await renderTicket();
    await act(async () => fireEvent.click(exitSwitches()[1]));
    await waitFor(() => expect(warnSl().disabled).toBe(false));
    await act(async () => fireEvent.click(warnSl()));
    await act(async () => fireEvent.click(document.querySelector(".ot-action")!));
    expect(await screen.findByText("Order filled. Warning not set: trailing_stop")).toBeTruthy();
    expect(document.querySelector(".ot-action-done")).toBeTruthy();
  });
});
