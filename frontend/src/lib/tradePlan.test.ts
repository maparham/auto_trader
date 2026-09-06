import { describe, it, expect } from "vitest";
import {
  asTradeConfig,
  defaultStopPrice,
  flipTradeLeg,
  normalizeTradePoints,
  syncTradePoints,
  tradePlan,
  type TradePlanInput,
} from "./tradePlan";

// A 1:2 long: entry 100, stop 99 (1 point risk), target 102 (2 points reward).
function longInput(over: Partial<TradePlanInput> = {}): TradePlanInput {
  return {
    entry: 100,
    stop: 99,
    target: 102,
    precision: 2,
    bars: 10,
    ms: 3_600_000,
    account: null,
    config: asTradeConfig(undefined),
    ...over,
  };
}

describe("asTradeConfig", () => {
  it("defaults the noisy label groups off and the risk budget to 1%", () => {
    const c = asTradeConfig(undefined);
    expect(c).toEqual({
      showPrice: false,
      showPoints: false,
      showMoney: false,
      showDuration: false,
      accountSize: null,
      riskPct: 1,
      valuePerPoint: 1,
      currency: null,
    });
  });

  it("keeps stored fields and fills the missing ones", () => {
    expect(asTradeConfig({ showPoints: true, riskPct: 2.5 })).toMatchObject({
      showPoints: true,
      riskPct: 2.5,
      showPrice: false,
      valuePerPoint: 1,
    });
  });

  it("reads a non-object back as all defaults", () => {
    expect(asTradeConfig("nonsense")).toEqual(asTradeConfig(undefined));
  });
});

describe("tradePlan geometry", () => {
  it("reports reward and risk as unsigned distances off the entry", () => {
    const m = tradePlan(longInput());
    expect(m.rewardPoints).toBe(2);
    expect(m.riskPoints).toBe(1);
    expect(m.rewardPct).toBeCloseTo(2);
    expect(m.riskPct).toBeCloseTo(1);
  });

  it("computes R:R as reward over risk", () => {
    expect(tradePlan(longInput()).rr).toBeCloseTo(2);
  });

  it("reads a short the same way as a long: the mirrored levels are the whole difference", () => {
    const short = tradePlan(longInput({ target: 98, stop: 101 }));
    expect(short.rewardPoints).toBe(2);
    expect(short.riskPoints).toBe(1);
    expect(short.rr).toBeCloseTo(2);
  });

  it("has no R:R when the stop sits on the entry (zero risk)", () => {
    expect(tradePlan(longInput({ stop: 100 })).rr).toBeNull();
  });
});

describe("tradePlan money", () => {
  const account = { balance: 10_000, currency: "USD" };

  it("risks the configured percent of the live account balance", () => {
    const m = tradePlan(longInput({ account }));
    expect(m.riskAmount).toBeCloseTo(100); // 1% of 10k
    expect(m.rewardAmount).toBeCloseTo(200); // 1:2
  });

  it("prefers a per-drawing account size over the live balance", () => {
    const m = tradePlan(
      longInput({ account, config: asTradeConfig({ accountSize: 50_000, riskPct: 2 }) }),
    );
    expect(m.riskAmount).toBeCloseTo(1000); // 2% of 50k
  });

  it("still sizes the trade with no account connected but a manual size set", () => {
    const m = tradePlan(longInput({ account: null, config: asTradeConfig({ accountSize: 5_000 }) }));
    expect(m.riskAmount).toBeCloseTo(50);
  });

  it("has no money figures with neither a live account nor a manual size", () => {
    const m = tradePlan(longInput());
    expect(m.riskAmount).toBeNull();
    expect(m.rewardAmount).toBeNull();
    expect(m.size).toBeNull();
  });

  it("divides risk by the stop distance in account currency to size the position", () => {
    // 100 risk / (1 point × 2 per point) = 50 units.
    const m = tradePlan(longInput({ account, config: asTradeConfig({ valuePerPoint: 2 }) }));
    expect(m.size).toBeCloseTo(50);
  });

  it("has no size when the stop sits on the entry", () => {
    expect(tradePlan(longInput({ account, stop: 100 })).size).toBeNull();
  });

  it("takes the currency from the live account, overridable per drawing", () => {
    expect(tradePlan(longInput({ account })).currency).toBe("USD");
    expect(tradePlan(longInput({ account, config: asTradeConfig({ currency: "EUR" }) })).currency)
      .toBe("EUR");
  });
});

