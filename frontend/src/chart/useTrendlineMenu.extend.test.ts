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
  return { chart, extended: () => ext.get("candle_pane:TL")?.extendedLine ?? null };
}

const a = { paneId: "candle_pane", name: "TL", key: "a" };
const b = { paneId: "candle_pane", name: "TL", key: "b" };

describe("toggleTrendlineExtension", () => {
  it("extends on a double click and takes it away on the next", () => {
    const { chart, extended } = liveChart();
    toggleTrendlineExtension(chart, a);
    expect(extended()).toBe("a");
    toggleTrendlineExtension(chart, a);
    expect(extended()).toBeNull();
  });

  it("survives the clicks on the same line, clears on a click away or another line", () => {
    const { chart, extended } = liveChart();
    toggleTrendlineExtension(chart, a);
    pickTrendline(chart, a);
    expect(extended()).toBe("a");
    pickTrendline(chart, b);
    expect(extended()).toBeNull();
    toggleTrendlineExtension(chart, b);
    pickTrendline(chart, null);
    expect(extended()).toBeNull();
  });
});
