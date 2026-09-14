// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { installMemStorage } from "../../lib/testMemStorage";

installMemStorage();

import { clearRegistryForTest, listActions, invokeAction } from "../registry";
import { registerChartActions, setFocusedChartProvider } from "./chart";

const ctx = { progress: () => {}, signal: new AbortController().signal };

function fakeBars(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    timestamp: 1700000000000 + i * 3600_000,
    open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: 1000 + i,
  }));
}

// Minimal klinecharts double: only what chart.state touches.
function fakeChart(bars = fakeBars(20), opts: { visFrom?: number; visTo?: number; indicators?: unknown[] } = {}) {
  const { visFrom = 5, visTo = 20, indicators = [] } = opts;
  return {
    getDataList: () => bars,
    getVisibleRange: () => ({ from: visFrom, to: visTo, realFrom: visFrom, realTo: visTo }),
    getBarSpace: () => ({ bar: 8 }),
    // getIndicatorsByPane (lib/indicators.ts) rebuilds Map<paneId, Map<name,
    // Indicator>> from this flat array, so the fake must satisfy the real
    // helper's shape (paneId, name, result), not a pre-built map.
    getIndicators: () => indicators,
  };
}

function fakeController(chart: unknown, indicatorInstances = [{ id: "RSI#a1", type: "RSI" }]) {
  return {
    chart,
    scope: "t1.c1",
    indicators: { value: indicatorInstances },
    indicatorsHidden: { value: false },
    overlays: { listDrawings: (): unknown[] => [] },
  };
}

function provide(chart = fakeChart(), controller = fakeController(chart)) {
  setFocusedChartProvider(() => ({
    chart: chart as never,
    controller: controller as never,
    scope: "t1.c1",
    epic: "US100",
    cellId: "c1",
    resolution: "HOUR",
    broker: "capital",
    setPeriod: () => {},
  }));
  return { chart, controller };
}

describe("chart.state", () => {
  beforeEach(() => {
    clearRegistryForTest();
    registerChartActions();
  });

  it("registers the chart actions", () => {
    expect(listActions().map((a) => a.name)).toContain("chart.state");
  });

  it("errors without a focused chart", async () => {
    setFocusedChartProvider(() => null);
    await expect(invokeAction("chart.state", {}, ctx)).rejects.toThrow(/no focused chart/);
  });

  it("returns epic, resolution, broker, visible range, drawings and visible candles", async () => {
    provide();
    const res = (await invokeAction("chart.state", {}, ctx)) as {
      epic: string; resolution: string; cellId: string; broker: string;
      visibleRange: { from: number; to: number; bars: number };
      candles: Array<{ timestamp: number; open: number; close: number }>;
      indicators: Array<{ id: string; type: string }>;
      indicatorValues: Record<string, unknown[]>;
      drawings: unknown[];
    };
    expect(res.epic).toBe("US100");
    expect(res.resolution).toBe("HOUR");
    expect(res.broker).toBe("capital");
    expect(res.candles).toHaveLength(15); // visible slice 5..20
    expect(res.visibleRange.bars).toBe(15);
    expect(res.candles[0].timestamp).toBe(1700000000000 + 5 * 3600_000);
    expect(res.indicators).toEqual([{ id: "RSI#a1", type: "RSI" }]);
    expect(res.indicatorValues).toEqual({});
    expect(res.drawings).toEqual([]);
  });

  it("caps candles at the bars argument", async () => {
    provide();
    const res = (await invokeAction("chart.state", { bars: 3 }, ctx)) as { candles: unknown[] };
    expect(res.candles).toHaveLength(3); // the LAST 3 visible bars
  });

  it("includes the focused chart's drawings via drawing.list's shape", async () => {
    const chart = fakeChart();
    const drawing = { id: "d1", name: "horizontalStraightLine", points: [{ value: 100 }] };
    const controller = fakeController(chart);
    controller.overlays = { listDrawings: () => [drawing] };
    provide(chart, controller);
    const res = (await invokeAction("chart.state", {}, ctx)) as { drawings: unknown[] };
    expect(res.drawings).toEqual([drawing]);
  });

  it("aligns indicatorValues to the VISIBLE (possibly scrolled) candles, not the live edge", async () => {
    // 20 bars total. indicator.result has one row per bar index (index N).
    // Scroll back so the visible window is bars 0..10 (NOT the live edge at 20).
    const bars = fakeBars(20);
    const result = bars.map((_, i) => ({ value: i })); // result[i] belongs to bars[i]
    const chart = fakeChart(bars, {
      visFrom: 0,
      visTo: 10,
      indicators: [{ paneId: "candle_pane", name: "RSI#a1", result }],
    });
    const controller = fakeController(chart);
    provide(chart, controller);
    const res = (await invokeAction("chart.state", { bars: 4 }, ctx)) as {
      candles: Array<{ timestamp: number }>;
      indicatorValues: Record<string, Array<{ value: number }>>;
    };
    // Last 4 of the visible window (bars 0..10) -> visible bars indices 6,7,8,9.
    expect(res.candles.map((c) => c.timestamp)).toEqual(
      bars.slice(6, 10).map((b) => b.timestamp),
    );
    // indicatorValues must be result rows for those SAME indices (6..9), not
    // the live edge (16..19, which slice(-4) on the full result would give).
    expect(res.indicatorValues["RSI#a1"]).toEqual([{ value: 6 }, { value: 7 }, { value: 8 }, { value: 9 }]);
  });
});

