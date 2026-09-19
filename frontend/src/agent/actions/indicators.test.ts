// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { installMemStorage } from "../../lib/testMemStorage";

installMemStorage();

import { clearRegistryForTest, listActions, invokeAction } from "../registry";
import { setFocusedChartProvider } from "./chart";
import { registerIndicatorActions } from "./indicators";
import * as ind from "../../lib/indicators";
import * as mtf from "../../lib/mtfCoordinator";
import { loadIndicators, loadIndicatorConfigs, saveIndicatorConfig } from "../../lib/persist/artifacts";

const ctx = { progress: () => {}, signal: new AbortController().signal };

function makeController() {
  let value: Array<{ id: string; type: string }> = [];
  return {
    chart: { overrideIndicator: vi.fn() },
    scope: "t1.c1",
    indicatorsHidden: { value: false },
    indicators: { get value() { return value; }, set: (v: typeof value) => { value = v; } },
  };
}

function provide(controller = makeController()) {
  setFocusedChartProvider(() => ({
    chart: controller.chart as never, controller: controller as never,
    scope: "t1.c1", epic: "US100", cellId: "c1", resolution: "HOUR", broker: "capital",
    setPeriod: () => {},
  }));
  return controller;
}

describe("indicator actions", () => {
  beforeEach(() => {
    clearRegistryForTest();
    registerIndicatorActions();
    localStorage.clear();
  });

  it("registers the four indicator actions", () => {
    expect(listActions().map((a) => a.name).sort()).toEqual([
      "indicator.add", "indicator.list", "indicator.remove", "indicator.set",
    ]);
  });

  it("add mints an instance, persists it, and updates the controller", async () => {
    const controller = provide();
    vi.spyOn(ind, "addIndicatorInstance").mockReturnValue({ id: "RSI#x1", type: "RSI" });
    const res = (await invokeAction("indicator.add", { type: "RSI", calcParams: [14] }, ctx)) as { id: string };
    expect(res.id).toBe("RSI#x1");
    expect(controller.indicators.value).toEqual([{ id: "RSI#x1", type: "RSI" }]);
    expect(loadIndicators("t1.c1")).toEqual([{ id: "RSI#x1", type: "RSI" }]);
  });

  it("add with inset:true routes through to the persisted instance", async () => {
    provide();
    vi.spyOn(ind, "addIndicatorInstance").mockImplementation(
      (_chart, _scope, _epic, type, opts) =>
        ({ id: `${type}#x1`, type, ...(opts?.inset ? { inset: true } : {}) }) as never,
    );
    const res = (await invokeAction("indicator.add", { type: "RSI", inset: true }, ctx)) as { id: string };
    expect(res.id).toBe("RSI#x1");
    expect(loadIndicators("t1.c1")).toEqual([{ id: "RSI#x1", type: "RSI", inset: true }]);
    expect(ind.addIndicatorInstance).toHaveBeenCalledWith(
      expect.anything(), "t1.c1", "US100", "RSI",
      expect.objectContaining({ inset: true }),
    );
  });

  it("add rejects unknown types with the valid list", async () => {
    provide();
    await expect(invokeAction("indicator.add", { type: "WOMBAT" }, ctx)).rejects.toThrow(/RSI/);
  });

  it("remove drops the instance everywhere", async () => {
    const controller = provide();
    controller.indicators.set([{ id: "RSI#x1", type: "RSI" }]);
    vi.spyOn(ind, "removeIndicatorById").mockImplementation(() => {});
    await invokeAction("indicator.remove", { id: "RSI#x1" }, ctx);
    expect(controller.indicators.value).toEqual([]);
  });

  it("remove of an unknown id is NOT_FOUND", async () => {
    provide();
    await expect(invokeAction("indicator.remove", { id: "nope" }, ctx)).rejects.toThrow(/no indicator/);
  });

  describe("set", () => {
    function liveInstance(controller: ReturnType<typeof makeController>, id: string, type: string, extendData: object = {}) {
      controller.indicators.set([{ id, type }]);
      vi.spyOn(ind, "getIndicatorsByPane").mockReturnValue(new Map([["candle_pane", new Set([id])]]) as never);
      vi.spyOn(ind, "getIndicator").mockReturnValue({ calcParams: [3, 0], extendData } as never);
    }

    it("merges an extendData patch onto the live instance and persists it", async () => {
      const controller = provide();
      liveInstance(controller, "TRENDLINES", "TRENDLINES", { showPivots: true });
      saveIndicatorConfig("t1.c1", "TRENDLINES", { calcParams: [3, 0], extendData: { showPivots: true } });
      await invokeAction("indicator.set", { id: "TRENDLINES", extendData: { showCrossings: false } }, ctx);
      expect(controller.chart.overrideIndicator).toHaveBeenCalledWith({
        paneId: "candle_pane", name: "TRENDLINES",
        extendData: { showPivots: true, showCrossings: false },
      });
      expect(loadIndicatorConfigs("t1.c1").TRENDLINES).toEqual({
        calcParams: [3, 0], extendData: { showPivots: true, showCrossings: false },
      });
    });

    it("pins Trendlines through the MTF coordinator and records the pin like the modal", async () => {
      const controller = provide();
      liveInstance(controller, "TRENDLINES", "TRENDLINES");
      const apply = vi.spyOn(mtf, "applyTrendlinesTimeframe").mockResolvedValue(undefined);
      await invokeAction("indicator.set", { id: "TRENDLINES", timeframe: "1D" }, ctx);
      expect(apply).toHaveBeenCalledWith(
        controller.chart, "US100", "TRENDLINES", "candle_pane", expect.any(Object), "DAY", "capital",
      );
      expect(loadIndicatorConfigs("t1.c1").TRENDLINES?.extendData).toEqual({ mtf: { timeframe: "DAY" } });
      // "chart" unpins and drops the record.
      await invokeAction("indicator.set", { id: "TRENDLINES", timeframe: "chart" }, ctx);
      expect(apply).toHaveBeenLastCalledWith(
        controller.chart, "US100", "TRENDLINES", "candle_pane", expect.any(Object), null, "capital",
      );
      expect(loadIndicatorConfigs("t1.c1").TRENDLINES?.extendData).toBeUndefined();
    });

    it("refuses a pin on a non-Trendlines instance, an unknown timeframe, and an empty patch", async () => {
      const controller = provide();
      liveInstance(controller, "RSI#x1", "RSI");
      await expect(invokeAction("indicator.set", { id: "RSI#x1", timeframe: "1D" }, ctx)).rejects.toThrow(/only TRENDLINES/);
      await expect(invokeAction("indicator.set", { id: "RSI#x1", timeframe: "7Q" }, ctx)).rejects.toThrow(/unknown timeframe/);
      await expect(invokeAction("indicator.set", { id: "RSI#x1" }, ctx)).rejects.toThrow(/nothing to set/);
    });

    it("still patches calcParams alone", async () => {
      const controller = provide();
      liveInstance(controller, "RSI#x1", "RSI");
      await invokeAction("indicator.set", { id: "RSI#x1", calcParams: [21] }, ctx);
      expect(controller.chart.overrideIndicator).toHaveBeenCalledWith({ paneId: "candle_pane", name: "RSI#x1", calcParams: [21] });
      expect(loadIndicatorConfigs("t1.c1")["RSI#x1"]?.calcParams).toEqual([21]);
    });
  });
});
