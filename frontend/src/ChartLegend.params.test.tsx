// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";

vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));

const { buildLegendRows } = await import("./ChartLegend");

function chartWith(inds: unknown[]) {
  return {
    getIndicators: () => inds,
    getStyles: () => ({
      indicator: { lines: [{ color: "#888" }], tooltip: { legend: { color: "#ccc" } } },
    }),
    getDataList: () => [],
    getSize: () => ({ left: 0, top: 0, width: 600, height: 400 }),
  } as unknown as import("klinecharts").Chart;
}

// A figure-less pane (TRENDLINES declares `figures: []` and paints its own
// canvas) and one with a readout, so the two halves of the rule are both
// exercised on the same toggle.
const trendlines = (hide: boolean) => ({
  name: "TRENDLINES",
  paneId: "candle_pane",
  shortName: "Trendlines",
  calcParams: [7, 0.25, 1, 2, 20, 250, 30, 20, 1, 0, 20, 0, 0, 0, 0, 44],
  figures: [],
  visible: true,
  styles: { lines: [] },
  extendData: { indType: "TRENDLINES", ...(hide ? { hideLegendValue: true } : {}) },
  result: [],
});
const ema = (hide: boolean) => ({
  name: "EMA",
  paneId: "candle_pane",
  shortName: "EMA",
  calcParams: [50],
  figures: [{ key: "ema", title: "EMA: ", type: "line" }],
  visible: true,
  styles: { lines: [{ color: "#fff" }] },
  extendData: { indType: "EMA", ...(hide ? { hideLegendValue: true } : {}) },
  result: [{ ema: 433.36 }],
});

const rowFor = (ind: unknown) => buildLegendRows(chartWith([ind])).rows[0];

describe("show value in legend, on a pane with nothing to show", () => {
  it("keeps the params while the toggle is on", () => {
    expect(rowFor(trendlines(false)).calcParamsText).toBe(
      "(7,0.25,1,2,20,250,30,20,1,0,20,0,0,0,0,44)",
    );
  });

  // THE BUG: the toggle gates the figure READOUTS, and a pane with no figures
  // has none, so unticking it did nothing at all and read as broken. Sixteen
  // params is what the legend carries there instead.
  it("hides the params when the toggle is off and there are no figures", () => {
    const row = rowFor(trendlines(true));
    expect(row.calcParamsText).toBe("");
    expect(row.figures).toHaveLength(0);
    // The name stays: the row still has to be clickable and identifiable.
    expect(row.shortName).toBe("Trendlines");
  });

  it("keeps the params on a pane that DOES have a readout to hide", () => {
    // "EMA(50)" is the setting and the number beside it is the value. Hiding
    // the setting is not what the toggle asks for.
    expect(rowFor(ema(true)).calcParamsText).toBe("(50)");
    expect(rowFor(ema(false)).calcParamsText).toBe("(50)");
  });
});
