// The money path: "Buy limit at X" must never reach the broker from a replay
// session. See chartOrderMenu.ts for why this decision lives outside ChartCore.
import { describe, expect, it, vi } from "vitest";
import { limitOrderItems, type LimitItemDeps } from "./chartOrderMenu";

const deps = (replay: { active: boolean; canTrade: boolean }): LimitItemDeps & {
  stage: ReturnType<typeof vi.fn>;
  place: ReturnType<typeof vi.fn>;
} => {
  const stage = vi.fn();
  const place = vi.fn();
  return {
    level: 2451.5,
    label: "2451.5",
    replay,
    stage,
    place,
    icons: { buy: null, sell: null },
  };
};

describe("limitOrderItems", () => {
  it("stages a real broker draft when the cell is NOT replaying", () => {
    const d = deps({ active: false, canTrade: false });
    const [buy, sell] = limitOrderItems(d);
    expect(buy.label).toBe("Buy limit at 2451.5");
    expect(buy.disabled).toBeFalsy();
    buy.onClick();
    sell.onClick();
    expect(d.stage.mock.calls.map((c) => c[0])).toEqual([
      { side: "buy", price: 2451.5 },
      { side: "sell", price: 2451.5 },
    ]);
    expect(d.place).not.toHaveBeenCalled();
  });

  it("writes into the replay ledger, and NEVER stages, during an active session", () => {
    const d = deps({ active: true, canTrade: true });
    const [buy, sell] = limitOrderItems(d);
    expect(buy.disabled).toBeFalsy();
    buy.onClick();
    sell.onClick();
    // The guarantee: no broker draft can originate from a replayed bar's price.
    expect(d.stage).not.toHaveBeenCalled();
    expect(d.place).toHaveBeenCalledTimes(2);
    expect(d.place.mock.calls[0][0]).toEqual({
      side: "buy",
      quantity: 1,
      type: "limit",
      price: 2451.5,
      stop: null,
      takeProfit: null,
    });
    expect(d.place.mock.calls[1][0]).toMatchObject({ side: "sell", type: "limit" });
  });

  it("offers the items as unavailable, with a reason, while the cursor is rewound", () => {
    const d = deps({ active: true, canTrade: false });
    const items = limitOrderItems(d);
    expect(items).toHaveLength(2); // shown, not silently dropped
    for (const it of items) {
      expect(it.disabled).toBe(true);
      expect(it.disabledReason).toMatch(/step forward/i);
      it.onClick(); // a disabled item cannot be clicked, but it must be inert anyway
    }
    expect(d.stage).not.toHaveBeenCalled();
    expect(d.place).not.toHaveBeenCalled();
  });
});
