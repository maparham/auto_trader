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

  it("editor list: copy first, chart adds missing ids, pinned panes dropped", () => {
    const chart = [
      { id: "RSI", outputs: ["value"], timeframe: null },
      { id: "ATR", outputs: ["14"], timeframe: null },
      { id: "SLOPE", outputs: ["5"], timeframe: "1H" },
    ];
    const ids = editorInstances({ RSI: rsi(14) }, chart).map((i) => i.id);
    expect(ids).toEqual(["RSI", "ATR"]);
  });

  it("copyAsLive and labels", () => {
    expect(copyAsLive({ RSI: rsi(14) })).toEqual([live("RSI", 14)]);
    expect(paneLabels({ RSI: rsi(14) })[0]).toMatch(/^RSI/);
  });

  it("label includes the pane's detail when it has one, after the id and params", () => {
    const label = paneLabels({ RSI: rsi(14) })[0];
    expect(label.startsWith("RSI (14), ")).toBe(true);
    expect(label).toContain("pivots");
  });

  it("label falls back to just id and params for a type exprInstancesFor does not recognize", () => {
    const out = paneLabels({ MYSTERY: { type: "MYSTERY", calcParams: [3], extendData: {} } });
    expect(out).toEqual(["MYSTERY (3)"]);
  });
});
