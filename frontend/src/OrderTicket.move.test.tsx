// @vitest-environment jsdom
//
// "Move SL / Move TP" controls on the new-order form: disabled for limit orders;
// after a filled market order each switched-on side creates a move rule for the
// new deal; a failed create is reported on the form.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import OrderTicket from "./OrderTicket";
import type { TradingSettings } from "./theme";
import { draftOrderSignal, indicatorAlertRequest, lineAlertRequest, setTradeSelected } from "./lib/signals";
import { moveDraftSignal } from "./lib/moveRuleDraft";

const mocks = vi.hoisted(() => ({
  placeOrder: vi.fn(),
  addMoveRule: vi.fn(async () => null as string | null),
  patchMoveRule: vi.fn(async () => null as string | null),
  deleteMoveRule: vi.fn(async () => null as string | null),
  findMoveRule: vi.fn((_id: unknown, _f: unknown): unknown => undefined),
  subscribeTrades: vi.fn((_cb: (t: unknown[]) => void) => () => {}),
}));
vi.mock("./lib/trading", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/trading")>()),
  fetchQuote: vi.fn(async () => ({ bid: 99, ask: 101, mid: 100 })),
  subscribeTrades: mocks.subscribeTrades,
  getLivePrice: vi.fn(() => 100),
  refreshTrades: vi.fn(),
  placeOrder: mocks.placeOrder,
}));
vi.mock("./lib/alertsApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/alertsApi")>()),
  addMoveRule: mocks.addMoveRule,
  patchMoveRule: mocks.patchMoveRule,
  deleteMoveRule: mocks.deleteMoveRule,
  findMoveRule: mocks.findMoveRule,
}));

const trading = { confirmLineEdits: true } as unknown as TradingSettings;

beforeEach(() => {
  mocks.placeOrder.mockReset();
  mocks.addMoveRule.mockReset();
  mocks.addMoveRule.mockResolvedValue(null);
  mocks.patchMoveRule.mockReset();
  mocks.patchMoveRule.mockResolvedValue(null);
  mocks.deleteMoveRule.mockReset();
  mocks.deleteMoveRule.mockResolvedValue(null);
  mocks.findMoveRule.mockReset();
  mocks.findMoveRule.mockReturnValue(undefined);
  indicatorAlertRequest.set(null);
  lineAlertRequest.set(null);
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

describe("OrderTicket move rules in edit mode", () => {
  const POS = {
    kind: "position", id: "P1", epic: "US100", side: "buy", quantity: 1, priceLevel: 100,
    stop: 95, takeProfit: null, upnl: null, openedAt: null, expiresAt: null, leverage: null, margin: null,
  };
  const rule = (over: Record<string, unknown>) => ({
    id: "r1", broker: "capital", epic: "US100", triggerKind: "price_level",
    params: { level: 105, condition: "crossing_up", trigger: "once" },
    action: { account: "capital:paper", dealId: "P1", field: "sl", target: { type: "breakeven", offset: 0 } },
    precision: 1, notify: {}, ...over,
  });
  async function openEditor(saved?: unknown) {
    mocks.findMoveRule.mockImplementation((_id: unknown, f: unknown) =>
      f === "sl" ? saved : undefined);
    mocks.subscribeTrades.mockImplementation((cb: (t: unknown[]) => void) => {
      cb([POS]);
      return () => {};
    });
    setTradeSelected("P1", "stop", true);
    render(<OrderTicket epic="US100" trading={trading} account="capital:paper" precision={1} />);
    await screen.findByText(/Update position/);
  }
  const btn = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

  it("seeds from a saved price rule", async () => {
    await openEditor(rule({}));
    expect((screen.getByLabelText("Move SL trigger price") as HTMLInputElement).value).toBe("105");
    expect((screen.getByLabelText("Move SL condition") as HTMLSelectElement).value).toBe("crossing_up");
  });

  it("creates a rule with Save when none is saved", async () => {
    await openEditor();
    await act(async () => fireEvent.click(screen.getByLabelText("Move SL")));
    expect(screen.queryByRole("button", { name: "Remove rule" })).toBeNull();
    await act(async () => fireEvent.click(btn("Save rule")));
    expect(mocks.addMoveRule).toHaveBeenCalledWith(
      expect.objectContaining({
        triggerKind: "price_level",
        params: { level: 105, condition: "crossing_up" },
        action: expect.objectContaining({ dealId: "P1", account: "capital:paper", field: "sl" }),
      }),
    );
  });

  it("patches the saved rule on Save", async () => {
    await openEditor(rule({}));
    fireEvent.change(screen.getByLabelText("Move SL condition"), { target: { value: "greater" } });
    await act(async () => fireEvent.click(btn("Save rule")));
    expect(mocks.patchMoveRule).toHaveBeenCalledWith(
      "r1",
      expect.objectContaining({ params: expect.objectContaining({ level: 105, condition: "greater" }) }),
    );
    expect(mocks.addMoveRule).not.toHaveBeenCalled();
  });

  it("deletes only through Remove rule, not the switch", async () => {
    await openEditor(rule({}));
    await act(async () => fireEvent.click(screen.getByLabelText("Move SL")));
    expect(mocks.deleteMoveRule).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Move SL trigger price")).toBeNull();
    await act(async () => fireEvent.click(screen.getByLabelText("Move SL")));
    await act(async () => fireEvent.click(btn("Remove rule")));
    expect(mocks.deleteMoveRule).toHaveBeenCalledWith("r1");
  });

  it("keeps the rule shown when the delete fails", async () => {
    mocks.deleteMoveRule.mockResolvedValue("server down");
    await openEditor(rule({}));
    await act(async () => fireEvent.click(btn("Remove rule")));
    expect(await screen.findByText("Move SL not removed: server down")).toBeTruthy();
    expect(screen.getByLabelText("Move SL trigger price")).toBeTruthy();
  });

  it("shows an indicator rule's label and opens its modal in edit mode", async () => {
    await openEditor(rule({ triggerKind: "indicator", label: "RSI above 70", params: {} }));
    expect(screen.getByText("RSI above 70")).toBeTruthy();
    await act(async () => fireEvent.click(btn("Edit")));
    expect(indicatorAlertRequest.value).toEqual({ mode: "edit", id: "r1" });
  });

  it("disables the switch for an indicator rule and ignores clicks", async () => {
    await openEditor(rule({ triggerKind: "indicator", label: "RSI above 70", params: {} }));
    const sw = screen.getByLabelText("Move SL") as HTMLButtonElement;
    expect(sw.disabled).toBe(true);
    expect(sw.getAttribute("aria-checked")).toBe("true");
    await act(async () => fireEvent.click(sw));
    expect(mocks.deleteMoveRule).not.toHaveBeenCalled();
    expect(btn("Edit")).toBeTruthy();
    expect(btn("Remove rule")).toBeTruthy();
  });

  it("opens the line modal for a line rule", async () => {
    await openEditor(rule({ triggerKind: "line", label: "Trendline", params: {} }));
    await act(async () => fireEvent.click(btn("Edit")));
    expect(lineAlertRequest.value).toEqual({ mode: "edit", id: "r1" });
  });
});
