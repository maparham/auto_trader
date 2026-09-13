// @vitest-environment node
// Publish-time remap of a captured demo layout onto the yfinance catalogue:
// cell symbols inside layout bodies, epic-bearing scope keys (drawings/avwap),
// and the hand-typed watchlist. See demoRemap.ts.
import { describe, expect, it } from "vitest";
import type { Instrument } from "./feed";
import { mapEpicToYfinance, remapDemoLayout, remapWatchlist } from "./demoRemap";

const CATALOGUE = new Map<string, Instrument>(
  (
    [
      { epic: "US100", name: "Nasdaq 100", status: null, pricePrecision: 1 },
      { epic: "XAUUSD", name: "Gold (COMEX)", status: null, pricePrecision: 3 },
      { epic: "AAPL", name: "Apple", status: null, pricePrecision: 2 },
    ] as Instrument[]
  ).map((i) => [i.epic, i]),
);

describe("mapEpicToYfinance", () => {
  it("maps identically-named epics and the metal aliases", () => {
    expect(mapEpicToYfinance("US100", CATALOGUE)?.epic).toBe("US100");
    expect(mapEpicToYfinance("GOLD", CATALOGUE)?.epic).toBe("XAUUSD");
    expect(mapEpicToYfinance("NATURALGAS", CATALOGUE)).toBeNull();
  });
});

describe("remapDemoLayout", () => {
  const body = (cells: object[]) => JSON.stringify({ tabs: [{ cells }] });

  it("replaces cell symbols with the catalogue row and re-keys drawings/avwap", () => {
    const { layout, unmapped } = remapDemoLayout(
      {
        layouts: '[{"id":"a","name":"Demo"}]',
        "layout.a": body([
          { id: "c0", scope: "tab.T1", symbol: { epic: "GOLD", name: "Gold", pricePrecision: 2 } },
        ]),
        "scope:tab.T1.drawings.GOLD": '[{"t":"line"}]',
        "scope:tab.T1.avwap.GOLD.17": "123",
        "scope:tab.T1.avwap.GOLD": "456", // legacy single-anchor key
        "scope:tab.T1.indicators": '["EMA"]', // no epic: untouched
      },
      CATALOGUE,
    );

    expect(unmapped).toEqual([]);
    const cell = JSON.parse(layout["layout.a"]).tabs[0].cells[0];
    expect(cell.symbol).toEqual({
      epic: "XAUUSD",
      name: "Gold (COMEX)",
      status: null,
      pricePrecision: 3,
    });
    expect(layout["scope:tab.T1.drawings.XAUUSD"]).toBe('[{"t":"line"}]');
    expect(layout["scope:tab.T1.avwap.XAUUSD.17"]).toBe("123");
    expect(layout["scope:tab.T1.avwap.XAUUSD"]).toBe("456");
    expect(layout["scope:tab.T1.indicators"]).toBe('["EMA"]');
    expect(layout["scope:tab.T1.drawings.GOLD"]).toBeUndefined();
  });

  it("reports unmappable CELL symbols but silently drops stale scope keys", () => {
    const { layout, unmapped } = remapDemoLayout(
      {
        "layout.a": body([{ id: "c0", scope: "tab.T1", symbol: { epic: "NATURALGAS" } }]),
        // A drawing for an epic no cell shows any more must not block publish.
        "scope:tab.T1.drawings.SOMETHING_OLD": "[]",
      },
      CATALOGUE,
    );
    expect(unmapped).toEqual(["NATURALGAS"]);
    expect(layout["scope:tab.T1.drawings.SOMETHING_OLD"]).toBeUndefined();
  });

  it("copies malformed bodies and non-layout keys through untouched", () => {
    const { layout } = remapDemoLayout(
      { "layout.a": "not json", defaultLayoutId: '"a"' },
      CATALOGUE,
    );
    expect(layout["layout.a"]).toBe("not json");
    expect(layout["defaultLayoutId"]).toBe('"a"');
  });
});

describe("remapWatchlist", () => {
  it("maps, dedupes, and reports the misses", () => {
    expect(remapWatchlist(["GOLD", "XAUUSD", "US100", "NOPE"], CATALOGUE)).toEqual({
      epics: ["XAUUSD", "US100"],
      unmapped: ["NOPE"],
    });
  });
});