describe("chart.screenshot", () => {
  beforeEach(() => {
    clearRegistryForTest();
    registerChartActions();
  });

  it("returns base64 png from getConvertPictureUrl", async () => {
    const chart = Object.assign(fakeChart(), {
      getConvertPictureUrl: (_ov: boolean, type: string) =>
        `data:image/${type};base64,QUJD`,
    });
    provide(chart as never);
    const res = (await invokeAction("chart.screenshot", {}, ctx)) as {
      mime: string; image_base64: string; epic: string;
    };
    expect(res.mime).toBe("image/png");
    expect(res.image_base64).toBe("QUJD");
    expect(res.epic).toBe("US100");
  });

  it("falls back to jpeg when the png exceeds the size budget", async () => {
    const bigPng = "A".repeat(3_000_000);
    const chart = Object.assign(fakeChart(), {
      getConvertPictureUrl: (_ov: boolean, type: string) =>
        type === "png" ? `data:image/png;base64,${bigPng}` : "data:image/jpeg;base64,U01BTEw=",
    });
    provide(chart as never);
    const res = (await invokeAction("chart.screenshot", {}, ctx)) as { mime: string };
    expect(res.mime).toBe("image/jpeg");
  });

  it("errors when export fails", async () => {
    const chart = Object.assign(fakeChart(), {
      getConvertPictureUrl: () => { throw new Error("canvas gone"); },
    });
    provide(chart as never);
    await expect(invokeAction("chart.screenshot", {}, ctx)).rejects.toThrow(/screenshot failed/i);
  });

  it("errors instead of returning a blank PNG when the tab is backgrounded", async () => {
    const chart = Object.assign(fakeChart(), {
      getConvertPictureUrl: () => { throw new Error("should not be reached: hidden-tab guard should fire first"); },
    });
    provide(chart as never);
    // jsdom defines "hidden" as a getter on Document.prototype, not an own
    // property, so getOwnPropertyDescriptor(document, ...) finds nothing to
    // restore; deleting the own-property override we install here lets the
    // prototype getter (always false in jsdom) take back over.
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    try {
      await expect(invokeAction("chart.screenshot", {}, ctx)).rejects.toThrow(/backgrounded/i);
    } finally {
      delete (document as unknown as { hidden?: boolean }).hidden;
    }
  });
});

