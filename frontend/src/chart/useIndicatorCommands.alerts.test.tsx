// @vitest-environment jsdom
// "Add alert" on an indicator, at the hook level: the menu item and the gates
// that hide it (not an alertable type, snapshot view, demo, synthetic chart).
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { installMemStorage } from "../lib/testMemStorage";
import type { ChartHandle } from "./chartHandle";

vi.mock("klinecharts", () => ({
  registerIndicator: () => {}, registerOverlay: () => {}, registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));
const gates = vi.hoisted(() => ({ demo: false, synthetic: false, alertable: true }));
vi.mock("../lib/indicatorAlertInstance", async (orig) => ({
  ...(await orig<typeof import("../lib/indicatorAlertInstance")>()),
  isAlertableType: () => gates.alertable,
}));
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
  gates.alertable = true;
  indicatorAlertRequest.set(null);
});

describe("indicator Add alert", () => {
  it("menu item opens a create draft for an alertable indicator", () => {
    const item = alertItem(commands(ema()));
    expect(item?.disabled).toBeFalsy();
    item!.onClick();
    expect(indicatorAlertRequest.value).toMatchObject({
      mode: "create",
      draft: {
        epic: "US100", instance: { type: "EMA", calcParams: [20] },
        link: { scope: "tab.t1.cell.c1", instanceId: "EMA" },
      },
    });
  });

  it("is hidden for a type the server does not list", () => {
    gates.alertable = false;
    expect(alertItem(commands(ema()))).toBeUndefined();
  });

  it("is hidden in the read-only snapshot view", () => {
    expect(alertItem(commands(ema(), true))).toBeUndefined();
  });

  it("is hidden in demo mode", () => {
    gates.demo = true;
    expect(alertItem(commands(ema()))).toBeUndefined();
  });

  it("is hidden on a synthetic chart", () => {
    gates.synthetic = true;
    expect(alertItem(commands(ema()))).toBeUndefined();
  });
});
