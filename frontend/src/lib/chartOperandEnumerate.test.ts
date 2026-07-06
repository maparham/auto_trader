import { describe, it, expect, vi } from "vitest";

// enumerateChartOperands -> chartOperand -> LINE_KEYS -> customIndicators reads
// klinecharts value exports (LineType.Solid) at module load; stub them so the
// import chain resolves under jsdom (mirrors chartOperand.test.ts / backtestSeries.test.ts).
vi.mock("klinecharts", () => ({
  LineType: { Solid: "solid", Dashed: "dashed" },
  IndicatorSeries: { Normal: "normal", Price: "price" },
  registerIndicator: () => {},
}));

import { enumerateChartOperands } from "./chartOperandEnumerate";

// Minimal duck-typed controller: only the fields enumerateChartOperands reads.
function fakeController(indicators: Array<[string, string, { calcParams?: number[]; extendData?: unknown }]>, drawings: Array<{ id: string; name: string; points: unknown[]; text?: string; color?: string }>) {
  const paneMap = new Map<string, Map<string, unknown>>();
  const inds = new Map<string, unknown>();
  for (const [name, indType, ind] of indicators) inds.set(name, { name, extendData: { indType }, ...ind });
  paneMap.set("pane_1", inds);
  return {
    chart: {
      getIndicatorByPaneId: () => paneMap,
      getDataList: () => [{ timestamp: 0, open: 1, high: 1, low: 1, close: 1, volume: 0 }],
    },
    overlays: { listDrawings: () => drawings },
  } as unknown as import("./chartController").ChartController;
}

describe("enumerateChartOperands", () => {
  it("returns [] for a null controller", () => {
    expect(enumerateChartOperands(null)).toEqual([]);
  });

  it("lists supported indicators (with outputs) and drawings, greys unsupported", () => {
    const c = fakeController(
      [
        ["EMA#1", "EMA", { calcParams: [200], extendData: { indType: "EMA" } }],
        ["MACD#1", "MACD", { calcParams: [12, 26, 9], extendData: { indType: "MACD" } }],
      ],
      [{ id: "d1", name: "segment", points: [{ timestamp: 0, value: 1 }, { timestamp: 60000, value: 2 }], text: "resistance", color: "#abc123" }],
    );
    const sources = enumerateChartOperands(c);
    const ema = sources.find((s) => s.id === "EMA#1")!;
    expect(ema.baseLabel).toBe("EMA(200)");
    expect(ema.outputs).toHaveLength(1);
    // Indicator emphasis carries pane + instance name (for controller.curveHover).
    expect(ema.emphasis).toEqual({ kind: "indicator", paneId: "pane_1", name: "EMA#1" });
    const macd = sources.find((s) => s.id === "MACD#1")!;
    expect(macd.disabled).toBe(true);
    expect(macd.emphasis).toEqual({ kind: "indicator", paneId: "pane_1", name: "MACD#1" }); // greyed rows still emphasize
    const d1 = sources.find((s) => s.id === "d1")!;
    expect(d1.baseLabel).toBe("Trendline 'resistance'");
    expect(d1.color).toBe("#abc123");
    expect(d1.emphasis).toEqual({ kind: "drawing", id: "d1" });
  });
});
