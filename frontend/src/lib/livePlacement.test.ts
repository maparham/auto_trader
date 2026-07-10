import { describe, it, expect, vi } from "vitest";
import { placeActions } from "./livePlacement";
import type { LiveAction } from "./liveTypes";

const openAction: LiveAction = {
  kind: "open", leg: "long", side: "buy", reason: "cross",
  stop_level: 9, take_profit_level: 12,
};

describe("placeActions", () => {
  it("opens with a derived client_order_id and the bracket", async () => {
    const placeOrder = vi.fn().mockResolvedValue({ status: "filled" });
    const closePosition = vi.fn();
    await placeActions([openAction], {
      strategyId: "s1", barTsSec: 1700, epic: "EURUSD", account: "capital:demo",
      quantity: 2, confirm: false, openPosition: null,
      _deps: { placeOrder, closePosition },
    });
    expect(placeOrder).toHaveBeenCalledWith(expect.objectContaining({
      epic: "EURUSD", side: "buy", quantity: 2, source: "strategy",
      stop_level: 9, take_profit_level: 12,
      client_order_id: "s1:1700:long:buy",
    }));
  });

  it("uses the action's explicit quantity when a coded strategy sets one", async () => {
    const placeOrder = vi.fn().mockResolvedValue({ status: "filled" });
    const closePosition = vi.fn();
    const withQty: LiveAction = { ...openAction, quantity: 0.5 };
    await placeActions([withQty], {
      strategyId: "s1", barTsSec: 1700, epic: "EURUSD", account: "capital:demo",
      quantity: 2, confirm: false, openPosition: null,
      _deps: { placeOrder, closePosition },
    });
    expect(placeOrder).toHaveBeenCalledWith(expect.objectContaining({ quantity: 0.5 }));
  });

  it("falls back to the panel quantity when the action has no explicit size", async () => {
    const placeOrder = vi.fn().mockResolvedValue({ status: "filled" });
    const closePosition = vi.fn();
    await placeActions([openAction], {
      strategyId: "s1", barTsSec: 1700, epic: "EURUSD", account: "capital:demo",
      quantity: 2, confirm: false, openPosition: null,
      _deps: { placeOrder, closePosition },
    });
    expect(placeOrder).toHaveBeenCalledWith(expect.objectContaining({ quantity: 2 }));
  });

  it("closes the matching open position", async () => {
    const placeOrder = vi.fn();
    const closePosition = vi.fn().mockResolvedValue({ status: "filled" });
    const close: LiveAction = { kind: "close", leg: "long", side: "sell", reason: "exit" };
    await placeActions([close], {
      strategyId: "s1", barTsSec: 1700, epic: "EURUSD", account: "capital:demo",
      quantity: 1, confirm: false,
      openPosition: { kind: "position", id: "deal-9", epic: "EURUSD", side: "buy", quantity: 1,
        priceLevel: 10, stop: null, takeProfit: null, upnl: 0, openedAt: null, expiresAt: null, leverage: null, margin: null },
      _deps: { placeOrder, closePosition },
    });
    expect(closePosition).toHaveBeenCalledWith("deal-9", "capital:demo");
    expect(placeOrder).not.toHaveBeenCalled();
  });

  it("close with no open position is a no-op success", async () => {
    const placeOrder = vi.fn();
    const closePosition = vi.fn();
    const close: LiveAction = { kind: "close", leg: "long", side: "sell", reason: "exit" };
    const out = await placeActions([close], {
      strategyId: "s1", barTsSec: 1700, epic: "EURUSD", account: "capital:demo",
      quantity: 1, confirm: false, openPosition: null,
      _deps: { placeOrder, closePosition },
    });
    expect(closePosition).not.toHaveBeenCalled();
    expect(out[0].ok).toBe(true);
  });
});
