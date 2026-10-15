import { describe, it, expect, vi } from "vitest";
vi.mock("klinecharts", () => ({
  registerIndicator: () => {}, registerOverlay: () => {}, registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));
import type { Chart } from "klinecharts";
import { buildIndicatorAlertDraft } from "./indicatorAlertDraft";

// getIndicator (lib/indicators.ts) calls chart.getIndicators({ paneId, name });
// the draft also reads getDataList() for the volume check.
function chartWith(ind: Record<string, unknown> | null, volumes = [10, 10]): Chart {
  return {
    getIndicators: () => (ind ? [ind] : []),
    getDataList: () => volumes.map((v) => ({ volume: v })),
  } as unknown as Chart;
}
const args = (chart: Chart) => ({
  chart, paneId: "pane_rsi", name: "RSI", scope: "tab.t1.cell.c2", epic: "US100",
  broker: "b", precision: 2, resolution: "HOUR", quoteOnly: false,
});

describe("buildIndicatorAlertDraft", () => {
  it("builds a draft with the last value and the cell link", () => {
    const ind = { name: "RSI", calcParams: [14], extendData: {}, result: [{ val: 40 }, { val: 61.25 }] };
    const r = buildIndicatorAlertDraft(args(chartWith(ind)));
    expect(r && "draft" in r && r.draft).toMatchObject({
      lastValue: 61.25, timeframe: "HOUR", link: { scope: "tab.t1.cell.c2", instanceId: "RSI" },
      identity: { indicator: "RSI", calcParams: [14] },
    });
  });
  it("a pinned MA's draft takes the pin's timeframe", () => {
    const ind = { name: "EMA", calcParams: [55], extendData: { mtf: { timeframe: "1D" } }, result: [{ ema: 63.1 }] };
    const r = buildIndicatorAlertDraft({ ...args(chartWith(ind)), name: "EMA", paneId: "candle_pane", resolution: "HOUR_4" });
    expect(r && "draft" in r && r.draft).toMatchObject({ timeframe: "DAY", identity: { indicator: "MA", calcParams: [55] } });
  });
  it("returns the reason for a non-alertable config", () => {
    const ind = { name: "EMA", calcParams: [50], extendData: { offset: 3 }, result: [] };
    const r = buildIndicatorAlertDraft({ ...args(chartWith(ind)), name: "EMA", paneId: "candle_pane" });
    expect(r && "reason" in r && r.reason).toContain("offset");
  });
  it("skips trailing undefined values and carries quoteOnly", () => {
    const ind = { name: "RSI", calcParams: [14], extendData: {}, result: [{ val: 55 }, {}] };
    const r = buildIndicatorAlertDraft({ ...args(chartWith(ind)), quoteOnly: true });
    expect(r && "draft" in r && r.draft).toMatchObject({ lastValue: 55, quoteOnly: true });
  });
  it("hides the entry for an unknown indicator or a non-alertable type", () => {
    expect(buildIndicatorAlertDraft(args(chartWith(null)))).toBeNull();
    const ind = { name: "OBV", calcParams: [], extendData: {}, result: [] };
    expect(buildIndicatorAlertDraft({ ...args(chartWith(ind)), name: "OBV" })).toBeNull();
  });
});
