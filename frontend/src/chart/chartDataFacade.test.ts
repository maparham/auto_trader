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
  it("serves stored bars to getBars(init) and translates canLoadOlder to v10 more-flags", () => {
    const f = createChartDataFacade();
    const chart = fakeChart();
    f.attach(chart);
    const bars = [{ timestamp: 1, open: 1, high: 1, low: 1, close: 1 }];
    const cb = vi.fn();
    f.setBars(bars, true);
    expect(chart.resetData).toHaveBeenCalled(); // setBars asks the chart to re-pull
    // The chart re-pull arrives as getBars(init); the facade must serve the stored
    // bars and map canLoadOlder onto v10's inverted flag naming (more.forward arms
    // LEFT-edge/older loads; backward stays off, newer bars arrive via pushBar).
    chart._loader().getBars({ type: "init", timestamp: null, symbol: {} as any, period: {} as any, callback: cb });
    expect(cb).toHaveBeenCalledWith(bars, { forward: true, backward: false });
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

  // v10's Forward merge concats the prepend and renumbers every dataIndex without
  // shifting overlay points (v9's updatePointPosition is gone) — the facade must
  // fire onForwardPrepend BEFORE delivering forward bars so dataIndex-anchored
  // points shift before the prepend lands.
  it("fires onForwardPrepend with the page size before delivering forward bars", () => {
    const f = createChartDataFacade();
    const chart = fakeChart();
    f.attach(chart);
    const page = [
      { timestamp: 1, open: 1, high: 1, low: 1, close: 1 },
      { timestamp: 2, open: 1, high: 1, low: 1, close: 1 },
    ];
    f.onLoadRequest = (_type, _ts, done) => done(page, true);
    const order: string[] = [];
    f.onForwardPrepend = (count) => order.push(`shift:${count}`);
    const cb = vi.fn(() => order.push("deliver"));
    chart._loader().getBars({ type: "forward", timestamp: 5, symbol: {} as any, period: {} as any, callback: cb });
    expect(order).toEqual(["shift:2", "deliver"]);
    expect(cb).toHaveBeenCalledWith(page, true);
  });

  it("skips onForwardPrepend for empty pages and backward loads", () => {
    const f = createChartDataFacade();
    const chart = fakeChart();
    f.attach(chart);
    const hook = vi.fn();
    f.onForwardPrepend = hook;
    f.onLoadRequest = (_type, _ts, done) => done([], false);
    chart._loader().getBars({ type: "forward", timestamp: 5, symbol: {} as any, period: {} as any, callback: vi.fn() });
    const bar = [{ timestamp: 9, open: 1, high: 1, low: 1, close: 1 }];
    f.onLoadRequest = (_type, _ts, done) => done(bar, false);
    chart._loader().getBars({ type: "backward", timestamp: 5, symbol: {} as any, period: {} as any, callback: vi.fn() });
    expect(hook).not.toHaveBeenCalled();
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
