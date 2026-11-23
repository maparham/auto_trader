// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const { feed, admin } = vi.hoisted(() => ({
  feed: { trades: [] as unknown[] },
  admin: { value: true },
}));
vi.mock("../lib/trading", async (orig) => ({
  ...(await orig<typeof import("../lib/trading")>()),
  isAdminAccount: () => admin.value,
  getTradesAccount: () => "capital-demo:demo",
  subscribeTrades: (fn: (t: unknown[]) => void) => { fn(feed.trades); return () => {}; },
}));

import MoveActionPicker, { type MovePick } from "./MoveActionPicker";
import type { TradeView } from "../lib/trading";

const trade = (over: Partial<TradeView>): TradeView => ({
  kind: "position", id: "d1", epic: "US100", side: "buy", quantity: 2, priceLevel: 100, stop: null,
  takeProfit: null, upnl: null, openedAt: null, expiresAt: null, leverage: null, margin: null, ...over,
});
const sl: MovePick = { field: "sl", dealId: "d1", account: "capital-demo:demo", target: { type: "breakeven", offset: 0 } };

afterEach(() => { cleanup(); admin.value = true; });

describe("MoveActionPicker", () => {
  it("lists only positions on the epic", () => {
    feed.trades = [trade({ id: "d1" }), trade({ id: "d2", epic: "GOLD" }), trade({ id: "o1", kind: "order" })];
    render(<MoveActionPicker epic="US100" value={sl} onChange={() => {}} />);
    const opts = [...screen.getByLabelText("Position").querySelectorAll("option")];
    expect(opts).toHaveLength(1);
    expect(opts[0].textContent).toMatch(/Long 2 @ 100/);
  });

  it("disables a trailing-stop position for Move SL only", () => {
    feed.trades = [trade({ id: "d1", trailingStop: true })];
    const { rerender } = render(<MoveActionPicker epic="US100" value={sl} onChange={() => {}} />);
    expect((screen.getByLabelText("Position").querySelector("option[value=d1]") as HTMLOptionElement).disabled).toBe(true);
    rerender(<MoveActionPicker epic="US100" value={{ ...sl, field: "tp" }} onChange={() => {}} />);
    expect((screen.getByLabelText("Position").querySelector("option[value=d1]") as HTMLOptionElement).disabled).toBe(false);
  });

  it("choosing Move TP with no position yet picks the first fit", () => {
    feed.trades = [trade({ id: "d1", trailingStop: true }), trade({ id: "d2" })];
    const onChange = vi.fn();
    render(<MoveActionPicker epic="US100" value={{ ...sl, dealId: "" }} onChange={onChange} />);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ dealId: "d2", account: "capital-demo:demo" }));
  });

  it("selecting Notify clears the move", () => {
    feed.trades = [trade({})];
    const onChange = vi.fn();
    render(<MoveActionPicker epic="US100" value={sl} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Then"), { target: { value: "notify" } });
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("is hidden for a non-admin", () => {
    admin.value = false;
    feed.trades = [trade({})];
    render(<MoveActionPicker epic="US100" value={null} onChange={() => {}} />);
    expect(screen.queryByLabelText("Then")).toBeNull();
  });
});
