import { describe, it, expect, vi } from "vitest";
vi.mock("klinecharts", () => ({
  registerIndicator: () => {}, registerOverlay: () => {}, registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));
vi.mock("../lib/indicatorAlertInstance", async (orig) => ({
  ...(await orig<typeof import("../lib/indicatorAlertInstance")>()),
  isAlertableType: (type: string) => type === "RSI" || type === "MA",
}));
import type { Chart } from "klinecharts";
import { buildIndicatorAlertDraft } from "./indicatorAlertDraft";

// getIndicator (lib/indicators.ts) calls chart.getIndicators({ paneId, name }).
function chartWith(ind: Record<string, unknown> | null): Chart {
  return {
    getIndicators: () => (ind ? [ind] : []),
  } as unknown as Chart;
}
const args = (chart: Chart) => ({
  chart, paneId: "pane_rsi", name: "RSI", scope: "tab.t1.cell.c2", epic: "US100",
  broker: "b", precision: 2, resolution: "HOUR", quoteOnly: false,
});

describe("buildIndicatorAlertDraft", () => {
  it("builds a draft with the stripped instance and the cell link", () => {
    const ind = { name: "RSI", calcParams: [14], extendData: {} };
    const r = buildIndicatorAlertDraft(args(chartWith(ind)));
    expect(r && "draft" in r && r.draft).toMatchObject({
      chartTimeframe: "HOUR",
      link: { scope: "tab.t1.cell.c2", instanceId: "RSI" },
      instance: { type: "RSI", calcParams: [14], extendData: {} },
    });
  });

  it("a pinned MA's draft takes the pin's timeframe", () => {
    const ind = { name: "MA", calcParams: [55], extendData: { mtf: { timeframe: "1D" } } };
    const r = buildIndicatorAlertDraft({ ...args(chartWith(ind)), name: "MA", paneId: "candle_pane", resolution: "HOUR_4" });
    expect(r && "draft" in r && r.draft).toMatchObject({
      chartTimeframe: "DAY",
      instance: { type: "MA", calcParams: [55], extendData: { mtf: { timeframe: "1D" } } },
    });
  });

  it("hides the entry for a type not in the alertable set", () => {
    const ind = { name: "OBV", calcParams: [], extendData: {} };
    expect(buildIndicatorAlertDraft({ ...args(chartWith(ind)), name: "OBV" })).toBeNull();
  });

  it("hides the entry for an unknown indicator", () => {
    expect(buildIndicatorAlertDraft(args(chartWith(null)))).toBeNull();
  });

  it("hides the entry on a seconds chart", () => {
    const ind = { name: "RSI", calcParams: [14], extendData: {} };
    const r = buildIndicatorAlertDraft({ ...args(chartWith(ind)), resolution: "SECOND_5" });
    expect(r).toBeNull();
  });

  it("carries quoteOnly through", () => {
    const ind = { name: "RSI", calcParams: [14], extendData: {} };
    const r = buildIndicatorAlertDraft({ ...args(chartWith(ind)), quoteOnly: true });
    expect(r && "draft" in r && r.draft).toMatchObject({ quoteOnly: true });
  });
});
