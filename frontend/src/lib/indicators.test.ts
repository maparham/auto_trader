import { describe, it, expect, vi } from "vitest";
import { defaultVisibility, isVisibleOnResolution } from "./visibility";
import type { Chart } from "klinecharts";

// customIndicators.ts (imported by indicators.ts) reads LineType/registerIndicator
// at module load (AVWAP line style table); stub klinecharts' runtime surface like
// overlays.test.ts / backtestSeries.test.ts do.
vi.mock("klinecharts", () => ({
  LineType: { Solid: "solid", Dashed: "dashed" },
  IndicatorSeries: { Normal: "normal", Price: "price" },
  registerIndicator: () => {},
  getSupportedIndicators: () => [],
  DomPosition: { Main: "main" },
}));

const { applyIndicatorVisibility, collapseSubPanes, expandSubPanes, INTERNAL_INDICATORS } =
  await import("./indicators");

// Reads as the sidebar eye-menu gesture it exercises (the double-click "hide sub-panes"
// gesture is height-collapse, not a visibility mask — it's manipulation of pane layout,
// covered by e2e/manual, not this unit).
const hideAll = (chart: Chart, hidden: boolean, resolution: string) =>
  applyIndicatorVisibility(chart, resolution, hidden);

describe("indicator interval visibility decision", () => {
  it("hides a minutes-only indicator on an hour timeframe", () => {
    const m = defaultVisibility();
    m.units.hours.on = false;
    m.units.days.on = false;
    m.units.weeks.on = false;
    expect(isVisibleOnResolution(m, "MINUTE_5")).toBe(true);
    expect(isVisibleOnResolution(m, "HOUR")).toBe(false);
  });
});

describe("setAllIndicatorsHidden (sidebar eye menu master switch)", () => {
  // A minimal fake chart exposing just what setAllIndicatorsHidden touches:
  // getIndicatorByPaneId() (no-arg, all-panes form) and overrideIndicator().
  function fakeChart(panes: Map<string, Map<string, { name: string; extendData?: unknown; visible?: boolean }>>) {
    const overrides: { name: string; visible: boolean; paneId: string; extendData?: unknown }[] = [];
    const chart = {
      getIndicatorByPaneId: () => panes,
      overrideIndicator: (opts: { name: string; visible?: boolean; extendData?: unknown }, paneId: string) => {
        overrides.push({
          name: opts.name,
          visible: !!opts.visible,
          paneId,
          ...(opts.extendData !== undefined ? { extendData: opts.extendData } : {}),
        });
      },
    } as unknown as Chart;
    return { chart, overrides };
  }

  it("hides every user indicator across panes but skips the internal EQUITY pane", () => {
    const [equityName] = INTERNAL_INDICATORS;
    const panes = new Map([
      ["candle_pane", new Map([["MA_1", { name: "MA_1" }]])],
      ["pane_1", new Map([["RSI_1", { name: "RSI_1" }], [equityName, { name: equityName }]])],
    ]);
    const { chart, overrides } = fakeChart(panes);
    hideAll(chart, true, "HOUR");
    // Never-toggled indicators get their intent seeded (userVisible) in the same
    // override that forces the flag off — see the round-trip test below.
    expect(overrides).toEqual([
      { name: "MA_1", visible: false, paneId: "candle_pane", extendData: { userVisible: true } },
      { name: "RSI_1", visible: false, paneId: "pane_1", extendData: { userVisible: true } },
    ]);
  });

  it("hide → unhide round-trips a never-toggled indicator (intent seeded before forcing the flag)", () => {
    // A virgin indicator has NO extendData.userVisible; un-hiding derives intent as
    // userVisible ?? visible, so without the seed its forced-false flag would read
    // back as intent and the indicator would stay hidden forever.
    const ind: { name: string; visible?: boolean; extendData?: unknown } = { name: "MA_1", visible: true };
    const panes = new Map([["candle_pane", new Map([["MA_1", ind]])]]);
    const { chart, overrides } = fakeChart(panes);

    hideAll(chart, true, "HOUR");
    // Mirror what a real chart does with the override: merge it into the live indicator.
    ind.visible = false;
    ind.extendData = overrides[0].extendData;

    hideAll(chart, false, "HOUR");
    expect(overrides[1]).toEqual({ name: "MA_1", visible: true, paneId: "candle_pane" });
  });

  it("does not overwrite an existing userVisible intent when hiding", () => {
    const panes = new Map([
      ["candle_pane", new Map([["MA_1", { name: "MA_1", visible: false, extendData: { userVisible: false } }]])],
    ]);
    const { chart, overrides } = fakeChart(panes);
    hideAll(chart, true, "HOUR");
    expect(overrides).toEqual([{ name: "MA_1", visible: false, paneId: "candle_pane" }]);
  });

  it("un-hiding re-derives visibility from intent + interval instead of blanket-showing", () => {
    const model = defaultVisibility();
    model.units.hours.on = false;
    const panes = new Map([
      [
        "candle_pane",
        new Map([
          ["MA_1", { name: "MA_1", extendData: { userVisible: true, visibility: model } }],
        ]),
      ],
    ]);
    const { chart, overrides } = fakeChart(panes);
    hideAll(chart, false, "HOUR");
    expect(overrides).toEqual([{ name: "MA_1", visible: false, paneId: "candle_pane" }]);
  });
});

