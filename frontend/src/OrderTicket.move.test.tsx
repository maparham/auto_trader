// @vitest-environment jsdom
//
// "Move SL / Move TP" controls live on the edit ticket's Automation tab; the
// new-order form has none. The Position tab holds only the broker's fields.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import OrderTicket from "./OrderTicket";
import type { TradingSettings } from "./theme";
import { draftOrderSignal, editTicketTabSignal, indicatorAlertRequest, lineAlertRequest, setTradeSelected } from "./lib/signals";
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

describe("OrderTicket new-order form", () => {
  it("has no Move or Warn switches (they live on the position)", async () => {
    render(<OrderTicket epic="US100" trading={trading} account="capital:paper" precision={1} />);
    await waitFor(() => expect(draftOrderSignal.value).not.toBeNull());
    expect(screen.queryByLabelText("Move SL")).toBeNull();
    expect(screen.queryByLabelText("Warn near SL")).toBeNull();
    expect(screen.queryByRole("tablist")).toBeNull();
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
    await act(async () => fireEvent.click(screen.getByRole("tab", { name: /Automation/ })));
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

  it("keeps the Position tab to broker fields only", async () => {
    await openEditor(rule({}));
    await act(async () => fireEvent.click(screen.getByRole("tab", { name: /Position/ })));
    expect(screen.queryByLabelText("Move SL")).toBeNull();
    expect(screen.getByText(/Update position/)).toBeTruthy();
  });

  it("opens on the tab the row asked for", async () => {
    mocks.subscribeTrades.mockImplementation((cb: (t: unknown[]) => void) => {
      cb([POS]);
      return () => {};
    });
    editTicketTabSignal.set({ id: "P1", tab: "alerts" });
    setTradeSelected("P1", "stop", true);
    render(<OrderTicket epic="US100" trading={trading} account="capital:paper" precision={1} />);
    expect(await screen.findByRole("button", { name: "Save alerts" })).toBeTruthy();
    expect(screen.getByLabelText("Warn near SL")).toBeTruthy();
    expect(editTicketTabSignal.value).toBeNull();
  });

  it("switches to Automation when a move line is dragged", async () => {
    await openEditor();
    await act(async () => fireEvent.click(screen.getByRole("tab", { name: /Position/ })));
    act(() => moveDraftSignal.set({
      epic: "US100", dealId: "P1", side: "buy", tp: null,
      sl: { on: true, level: 104, condition: "crossing_up", target: { type: "breakeven", offset: 0 } },
    }));
    expect((await screen.findByLabelText("Move SL trigger price") as HTMLInputElement).value).toBe("104");
  });
});
