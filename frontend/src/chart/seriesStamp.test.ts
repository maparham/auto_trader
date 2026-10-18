import { describe, expect, it } from "vitest";
import type { Chart } from "klinecharts";
import { chartPaints, stampChartSeries } from "./seriesStamp";

describe("chartPaints", () => {
  const chart = {} as Chart;

  it("is false until a run paints and stamps the chart", () => {
    stampChartSeries(chart, null);
    expect(chartPaints(chart, "TSLA", "HOUR_4")).toBe(false);
  });

  it("is false while the previous timeframe's bars are still painted", () => {
    stampChartSeries(chart, { epic: "TSLA", resolution: "DAY", live: true });
    expect(chartPaints(chart, "TSLA", "HOUR_4")).toBe(false);
  });

  it("is true once the asked series is painted", () => {
    stampChartSeries(chart, { epic: "TSLA", resolution: "HOUR_4", live: true });
    expect(chartPaints(chart, "TSLA", "HOUR_4")).toBe(true);
    expect(chartPaints(chart, "AAPL", "HOUR_4")).toBe(false);
  });
});
