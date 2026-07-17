import { describe, expect, it } from "vitest";
import type { ChartTab } from "./persist";
import { matchingCellIds, matchingTabIds } from "./tabSearch";

function cell(id: string, epic: string, name: string) {
  return {
    id,
    symbol: { epic, name, status: null },
    period: { label: "15m" } as ChartTab["cells"][number]["period"],
    scope: id,
  };
}

function tab(id: string, cells: ReturnType<typeof cell>[]): ChartTab {
  return { id, layout: "4", cells, activeCellId: cells[0].id };
}

const tabs: ChartTab[] = [
  tab("t1", [cell("c1", "EURUSD", "Euro / US Dollar")]),
  tab("t2", [
    cell("c2", "EURUSD", "Euro / US Dollar"),
    cell("c3", "GBPUSD", "Pound / US Dollar"),
    cell("c4", "GOLD", "Gold Spot"),
  ]),
  tab("t3", [cell("c5", "US500", "S&P 500")]),
];

describe("matchingCellIds", () => {
  it("matches epic substring case-insensitively", () => {
    expect(matchingCellIds(tabs[1], "eur")).toEqual(["c2"]);
  });

  it("matches display name too", () => {
    expect(matchingCellIds(tabs[1], "pound")).toEqual(["c3"]);
  });

  it("returns every matching cell in the tab", () => {
    expect(matchingCellIds(tabs[1], "usd")).toEqual(["c2", "c3"]);
  });

  it("empty and whitespace queries match nothing", () => {
    expect(matchingCellIds(tabs[1], "")).toEqual([]);
    expect(matchingCellIds(tabs[1], "   ")).toEqual([]);
  });

  it("no match returns empty", () => {
    expect(matchingCellIds(tabs[2], "gold")).toEqual([]);
  });
});

describe("matchingTabIds", () => {
  it("returns ids of tabs with at least one matching cell", () => {
    expect(matchingTabIds(tabs, "eurusd")).toEqual(new Set(["t1", "t2"]));
  });

  it("empty query matches no tabs", () => {
    expect(matchingTabIds(tabs, "")).toEqual(new Set());
  });
});
