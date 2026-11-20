// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRENDLINES_DEFAULTS } from "../lib/indicators/trendlinesOutputs";

const apply = vi.fn((..._a: unknown[]) => Promise.resolve());
vi.mock("../lib/mtfCoordinator", () => ({ applyTrendlinesTimeframe: (...a: unknown[]) => apply(...a) }));
const saved: Record<string, { calcParams?: number[]; extendData?: Record<string, unknown> }> = {};
vi.mock("../lib/persist", () => ({
  loadIndicatorConfigs: () => saved,
  saveIndicatorConfig: (_s: string, name: string, cfg: never) => { saved[name] = cfg; },
}));

import { trendlineMenuItems } from "./trendlineLegendMenu";
import { setChartLogSource, syncLogFollow } from "./trendlineLogFollow";

function setup(extendData: Record<string, unknown> = {}, calcParams = Object.values(TRENDLINES_DEFAULTS)) {
  const live = { name: "TL", paneId: "candle_pane", calcParams, extendData: { indType: "TRENDLINES", ...extendData } };
  const overrides: Array<{ extendData?: Record<string, unknown> }> = [];
  const chart = {
    getIndicators: () => [live],
    overrideIndicator: (o: { extendData?: Record<string, unknown> }) => {
      overrides.push(o);
      if (o.extendData) live.extendData = { ...live.extendData, ...o.extendData };
    },
  } as never;
  const ctx = { chart, scope: "s", epic: "E", brokerId: "b", paneId: "candle_pane", name: "TL" };
  return { ctx, overrides, live, chart };
}
const labels = (items: { label: string }[]) => items.map((i) => i.label);

describe("trendlineMenuItems", () => {
  beforeEach(() => {
    for (const k of Object.keys(saved)) delete saved[k];
    apply.mockClear();
  });

  it("offers Log Scale, Follow and Debug mode, unchecked by default, and no layers", () => {
    const items = trendlineMenuItems(setup().ctx);
    expect(labels(items)).toEqual(["Log Scale", "Follow Chart's L", "Debug mode"]);
    expect(items.map((i) => i.checked)).toEqual([false, false, false]);
    expect(items[0].disabled).toBe(false);
  });

  it("Follow takes the chart's L state at once and greys out Log Scale", () => {
    saved.TL = { calcParams: Object.values(TRENDLINES_DEFAULTS) };
    const { ctx, chart } = setup();
    setChartLogSource(chart, () => true);
    trendlineMenuItems(ctx)[1].onClick();
    expect(saved.TL.extendData).toEqual({ logFollow: true });
    expect(saved.TL.calcParams?.[33]).toBe(1);
    const again = trendlineMenuItems(ctx);
    expect(again[1].checked).toBe(true);
    expect(again[0].disabled).toBe(true);
  });

  it("Log Scale writes slot 33 through the settings path", () => {
    saved.TL = { calcParams: Object.values(TRENDLINES_DEFAULTS) };
    trendlineMenuItems(setup().ctx)[0].onClick();
    expect(saved.TL.calcParams?.[33]).toBe(1);
    expect(apply).toHaveBeenCalledTimes(1);
    expect((apply.mock.calls[0][4] as { logScale: number }).logScale).toBe(1);
  });

  it("shows Log Scale checked when on, and turns it off", () => {
    const on = Object.values({ ...TRENDLINES_DEFAULTS, logScale: 1 });
    saved.TL = { calcParams: on };
    const items = trendlineMenuItems(setup({}, on).ctx);
    expect(items[0].checked).toBe(true);
    items[0].onClick();
    expect(saved.TL.calcParams?.[33]).toBe(0);
  });

  it("Debug mode toggles the live flag only, never the saved config", () => {
    const { ctx, overrides } = setup({ color: "#f00" });
    trendlineMenuItems(ctx)[2].onClick();
    expect(overrides.at(-1)?.extendData).toEqual({ indType: "TRENDLINES", color: "#f00", debug: true });
    expect(saved.TL).toBeUndefined();
  });

  it("while debug is on, lists the layers with their defaults and saves a toggle", () => {
    const { ctx, overrides } = setup({ debug: true, debugShowOutranked: false });
    const items = trendlineMenuItems(ctx);
    expect(labels(items).slice(3)).toEqual([
      "Failed a filter", "Outranked by a nearer line", "Built from your line's points", "Drawn", "Show strength rank",
    ]);
    expect(items.slice(3).map((i) => i.checked)).toEqual([true, false, true, true, false]);
    items[4].onClick();
    expect(saved.TL.extendData).toEqual({ debugShowOutranked: true });
    expect(overrides.at(-1)?.extendData).toEqual({ debugShowOutranked: true });
  });
});

describe("syncLogFollow", () => {
  beforeEach(() => {
    for (const k of Object.keys(saved)) delete saved[k];
    apply.mockClear();
  });

  it("moves only following panes, and only when they differ", () => {
    const base = { scope: "s", epic: "E", brokerId: "b" };
    saved.TL = { calcParams: Object.values(TRENDLINES_DEFAULTS) };
    const follow = setup({ logFollow: true });
    setChartLogSource(follow.chart, () => true);
    syncLogFollow(follow.chart, base);
    expect(saved.TL.calcParams?.[33]).toBe(1);
    expect(apply).toHaveBeenCalledTimes(1);

    apply.mockClear();
    const fixed = setup({});
    setChartLogSource(fixed.chart, () => true);
    syncLogFollow(fixed.chart, base);
    expect(apply).not.toHaveBeenCalled();

    const inLine = setup({ logFollow: true }, Object.values({ ...TRENDLINES_DEFAULTS, logScale: 1 }));
    setChartLogSource(inLine.chart, () => true);
    syncLogFollow(inLine.chart, base);
    expect(apply).not.toHaveBeenCalled();
  });
});