describe("tradePlan labels", () => {
  const account = { balance: 10_000, currency: "USD" };

  it("shows only R:R at the entry and bare percentages at the levels by default", () => {
    const m = tradePlan(longInput({ account }));
    expect(m.rrLabel).toBe("R:R 1:2.00");
    expect(m.targetLines).toEqual(["+2.00%"]);
    expect(m.stopLines).toEqual(["−1.00%"]);
    expect(m.widthLine).toBeNull();
  });

  it("reports an unmeasurable R:R rather than a bogus ratio", () => {
    expect(tradePlan(longInput({ stop: 100 })).rrLabel).toBe("R:R —");
  });

  it("adds the level price when the price group is on", () => {
    const m = tradePlan(longInput({ config: asTradeConfig({ showPrice: true }) }));
    expect(m.targetLines).toEqual(["102.00  +2.00%"]);
    expect(m.stopLines).toEqual(["99.00  −1.00%"]);
  });

  it("adds the point distance when the points group is on", () => {
    const m = tradePlan(longInput({ config: asTradeConfig({ showPoints: true }) }));
    expect(m.targetLines).toEqual(["+2.00%  200 pts"]);
  });

  it("puts the money figures on a second line", () => {
    const m = tradePlan(longInput({ account, config: asTradeConfig({ showMoney: true }) }));
    expect(m.targetLines).toEqual(["+2.00%", "+200.00 USD"]);
    expect(m.stopLines).toEqual(["−1.00%", "−100.00 USD"]);
  });

  it("carries the position size on the R:R pill when money is on", () => {
    const m = tradePlan(longInput({ account, config: asTradeConfig({ showMoney: true }) }));
    expect(m.rrLabel).toBe("R:R 1:2.00  ·  100 units");
  });

  it("omits the money line when nothing funds it", () => {
    const m = tradePlan(longInput({ config: asTradeConfig({ showMoney: true }) }));
    expect(m.targetLines).toEqual(["+2.00%"]);
    expect(m.rrLabel).toBe("R:R 1:2.00");
  });

  it("reports the span as bars and elapsed time when the duration group is on", () => {
    const m = tradePlan(longInput({ config: asTradeConfig({ showDuration: true }) }));
    expect(m.widthLine).toBe("10 bars, 1h");
  });
});

describe("defaultStopPrice", () => {
  it("places the stop opposite the target at half the reward — a 1:2 trade", () => {
    expect(defaultStopPrice(100, 102)).toBeCloseTo(99);
  });

  it("mirrors for a target below the entry", () => {
    expect(defaultStopPrice(100, 98)).toBeCloseTo(101);
  });
});

describe("flipTradeLeg", () => {
  // A long: entry 100, target 102 (reward above), stop 99 (risk below).
  const long = { entry: 100, target: 102, stop: 99 };

  it("keeps quiet while the dragged target stays on its own side", () => {
    expect(flipTradeLeg(long, 1, 101)).toBeNull();
  });

  it("reflects the stop above when the target is dragged below the entry", () => {
    // Long → short: the stop keeps its 1-point distance, now on the other side.
    expect(flipTradeLeg(long, 1, 98)).toEqual({ index: 2, value: 101 });
  });

  it("reflects the target below when the stop is dragged above the entry", () => {
    expect(flipTradeLeg(long, 2, 101)).toEqual({ index: 1, value: 98 });
  });

  it("converts a short back to a long the same way", () => {
    const short = { entry: 100, target: 98, stop: 101 };
    expect(flipTradeLeg(short, 1, 103)).toEqual({ index: 2, value: 99 });
  });

  it("reflects the UNcrossed leg when the entry is dragged past the target", () => {
    // Entry dragged above the target: the target's side flipped under it, so
    // the stop is the leg that moves — up top, making a coherent short.
    expect(flipTradeLeg(long, 0, 103)).toEqual({ index: 2, value: 107 });
  });

  it("reflects the target when the entry is dragged past the stop", () => {
    expect(flipTradeLeg(long, 0, 98.5)).toEqual({ index: 1, value: 95 });
  });

  it("keeps quiet when the dragged level lands exactly on the entry", () => {
    expect(flipTradeLeg(long, 1, 100)).toBeNull();
  });

  it("keeps quiet on an ordinary entry drag that crosses nothing", () => {
    expect(flipTradeLeg(long, 0, 100.5)).toBeNull();
  });
});

describe("syncTradePoints", () => {
  const pts = [
    { timestamp: 1000, value: 100 }, // entry
    { timestamp: 2000, value: 102 }, // target
    { timestamp: 2000, value: 99 }, // stop
  ];

  it("drags the stop's right edge along when the target is moved sideways", () => {
    const out = syncTradePoints([pts[0], { timestamp: 5000, value: 102 }, pts[2]], 2000);
    expect(out?.[2]).toEqual({ timestamp: 5000, value: 99 }); // edge follows, level intact
  });

  it("moves the whole right edge when the stop is the one dragged", () => {
    const out = syncTradePoints([pts[0], pts[1], { timestamp: 400, value: 99 }], 2000);
    expect(out?.[1].timestamp).toBe(400);
    expect(out?.[2].timestamp).toBe(400);
  });

  it("reports nothing to do when the edge did not move", () => {
    expect(syncTradePoints(pts, 2000)).toBeNull();
  });

  it("reports nothing to do for an incomplete trade", () => {
    expect(syncTradePoints([pts[0], pts[1]], 2000)).toBeNull();
  });
});

describe("normalizeTradePoints", () => {
  const pt = (timestamp: number, value: number) => ({ timestamp, value });

  it("reflects a stop typed onto the target's side back across the entry", () => {
    const out = normalizeTradePoints([pt(1, 100), pt(2, 110), pt(2, 105)]);
    expect(out).toEqual([pt(1, 100), pt(2, 110), pt(2, 95)]); // its own distance, other side
  });

  it("pulls a torn stop timestamp back onto the target's edge", () => {
    const out = normalizeTradePoints([pt(1, 100), pt(3, 110), pt(2, 92)]);
    expect(out).toEqual([pt(1, 100), pt(3, 110), pt(3, 92)]);
  });

  it("returns null for an already-valid trade (nothing to write)", () => {
    expect(normalizeTradePoints([pt(1, 100), pt(2, 110), pt(2, 92)])).toBeNull();
  });

  it("returns null for non-trade shapes (fewer than 3 points)", () => {
    expect(normalizeTradePoints([pt(1, 100), pt(2, 110)])).toBeNull();
  });
});
