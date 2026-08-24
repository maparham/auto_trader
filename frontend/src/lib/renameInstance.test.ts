import { describe, it, expect, vi } from "vitest";
import type { Chart } from "klinecharts";
import type { ChartController } from "./chartController";

vi.mock("klinecharts", () => ({
  registerIndicator: vi.fn(),
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));

const { renameInstanceEverywhere } = await import("./renameInstance");
const { Signal } = await import("./signals");
const persist = await import("./persist");
const { defaultBacktestConfig } = await import("./backtestConfig");

class MemStorage {
  private m = new Map<string, string>();
  get length(): number {
    return this.m.size;
  }
  key(i: number): string | null {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v);
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  clear(): void {
    this.m.clear();
  }
}
(globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage();

function statefulChart(
  initial: Array<{ name: string; type: string; calcParams?: number[]; extendData?: Record<string, unknown> }>,
) {
  let seq = 0;
  type FakeInd = {
    paneId: string;
    name: string;
    calcParams?: number[];
    extendData?: Record<string, unknown>;
    visible?: boolean;
  };
  const inds: FakeInd[] = initial.map((i) => ({
    paneId: `pane_${++seq}`,
    name: i.name,
    calcParams: i.calcParams,
    extendData: { ...i.extendData, indType: i.type },
  }));
  const chart = {
    getIndicators: (q?: { paneId?: string; name?: string }) =>
      inds.filter((i) => (!q?.paneId || i.paneId === q.paneId) && (!q?.name || i.name === q.name)),
    createIndicator: (value: FakeInd & { paneId?: string }) => {
      const paneId = value.paneId ?? `pane_${++seq}`;
      inds.push({ paneId, name: value.name, calcParams: value.calcParams, extendData: value.extendData });
      return paneId;
    },
    removeIndicator: (filter: { paneId?: string; name?: string }) => {
      const i = inds.findIndex((x) => (!filter.paneId || x.paneId === filter.paneId) && x.name === filter.name);
      if (i > -1) inds.splice(i, 1);
    },
    overrideIndicator: () => {},
    setPaneOptions: () => {},
    overrideYAxis: () => {},
    getSize: () => ({ height: 150 }),
  } as unknown as Chart;
  return chart;
}

function fakeController(chart: Chart, scope: string, indicators: Array<{ id: string; type: string }>) {
  return {
    chart,
    scope,
    indicators: new Signal(indicators),
  } as unknown as ChartController;
}

describe("renameInstanceEverywhere", () => {
  it("renames the chart pane, the controller's instance list, and matching rule refs", () => {
    localStorage.clear();
    const chart = statefulChart([
      { name: "PIVOT_ANALYSIS", type: "PIVOT_ANALYSIS", calcParams: [34, 34, 0, 0] },
    ]);
    const controller = fakeController(chart, "tab.everywhere", [{ id: "PIVOT_ANALYSIS", type: "PIVOT_ANALYSIS" }]);
    persist.saveBacktestLastUsed({
      ...defaultBacktestConfig(),
      longEntry: {
        combine: "AND",
        rules: [{ expr: "PIVOT_ANALYSIS.pivotHigh > 0", enabled: true }],
      },
    });

    const result = renameInstanceEverywhere(controller, "US100", "PIVOT_ANALYSIS", "MyPivots");
    expect(result.ok).toBe(true);

    expect(controller.indicators.value).toEqual([{ id: "MyPivots", type: "PIVOT_ANALYSIS" }]);
    expect(persist.loadIndicators("tab.everywhere")).toEqual([{ id: "MyPivots", type: "PIVOT_ANALYSIS" }]);
    expect(persist.loadBacktestLastUsed()!.longEntry.rules[0].expr).toBe("MyPivots.pivotHigh > 0");
  });

  it("propagates a validation error without touching any state", () => {
    localStorage.clear();
    const chart = statefulChart([
      { name: "PIVOT_ANALYSIS", type: "PIVOT_ANALYSIS", calcParams: [34, 34, 0, 0] },
      { name: "FVG2", type: "FVG", calcParams: [0.25, 500, 10] },
    ]);
    const controller = fakeController(chart, "tab.everywhere2", [
      { id: "PIVOT_ANALYSIS", type: "PIVOT_ANALYSIS" },
      { id: "FVG2", type: "FVG" },
    ]);
    const result = renameInstanceEverywhere(controller, "US100", "PIVOT_ANALYSIS", "FVG2");
    expect(result).toEqual({ ok: false, error: "taken" });
    expect(controller.indicators.value).toEqual([
      { id: "PIVOT_ANALYSIS", type: "PIVOT_ANALYSIS" },
      { id: "FVG2", type: "FVG" },
    ]);
  });
});
