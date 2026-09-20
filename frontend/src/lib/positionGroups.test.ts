import { describe, expect, it } from "vitest";
import { aggregateLegs, groupPositions, type GroupLeg } from "./positionGroups";

const leg = (o: Partial<GroupLeg>): GroupLeg => ({
  epic: "TSLA",
  side: "buy",
  quantity: 1,
  priceLevel: 100,
  upnl: null,
  last: null,
  pnlPct: null,
  tradeValue: 100,
  marketValue: null,
  leverage: 5,
  margin: 20,
  openedAt: null,
  ...o,
});

describe("aggregateLegs", () => {
  it("size-weights the entry and sums P&L, notionals and margin", () => {
    const g = aggregateLegs([
      leg({ quantity: 6, priceLevel: 350, upnl: 60, tradeValue: 2100, marketValue: 2160, margin: 420, last: 360, pnlPct: 2.857, openedAt: 200 }),
      leg({ quantity: 6, priceLevel: 300, upnl: 360, tradeValue: 1800, marketValue: 2160, margin: 360, last: 360, pnlPct: 20, openedAt: 100 }),
    ]);
    expect(g.side).toBe("buy");
    expect(g.quantity).toBe(12);
    expect(g.priceLevel).toBe(325);
    expect(g.upnl).toBe(420);
    expect(g.tradeValue).toBe(3900);
    expect(g.marketValue).toBe(4320);
    expect(g.margin).toBe(780);
    expect(g.last).toBe(360);
    expect(g.leverage).toBe(5);
    expect(g.openedAt).toBe(100);
    // weighted by trade value: (2.857*2100 + 20*1800) / 3900
    expect(g.pnlPct).toBeCloseTo(10.77, 2);
  });

  it("nets hedged legs into a mixed group and nulls mismatched leverage", () => {
    const g = aggregateLegs([
      leg({ side: "buy", quantity: 3, leverage: 5 }),
      leg({ side: "sell", quantity: 1, leverage: 10 }),
    ]);
    expect(g.side).toBe("mixed");
    expect(g.quantity).toBe(2);
    expect(g.leverage).toBeNull();
    expect(g.upnl).toBeNull();
    expect(g.marketValue).toBeNull();
    expect(g.pnlPct).toBeNull();
  });
});

describe("groupPositions", () => {
  it("groups by epic in first-appearance order", () => {
    const gs = groupPositions([
      leg({ epic: "NATURALGAS" }),
      leg({ epic: "TSLA" }),
      leg({ epic: "TSLA" }),
    ]);
    expect(gs.map((g) => [g.epic, g.legs.length])).toEqual([["NATURALGAS", 1], ["TSLA", 2]]);
  });
});
