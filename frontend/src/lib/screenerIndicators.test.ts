import { describe, expect, it } from "vitest";
import { copyAsLive, editorInstances, paneLabels, refreshFromChart, screenPayload } from "./screenerIndicators";

const rsi = (len: number) => ({ type: "RSI", calcParams: [len], extendData: {} });
const live = (id: string, len: number) => ({ id, ...rsi(len) });

describe("screenerIndicators", () => {
  it("copy wins over a chart pane with the same id", () => {
    const out = screenPayload({ RSI: rsi(14) }, [live("RSI", 7)], ["RSI.bullDiv"]);
    expect(out.RSI.calcParams).toEqual([14]);
  });

  it("chart supplies ids the copy lacks", () => {
    const out = screenPayload({}, [live("RSI", 7)], ["RSI.value < 30"]);
    expect(out.RSI.calcParams).toEqual([7]);
  });

  it("keeps only referenced panes", () => {
    const out = screenPayload({ RSI: rsi(14), RSI1: rsi(9) }, [live("RSI2", 5)], ["RSI.value < 30", "1"]);
    expect(Object.keys(out)).toEqual(["RSI"]);
  });

  it("nothing referenced gives an empty map", () => {
    expect(screenPayload({ RSI: rsi(14) }, [live("RSI", 7)], ["candle.close > 0"])).toEqual({});
  });

  it("refresh replaces only ids the chart also has", () => {
    const out = refreshFromChart({ RSI: rsi(14), RSI1: rsi(9) }, [live("RSI", 7)]);
    expect(out.RSI.calcParams).toEqual([7]);
    expect(out.RSI1.calcParams).toEqual([9]);
  });

  it("editor list: copy first, chart adds missing ids, finer pins dropped, coarser kept", () => {
    const chart = [
      { id: "RSI", outputs: ["value"], timeframe: null },
      { id: "ATR", outputs: ["14"], timeframe: null },
      { id: "SLOPE", outputs: ["5"], timeframe: "1H" },
      { id: "FVG", outputs: ["bull_top"], timeframe: "W" },
      { id: "LR", outputs: ["line"], timeframe: "nonsense" },
    ];
    const ids = editorInstances({ RSI: rsi(14) }, chart, "DAY").map((i) => i.id);
    expect(ids).toEqual(["RSI", "ATR", "FVG"]);
    expect(editorInstances({}, chart, "HOUR").map((i) => i.id)).toEqual(["RSI", "ATR", "SLOPE", "FVG"]);
  });

  it("editor list drops chart-only panes (Trendlines)", () => {
    const chart = [{ id: "TRENDLINES", outputs: ["tl_nearest"], timeframe: null, chartOnly: true }];
    expect(editorInstances({ TRENDLINES: { type: "TRENDLINES", calcParams: [], extendData: {} } }, chart, "DAY")).toEqual([]);
  });

  it("label shows a pane's pin", () => {
    const fvg = { type: "FVG", calcParams: [0.25, 500, 10], extendData: { mtf: { timeframe: "W" } } };
    expect(paneLabels({ FVG: fvg })[0]).toMatch(/^FVG @W · /);
  });

  it("copyAsLive and labels", () => {
    expect(copyAsLive({ RSI: rsi(14) })).toEqual([live("RSI", 14)]);
    expect(paneLabels({ RSI: rsi(14) })[0]).toMatch(/^RSI/);
  });

  it("label is the id plus the pane's detail, with no restated params", () => {
    expect(paneLabels({ RSI: rsi(14) })[0]).toBe("RSI · length 14 · pivots 5/5 · divergence off");
    const on = { ...rsi(14), extendData: { divergence: { on: true, lookbackLeft: 3, lookbackRight: 2 } } };
    expect(paneLabels({ RSI2: on })[0]).toBe("RSI2 · length 14 · pivots 3/2 · divergence on");
  });

  it("label falls back to just id and params for a type exprInstancesFor does not recognize", () => {
    const out = paneLabels({ MYSTERY: { type: "MYSTERY", calcParams: [3], extendData: {} } });
    expect(out).toEqual(["MYSTERY (3)"]);
  });
});