// jsdom has no real canvas backing (no "canvas" npm package here; see the
// same limitation documented in overlays.realchart.test.ts), so these tests
// cannot assert real rendered pixel/alpha values. They stub every 2D context
// with a call recorder instead, which is enough to prove the ORDER the
// destination-over fix depends on: every pane/separator putImageData must
// land before the single background fillRect, and that fillRect must run
// with globalCompositeOperation "destination-over" (not the default
// "source-over", which would let the fill overwrite pane pixels instead of
// only filling gaps). Real pixel/alpha proof lives in the live agent-bridge
// verification described in task-2-report.md, not in this suite.
describe("chart.screenshot: pane-composite path (compositeChartPng)", () => {
  const origGetContext = HTMLCanvasElement.prototype.getContext;
  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;

  beforeEach(() => {
    clearRegistryForTest();
    registerChartActions();
  });

  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = origGetContext;
    HTMLCanvasElement.prototype.toDataURL = origToDataURL;
  });

  it("writes every pane via putImageData, then fills the background with destination-over", async () => {
    const calls: string[] = [];
    let compositeOpAtFillRect: string | undefined;
    function makeRecorderCtx() {
      const rec: Record<string, unknown> = {
        canvas: null,
        fillStyle: "",
        globalCompositeOperation: "source-over",
        getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
        putImageData: () => { calls.push("putImageData"); },
        fillRect: () => {
          calls.push("fillRect");
          compositeOpAtFillRect = rec.globalCompositeOperation as string;
        },
      };
      return rec;
    }
    HTMLCanvasElement.prototype.getContext = (() => makeRecorderCtx()) as unknown as HTMLCanvasElement["getContext"];
    HTMLCanvasElement.prototype.toDataURL = (() => "data:image/png;base64,QUJD") as unknown as HTMLCanvasElement["toDataURL"];

    const stubPaneCanvas = () => {
      const c = document.createElement("canvas");
      c.width = 4; c.height = 4;
      return c;
    };
    const drawPane = { getBounding: () => ({ top: 0 }), getImage: () => stubPaneCanvas() };
    const separatorPane = { getBounding: () => ({ top: 4 }), getImage: () => stubPaneCanvas() };

    const chart = Object.assign(fakeChart(), {
      _chartBounding: { width: 10, height: 10 },
      _drawPanes: [drawPane],
      _separatorPanes: new Map([[drawPane, separatorPane]]),
      getConvertPictureUrl: () => {
        throw new Error("compositeChartPng should have handled this; getConvertPictureUrl fallback not expected");
      },
    });
    provide(chart as never);

    const res = (await invokeAction("chart.screenshot", {}, ctx)) as { mime: string; image_base64: string };
    expect(res.mime).toBe("image/png");
    expect(res.image_base64).toBe("QUJD");
    // one draw pane + one separator, both written before the single background fill
    expect(calls).toEqual(["putImageData", "putImageData", "fillRect"]);
    expect(compositeOpAtFillRect).toBe("destination-over");
  });

  it("falls back to getConvertPictureUrl when the private pane fields aren't present", async () => {
    // Same shape as the plain chart.screenshot tests above: no _chartBounding
    // / _drawPanes, so compositeChartPng bails out (returns null) and the
    // stock export path runs instead.
    const chart = Object.assign(fakeChart(), {
      getConvertPictureUrl: (_ov: boolean, type: string) => `data:image/${type};base64,RkFMTEJBQ0s=`,
    });
    provide(chart as never);
    const res = (await invokeAction("chart.screenshot", {}, ctx)) as { mime: string; image_base64: string };
    expect(res.mime).toBe("image/png");
    expect(res.image_base64).toBe("RkFMTEJBQ0s=");
  });
});

describe("chart view writes", () => {
  beforeEach(() => {
    clearRegistryForTest();
    registerChartActions();
  });

  it("timeframe.set resolves label or resolution and calls setPeriod", async () => {
    const calls: unknown[] = [];
    const chart = fakeChart();
    const controller = fakeController(chart);
    setFocusedChartProvider(() => ({
      chart: chart as never, controller: controller as never, scope: "t1.c1",
      epic: "US100", cellId: "c1", resolution: "HOUR", broker: "capital",
      setPeriod: (p) => calls.push(p),
    }));
    await invokeAction("chart.timeframe.set", { resolution: "4H" }, ctx);
    expect(calls).toEqual([{ resolution: "HOUR_4", label: "4H" }]);
    await expect(
      invokeAction("chart.timeframe.set", { resolution: "13m" }, ctx),
    ).rejects.toThrow(/unknown timeframe/);
  });

  it("range.set scrolls to the target and sets bar space for the window", async () => {
    const scrolled: number[] = [];
    let barSpace = 8;
    const chart = Object.assign(fakeChart(), {
      scrollToTimestamp: (ts: number) => scrolled.push(ts),
      setBarSpace: (px: number) => { barSpace = px; },
      getSize: () => ({ width: 800, height: 600 }),
    });
    provide(chart as never);
    const from = 1700000000000, to = from + 100 * 3600_000; // 100 hourly bars
    await invokeAction("chart.range.set", { from, to }, ctx);
    expect(scrolled).toEqual([to]);
    expect(barSpace).toBe(8); // 800px / 100 bars
  });

  it("range.set with only bars zooms in place but ends at the latest data", async () => {
    const scrolled: number[] = [];
    let barSpace = 8;
    const bars = fakeBars(20);
    const chart = Object.assign(fakeChart(bars), {
      scrollToTimestamp: (ts: number) => scrolled.push(ts),
      setBarSpace: (px: number) => { barSpace = px; },
      getSize: () => ({ width: 800, height: 600 }),
    });
    provide(chart as never);
    await invokeAction("chart.range.set", { bars: 50 }, ctx);
    expect(barSpace).toBe(16); // 800px / 50 bars
    expect(scrolled).toEqual([bars[bars.length - 1].timestamp]);
  });
});
