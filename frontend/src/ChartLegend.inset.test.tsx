// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";

vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));

const { buildLegendRows, buildInsetLegend } = await import("./ChartLegend");

describe("legend rows for an inset instance", () => {
  const chart = {
    getIndicators: () => [
      {
        name: "RSI",
        paneId: "candle_pane",
        shortName: "RSI",
        calcParams: [14],
        precision: 8,
        figures: [],
        visible: true,
        // Deliberately a color in NO palette: RSI's base template default is
        // #7E57C2, so asserting that would pass just as well if the legend
        // resolved the color off the base template instead of this instance.
        styles: { lines: [{ color: "#0BF1CE" }] },
        extendData: { indType: "RSI", inset: true },
        result: [],
      },
    ],
    getStyles: () => ({
      indicator: { lines: [{ color: "#888" }], tooltip: { legend: { color: "#ccc" } } },
    }),
    getDataList: () => [],
    // 400px main area starting 30px down: the band takes its bottom 112px, so the
    // card sits at 318 — the same geometry drawInset paints to.
    getSize: () => ({ left: 0, top: 30, width: 600, height: 400 }),
  } as unknown as import("klinecharts").Chart;

  it("keeps the row OUT of the candle-pane legend, which is not where it draws", () => {
    // An inset instance lives on candle_pane, but on screen it is its own band. Its
    // row belongs to the band's card, exactly as a sub-pane's rows are not in this
    // strip — otherwise the same indicator would be listed twice.
    expect(buildLegendRows(chart).rows).toEqual([]);
  });

  it("shows the base template's figure row rather than an empty one", () => {
    const { data } = buildInsetLegend(chart);
    expect(data!.rows).toHaveLength(1);
    expect(data!.rows[0].figures.map((f) => f.title)).toEqual(["RSI: "]);
  });

  it("colors the row from the instance's own line override", () => {
    const { data } = buildInsetLegend(chart);
    expect(data!.rows[0].figures[0].color).toBe("#0BF1CE");
  });

  it("positions the card at the band's top edge, in chart-root pixels", () => {
    expect(buildInsetLegend(chart).data!.top).toBe(318);
  });

  it("changes its signature when the band moves, so a drag repositions the card", () => {
    const first = buildInsetLegend(chart).sig;
    const taller = {
      ...chart,
      getSize: () => ({ left: 0, top: 30, width: 600, height: 800 }),
    } as unknown as import("klinecharts").Chart;
    expect(buildInsetLegend(taller).sig).not.toBe(first);
  });

  it("has no card when nothing is inset", () => {
    const plain = {
      ...chart,
      getIndicators: () => [
        { ...(chart.getIndicators() as unknown[])[0] as object, extendData: { indType: "RSI" } },
      ],
    } as unknown as import("klinecharts").Chart;
    expect(buildInsetLegend(plain).data).toBeNull();
  });
});
