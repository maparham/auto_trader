// @vitest-environment jsdom
// "Add alert" on an indicator, at the hook level: the menu item, the legend
// check, and the gates that hide both (snapshot view, demo, synthetic chart).
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { installMemStorage } from "../lib/testMemStorage";
import type { ChartHandle } from "./chartHandle";

vi.mock("klinecharts", () => ({
  registerIndicator: () => {}, registerOverlay: () => {}, registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));
const gates = vi.hoisted(() => ({ demo: false, synthetic: false }));
vi.mock("../lib/demoMode", () => ({ isDemoMode: () => gates.demo, setDemoMode: () => {} }));
vi.mock("../lib/syntheticRegistry", async (orig) => ({
  ...(await orig<typeof import("../lib/syntheticRegistry")>()),
  isSynthetic: () => gates.synthetic,
}));

installMemStorage();

const { useIndicatorCommands } = await import("./useIndicatorCommands");
const { indicatorAlertRequest } = await import("../lib/signals");

const ema = (ext: Record<string, unknown> = {}) => ({
  name: "EMA", paneId: "candle_pane", calcParams: [20], visible: true,
  extendData: { indType: "EMA", ...ext }, result: [{ ma: 101.5 }],
});

function commands(ind: ReturnType<typeof ema>, snapView = false) {
  const chart = {
    getIndicators: (f?: { paneId?: string; name?: string }) =>
      f ? [ind].filter((i) => i.paneId === f.paneId && i.name === f.name) : [ind],
    getDataList: () => [{ volume: 5 }],
  };
  const handle = {
    chartRef: { current: chart },
    epicRef: { current: "US100" },
    overlays: {},
    controller: {
      selectedIndicator: { value: null, set: () => {}, subscribe: () => () => {} },
      indicatorRemoved: { value: null, set: () => {}, subscribe: () => () => {} },
      indicators: { value: [], set: () => {}, subscribe: () => () => {} },
      indicatorsHidden: { value: false, set: () => {}, subscribe: () => () => {} },
      subPanesHidden: { value: false, set: () => {}, subscribe: () => () => {} },
    },
  } as unknown as ChartHandle;
  return renderHook(() =>
    useIndicatorCommands(handle, {
      cellId: "c1", scope: "tab.t1.cell.c1", period: { resolution: "HOUR" },
      snapViewRef: { current: snapView }, wrapRef: { current: null },
      setPaneDropTop: () => {}, setIndMenu: () => {},
      alertContext: { current: { epic: "US100", broker: "capital", precision: 2, quoteOnly: false } },
    }),
  ).result.current;
}

const alertItem = (c: ReturnType<typeof commands>) =>
  c.indicatorMenuItems("candle_pane", "EMA").find((i) => i.label === "Add alert");

afterEach(() => {
  gates.demo = false;
  gates.synthetic = false;
  indicatorAlertRequest.set(null);
});

describe("indicator Add alert", () => {
  it("menu item opens a create draft for an alertable indicator", () => {
    const item = alertItem(commands(ema()));
    expect(item?.disabled).toBeFalsy();
    item!.onClick();
    expect(indicatorAlertRequest.value).toMatchObject({
      mode: "create",
      draft: { epic: "US100", lastValue: 101.5, link: { scope: "tab.t1.cell.c1", instanceId: "EMA" } },
    });
  });

  it("menu item is disabled with the reason for a non-alertable config", () => {
    const item = alertItem(commands(ema({ offset: 2 })));
    expect(item).toMatchObject({ disabled: true, disabledReason: "Alerts need the line offset at 0" });
  });

  it("legend check mirrors the menu item", () => {
    expect(commands(ema()).legendAlertCheck("EMA")).toEqual({ reason: null });
    expect(commands(ema({ offset: 2 })).legendAlertCheck("EMA")).toEqual({
      reason: "Alerts need the line offset at 0",
    });
  });

  it("is hidden in the read-only snapshot view", () => {
    const c = commands(ema(), true);
    expect(alertItem(c)).toBeUndefined();
    expect(c.legendAlertCheck("EMA")).toBeNull();
  });

  it("is hidden in demo mode", () => {
    gates.demo = true;
    const c = commands(ema());
    expect(alertItem(c)).toBeUndefined();
    expect(c.legendAlertCheck("EMA")).toBeNull();
    c.onLegendAddAlert("EMA");
    expect(indicatorAlertRequest.value).toBeNull();
  });

  it("is hidden on a synthetic chart", () => {
    gates.synthetic = true;
    const c = commands(ema());
    expect(alertItem(c)).toBeUndefined();
    expect(c.legendAlertCheck("EMA")).toBeNull();
  });
});
