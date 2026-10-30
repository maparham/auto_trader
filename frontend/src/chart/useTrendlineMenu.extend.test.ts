// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { Chart } from "klinecharts";
import { overrideExtend } from "../lib/overrideExtend";
import { pickTrendline, toggleTrendlineExtension } from "./useTrendlineMenu";

vi.mock("../lib/overrideExtend", () => ({ overrideExtend: vi.fn() }));

// The live extendData the draw would see, rebuilt from the writes.
function liveChart() {
  const ext = new Map<string, Record<string, unknown>>();
  vi.mocked(overrideExtend).mockImplementation((_c, paneId, name, patch) => {
    const k = `${paneId}:${name}`;
    ext.set(k, { ...ext.get(k), ...patch });
  });
  const chart = { getIndicators: () => [] } as unknown as Chart;
  const extended = (name = "TL") =>
    (ext.get(`candle_pane:${name}`)?.extendedLines as string[] | null | undefined) ?? null;
  return { chart, extended };
}

const a = { paneId: "candle_pane", name: "TL", key: "a" };
const b = { paneId: "candle_pane", name: "TL", key: "b" };
const c = { paneId: "candle_pane", name: "TL2", key: "c" };

// A double click as the browser fires it: two clicks that pick, then dblclick.
function doubleClick(chart: Chart, line: typeof a) {
  pickTrendline(chart, line);
  pickTrendline(chart, line);
  toggleTrendlineExtension(chart, line);
}

describe("toggleTrendlineExtension", () => {
  it("extends on a double click and takes it away on the next", () => {
    const { chart, extended } = liveChart();
    doubleClick(chart, a);
    expect(extended()).toEqual(["a"]);
    doubleClick(chart, a);
    expect(extended()).toBeNull();
  });

  it("a double click on another line keeps the first extended", () => {
    const { chart, extended } = liveChart();
    doubleClick(chart, a);
    doubleClick(chart, b);
    expect(extended()).toEqual(["a", "b"]);
    doubleClick(chart, c);
    expect(extended()).toEqual(["a", "b"]);
    expect(extended("TL2")).toEqual(["c"]);
    // Taking one away leaves the rest.
    doubleClick(chart, a);
    expect(extended()).toEqual(["b"]);
    expect(extended("TL2")).toEqual(["c"]);
  });

  it("a click on any line keeps them, a click away clears them all", () => {
    const { chart, extended } = liveChart();
    doubleClick(chart, a);
    pickTrendline(chart, b);
    pickTrendline(chart, c);
    expect(extended()).toEqual(["a"]);
    doubleClick(chart, c);
    pickTrendline(chart, null);
    expect(extended()).toBeNull();
    expect(extended("TL2")).toBeNull();
  });
});
