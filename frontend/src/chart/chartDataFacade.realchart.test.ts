// @vitest-environment jsdom
//
// The facade against a REAL klinecharts v10 instance: after a scroll-back page
// lands, getBars() (what the bar cache saves when a chart leaves a series)
// must hold that page AND every live bar pushed after it. klinecharts' forward
// merge builds a new array, so a facade that kept the array setBars handed
// over would save a copy frozen at the first drag.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { init, dispose, type Chart, type KLineData } from "klinecharts";
import { createChartDataFacade, type ChartDataFacade } from "./chartDataFacade";

function stubCanvas(): void {
  const ctx = new Proxy({ measureText: () => ({ width: 10 }) } as Record<string, unknown>, {
    get: (t, p) => (p in t ? t[p as string] : () => {}),
    set: (t, p, v) => {
      t[p as string] = v;
      return true;
    },
  });
  HTMLCanvasElement.prototype.getContext = (() => ctx) as unknown as HTMLCanvasElement["getContext"];
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  for (const [k, v] of [["clientWidth", 800], ["clientHeight", 600], ["offsetWidth", 800], ["offsetHeight", 600]] as const)
    Object.defineProperty(HTMLElement.prototype, k, { configurable: true, value: v });
}

const BAR_MS = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 5);
const bar = (i: number): KLineData => ({
  timestamp: T0 + i * BAR_MS,
  open: 100 + i,
  high: 101 + i,
  low: 99 + i,
  close: 100.5 + i,
  volume: 1,
});
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, k) => bar(from + k));

describe("chartDataFacade on a real chart", () => {
  let container: HTMLDivElement;
  let chart: Chart;
  let facade: ChartDataFacade;

  beforeAll(stubCanvas);
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    chart = init(container)!;
    facade = createChartDataFacade();
    facade.attach(chart);
    facade.setSymbol("US100", 2, 0);
    facade.setPeriod({ span: 1, type: "hour" });
    facade.setBars(range(0, 50), true);
  });
  afterEach(() => {
    dispose(container);
    container.remove();
  });

  it("getBars holds the scroll-back page and later live bars", () => {
    // One page, then the start of history (the store may ask again on its own).
    let pages = 0;
    facade.onLoadRequest = (_type, _ts, done) => (pages++ === 0 ? done(range(-20, 0), false) : done([], false));
    // What a drag to the left edge triggers inside the store.
    (chart as unknown as { _chartStore: { _processDataLoad(t: string): void } })._chartStore._processDataLoad(
      "forward",
    );
    expect(chart.getDataList()).toHaveLength(70);

    facade.pushBar(bar(50)); // a new live candle after the drag
    const saved = facade.getBars();
    expect(saved).toHaveLength(71);
    expect(saved[0].timestamp).toBe(bar(-20).timestamp);
    expect(saved[saved.length - 1].timestamp).toBe(bar(50).timestamp);

    // A re-init (timeframe declared again, precision change) re-serves the
    // full list instead of cutting the dragged history off.
    facade.setPeriod({ span: 2, type: "hour" });
    expect(chart.getDataList()).toHaveLength(71);
  });
});
