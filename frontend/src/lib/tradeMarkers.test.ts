import { describe, it, expect } from "vitest";
import { tradeMarkerSpecs, journalKey, aggregateExitsByBar, exitsCollide } from "./tradeMarkers";
import type { TradeView } from "./trading";
import type { JournalTrade } from "./liveJournal";

// A minimal open position on epic "OIL", overridable per test.
function position(over: Partial<TradeView> = {}): TradeView {
  return {
    kind: "position",
    id: "deal-1",
    epic: "OIL",
    side: "buy",
    quantity: 0.5,
    priceLevel: 70.15,
    stop: null,
    takeProfit: null,
    upnl: null,
    openedAt: 2_000, // ms
    leverage: null,
    margin: null,
    ...over,
  };
}

function journal(over: Partial<JournalTrade> = {}): JournalTrade {
  return {
    ts: 3, // unix SECONDS -> 3_000 ms
    epic: "OIL",
    leg: "long",
    entry: 70.0,
    exit: 70.15,
    quantity: 0.5,
    pnl: 12.4,
    ...over,
  };
}

const base = { epic: "OIL", precision: 2, oldestLoadedMs: 0 };

describe("tradeMarkerSpecs — entry markers", () => {
  it("open long → one entry spec below, neutral (win null), labeled word/qty/price", () => {
    const specs = tradeMarkerSpecs({ ...base, trades: [position()], journal: [] });
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({
      key: "entry:deal-1",
      timestamp: 2_000,
      price: 70.15,
      label: "Long 0.5 @ 70.15",
      win: null,
      placement: "below",
    });
  });

  it("open short → entry marker above", () => {
    const specs = tradeMarkerSpecs({ ...base, trades: [position({ side: "sell" })], journal: [] });
    expect(specs[0].placement).toBe("above");
    expect(specs[0].label).toBe("Short 0.5 @ 70.15");
  });

  it("skips resting limit orders (only positions get entry markers)", () => {
    const order = position({ kind: "order", id: "ord-1" });
    expect(tradeMarkerSpecs({ ...base, trades: [order], journal: [] })).toHaveLength(0);
  });

  it("skips a position with no open time (can't anchor)", () => {
    expect(tradeMarkerSpecs({ ...base, trades: [position({ openedAt: null })], journal: [] })).toHaveLength(0);
  });

  it("filters to the cell's epic", () => {
    const other = position({ id: "deal-2", epic: "GOLD" });
    const specs = tradeMarkerSpecs({ ...base, trades: [position(), other], journal: [] });
    expect(specs.map((s) => s.key)).toEqual(["entry:deal-1"]);
  });
});

describe("tradeMarkerSpecs — exit markers", () => {
  it("journal winner → exit spec win true (green), pnl label, unix-sec → ms", () => {
    const specs = tradeMarkerSpecs({ ...base, trades: [], journal: [journal()] });
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({
      key: `exit:${journalKey(journal())}`,
      timestamp: 3_000, // ts 3s converted to ms
      price: 70.15,
      label: "+12.40",
      win: true,
      placement: "below", // long
    });
  });

  it("journal loser → win false (red), signed 2dp label, short → above", () => {
    const specs = tradeMarkerSpecs({
      ...base,
      trades: [],
      journal: [journal({ leg: "short", pnl: -8.1 })],
    });
    expect(specs[0]).toMatchObject({ label: "-8.10", win: false, placement: "above" });
  });

  it("break-even (pnl 0) counts as a win (TP-style)", () => {
    const specs = tradeMarkerSpecs({ ...base, trades: [], journal: [journal({ pnl: 0 })] });
    expect(specs[0]).toMatchObject({ win: true, label: "+0.00" });
  });

  it("filters journal to the cell's epic", () => {
    const specs = tradeMarkerSpecs({
      ...base,
      trades: [],
      journal: [journal(), journal({ epic: "GOLD" })],
    });
    expect(specs).toHaveLength(1);
    expect(specs[0].epic).toBeUndefined(); // sanity: spec carries no epic
  });
});

describe("tradeMarkerSpecs — off-window cull", () => {
  it("skips markers whose anchor time is older than the oldest loaded bar", () => {
    const specs = tradeMarkerSpecs({
      ...base,
      oldestLoadedMs: 2_500,
      trades: [position()], // openedAt 2_000 < 2_500 → culled
      journal: [journal()], // ts 3_000 >= 2_500 → kept
    });
    expect(specs.map((s) => s.key)).toEqual([`exit:${journalKey(journal())}`]);
  });

  it("draws nothing when no bars are loaded (oldestLoadedMs null)", () => {
    const specs = tradeMarkerSpecs({
      ...base,
      oldestLoadedMs: null,
      trades: [position()],
      journal: [journal()],
    });
    expect(specs).toHaveLength(0);
  });

  it("keeps a marker exactly at the oldest loaded bound (inclusive)", () => {
    const specs = tradeMarkerSpecs({
      ...base,
      oldestLoadedMs: 2_000,
      trades: [position()],
      journal: [],
    });
    expect(specs).toHaveLength(1);
  });
});

describe("aggregateExitsByBar — coarse-timeframe bucketing", () => {
  // Two 1D bars; the journal ts are in seconds.
  const bars = [
    { timestamp: 1_000_000, high: 71 },
    { timestamp: 2_000_000, high: 72 },
  ];

  it("buckets each exit into the bar CONTAINING its close time (net + count)", () => {
    const clusters = aggregateExitsByBar(
      [
        journal({ ts: 1_500, pnl: 5 }), // 1_500_000 ms → bar 0
        journal({ ts: 1_800, pnl: -2, exit: 70.5 }), // → bar 0
        journal({ ts: 2_100, pnl: 3 }), // 2_100_000 ms → bar 1
      ],
      "OIL",
      bars,
    );
    expect(clusters).toHaveLength(2);
    expect(clusters[0]).toMatchObject({ barTs: 1_000_000, high: 71, net: 3 });
    expect(clusters[0].exits).toHaveLength(2);
    expect(clusters[1]).toMatchObject({ barTs: 2_000_000, net: 3 });
    expect(clusters[1].exits).toHaveLength(1);
  });

  it("filters to the cell's epic and culls exits older than the first bar", () => {
    const clusters = aggregateExitsByBar(
      [
        journal({ ts: 500, pnl: 9 }), // 500_000 ms < first bar → culled
        journal({ ts: 1_500, epic: "GOLD", pnl: 9 }), // wrong epic
        journal({ ts: 1_500, pnl: 4 }), // kept
      ],
      "OIL",
      bars,
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0].exits).toHaveLength(1);
    expect(clusters[0].net).toBe(4);
  });

  it("returns nothing with no loaded bars", () => {
    expect(aggregateExitsByBar([journal()], "OIL", [])).toEqual([]);
  });
});

describe("exitsCollide — native vs aggregate gate", () => {
  const bars = [{ timestamp: 1_000_000, high: 71 }];

  it("is false when every bar holds at most one exit (native arrows)", () => {
    const clusters = aggregateExitsByBar([journal({ ts: 1_500 })], "OIL", bars);
    expect(exitsCollide(clusters)).toBe(false);
  });

  it("is true once a bar packs ≥2 exits (aggregate pills)", () => {
    const clusters = aggregateExitsByBar(
      [journal({ ts: 1_500 }), journal({ ts: 1_800, exit: 70.9 })],
      "OIL",
      bars,
    );
    expect(exitsCollide(clusters)).toBe(true);
  });
});