describe("collapse / expand sub-panes (double-click hide bottom sub-panes)", () => {
  // Minimal fake exposing what collapse/expand touch: getIndicatorByPaneId() (to
  // enumerate reorderable sub-panes), getSize() (their heights), setPaneOptions().
  function fakeChart(heights: Record<string, number>, subPanes: string[]) {
    const opts: { id: string; height?: number; minHeight?: number; dragEnabled?: boolean }[] = [];
    const map = new Map<string, Map<string, { name: string }>>(
      subPanes.map((p) => [p, new Map([[`I_${p}`, { name: `I_${p}` }]])]),
    );
    map.set("candle_pane", new Map([["MA_1", { name: "MA_1" }]])); // never collapsed
    const chart = {
      getIndicatorByPaneId: () => map,
      getSize: (paneId: string) => ({ height: heights[paneId] ?? 0, top: 0 }),
      setPaneOptions: (o: (typeof opts)[number]) => opts.push(o),
    } as unknown as Chart;
    return { chart, opts };
  }

  it("captures real heights + forces each sub-pane to 1px; expand restores them (candle pane untouched)", () => {
    const { chart, opts } = fakeChart({ pane_1: 120, pane_2: 80 }, ["pane_1", "pane_2"]);
    const heights = collapseSubPanes(chart);
    expect(heights.get("pane_1")).toBe(120);
    expect(heights.get("pane_2")).toBe(80);
    expect(opts.map((o) => o.id).sort()).toEqual(["pane_1", "pane_2"]); // NOT candle_pane
    expect(opts.every((o) => o.height === 1 && o.minHeight === 0 && o.dragEnabled === false)).toBe(true);

    opts.length = 0;
    expandSubPanes(chart, heights);
    const byId = Object.fromEntries(opts.map((o) => [o.id, o]));
    expect(byId.pane_1.height).toBe(120);
    expect(byId.pane_2.height).toBe(80);
    expect(byId.pane_1.dragEnabled).toBe(true);
    expect(byId.pane_1.minHeight).toBe(30);
  });

  it("records the default height (not ~1px) when a pane is already collapsed, so a stray re-capture can't freeze it", () => {
    const { chart } = fakeChart({ pane_1: 1 }, ["pane_1"]);
    expect(collapseSubPanes(chart).get("pane_1")).toBe(120); // SUBPANE_HEIGHT fallback
  });

  it("expand falls back to the default height for a pane whose id isn't in the captured map", () => {
    const { chart, opts } = fakeChart({ pane_new: 999 }, ["pane_new"]);
    expandSubPanes(chart, new Map());
    expect(opts[0].height).toBe(120); // SUBPANE_HEIGHT, not the live 999
  });
});
