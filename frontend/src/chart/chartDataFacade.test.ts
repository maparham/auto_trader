import { describe, it, expect, vi } from "vitest";
import { createChartDataFacade, periodFromTf } from "./chartDataFacade";

function fakeChart() {
  let loader: any = null;
  return {
    setDataLoader: vi.fn((l) => { loader = l; }),
    setSymbol: vi.fn(),
    setPeriod: vi.fn(),
    resetData: vi.fn(),
    _loader: () => loader,
  } as any;
}

describe("chartDataFacade", () => {
  it("serves stored bars to getBars(init) and forwards more-flags", () => {
    const f = createChartDataFacade();
    const chart = fakeChart();
    f.attach(chart);
    const bars = [{ timestamp: 1, open: 1, high: 1, low: 1, close: 1 }];
    const cb = vi.fn();
    f.setBars(bars, { backward: true, forward: false });
    expect(chart.resetData).toHaveBeenCalled(); // setBars asks the chart to re-pull
    // the chart re-pull arrives as getBars(init); the facade must serve the stored bars
    chart._loader().getBars({ type: "init", timestamp: null, symbol: {} as any, period: {} as any, callback: cb });
    expect(cb).toHaveBeenCalledWith(bars, { backward: true, forward: false });
  });

  it("routes edge loads to onLoadRequest", () => {
    const f = createChartDataFacade();
    const chart = fakeChart();
    f.attach(chart);
    f.onLoadRequest = vi.fn((_type, _ts, done) => done([], false));
    const cb = vi.fn();
    chart._loader().getBars({ type: "backward", timestamp: 123, symbol: {} as any, period: {} as any, callback: cb });
    expect(f.onLoadRequest).toHaveBeenCalledWith("backward", 123, expect.any(Function));
    expect(cb).toHaveBeenCalledWith([], false);
  });

  it("pushBar forwards to the captured subscribeBar callback", () => {
    const f = createChartDataFacade();
    const chart = fakeChart();
    f.attach(chart);
    const sub = vi.fn();
    chart._loader().subscribeBar({ symbol: {} as any, period: {} as any, callback: sub });
    const bar = { timestamp: 2, open: 1, high: 1, low: 1, close: 1 };
    f.pushBar(bar);
    expect(sub).toHaveBeenCalledWith(bar);
  });

  it("pushBar before subscribeBar does not throw and is dropped", () => {
    const f = createChartDataFacade();
    f.attach(fakeChart());
    expect(() => f.pushBar({ timestamp: 3, open: 1, high: 1, low: 1, close: 1 })).not.toThrow();
  });

  it("dedupes value-equal setSymbol calls (v10 guards by reference, so a repeat would re-fire init)", () => {
    const f = createChartDataFacade();
    const chart = fakeChart();
    f.attach(chart);
    f.setSymbol("US100", 2, 0);
    f.setSymbol("US100", 2, 0);
    expect(chart.setSymbol).toHaveBeenCalledTimes(1);
    // A changed precision on the same ticker MUST call through (precision resolve).
    f.setSymbol("US100", 5, 0);
    expect(chart.setSymbol).toHaveBeenCalledTimes(2);
    // And a changed ticker too.
    f.setSymbol("EURUSD", 5, 0);
    expect(chart.setSymbol).toHaveBeenCalledTimes(3);
  });

  it("dedupes value-equal setPeriod calls", () => {
    const f = createChartDataFacade();
    const chart = fakeChart();
    f.attach(chart);
    f.setPeriod({ span: 5, type: "minute" });
    f.setPeriod({ span: 5, type: "minute" });
    expect(chart.setPeriod).toHaveBeenCalledTimes(1);
    f.setPeriod({ span: 15, type: "minute" });
    expect(chart.setPeriod).toHaveBeenCalledTimes(2);
  });

  it("maps timeframe strings to periods", () => {
    expect(periodFromTf("5m")).toEqual({ span: 5, type: "minute" });
    expect(periodFromTf("4H")).toEqual({ span: 4, type: "hour" });
    expect(periodFromTf("1D")).toEqual({ span: 1, type: "day" });
    expect(periodFromTf("2W")).toEqual({ span: 2, type: "week" });
    expect(periodFromTf("1M")).toEqual({ span: 1, type: "month" });
    expect(periodFromTf("1Y")).toEqual({ span: 1, type: "year" });
  });
});
