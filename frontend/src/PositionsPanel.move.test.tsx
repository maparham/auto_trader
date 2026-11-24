// @vitest-environment jsdom
// The position row's move-rule marker: shown only for a position with a rule,
// click opens the ticket in edit mode on the rule's field.
import { afterEach, describe, expect, it, vi } from "vitest";
import { installMemStorage } from "./lib/testMemStorage";

installMemStorage();
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("klinecharts", () => ({ registerIndicator: () => {}, registerOverlay: () => {}, registerYAxis: () => {}, getSupportedIndicators: () => [] }));

const state = vi.hoisted(() => ({ rules: [] as unknown[] }));
vi.mock("./lib/alertsApi", async (orig) => ({
  ...(await orig<typeof import("./lib/alertsApi")>()),
  loadMoveRules: () => state.rules,
}));
const trade = {
  kind: "position", id: "d1", epic: "EURUSD", side: "buy", quantity: 1, priceLevel: 1.1,
  stop: null, takeProfit: null, upnl: 0, openedAt: 1, expiresAt: null, leverage: null, margin: null,
};
vi.mock("./lib/trading", async (orig) => ({
  ...(await orig<typeof import("./lib/trading")>()),
  subscribeTrades: (fn: (t: unknown[]) => void) => { fn([trade]); return () => {}; },
}));

const { default: PositionsPanel } = await import("./PositionsPanel");
const signals = await import("./lib/signals");
const { DEFAULT_SETTINGS } = await import("./theme");

const rule = {
  id: "m1", broker: "capital", epic: "EURUSD", triggerKind: "price_level",
  params: { level: 1.105, condition: "crossing_up" },
  action: { account: "capital:paper", dealId: "d1", field: "tp", target: { type: "breakeven", offset: 0 } },
  precision: 4, notify: {},
};
const mount = () => render(<PositionsPanel account="capital:paper" trading={DEFAULT_SETTINGS.trading} />);

afterEach(() => { cleanup(); state.rules = []; signals.editTicketTabSignal.set(null); });

describe("PositionsPanel move-rule marker", () => {
  it("is absent without a rule", () => {
    mount();
    expect(screen.queryByRole("button", { name: "Move rules" })).toBeNull();
  });
  it("shows with a rule and opens the ticket on the rule's field", () => {
    state.rules = [rule];
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Move rules" }));
    expect(signals.editTradeSignal.value).toBe("d1");
    expect(signals.tradeLineUiSignal.value.selectedField).toBe("tp");
  });
  it("opens the ticket on the Automation tab", () => {
    state.rules = [rule];
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Move rules" }));
    expect(signals.editTicketTabSignal.value).toEqual({ id: "d1", tab: "automation" });
  });
  it("the bell opens the ticket on the Alerts tab", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Warn near SL/TP" }));
    expect(signals.editTradeSignal.value).toBe("d1");
    expect(signals.editTicketTabSignal.value).toEqual({ id: "d1", tab: "alerts" });
  });
});
