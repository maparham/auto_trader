import { describe, it, expect, vi } from "vitest";
import { defaultVisibility, isVisibleOnResolution } from "./visibility";
import type { Chart } from "klinecharts";

// customIndicators.ts (imported by indicators.ts) reads LineType/registerIndicator
// at module load (AVWAP line style table); stub klinecharts' runtime surface like
// overlays.test.ts / backtestSeries.test.ts do.
vi.mock("klinecharts", () => ({
  // A spy, not a no-op: registerInstanceTemplate's choice of BASE vs INSET template
  // is observable ONLY here (what lands on the chart is klinecharts' own copy), and
  // that choice carries the two properties the inset design is built on — an empty
  // figure list and a neutral precision.
  registerIndicator: vi.fn(),
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));

const {
  applyIndicatorVisibility,
  applySlopeBarHours,
  collapseSubPanes,
  expandSubPanes,
  INTERNAL_INDICATORS,
  isInternalIndicator,
  accelCompanionId,
  addIndicatorInstance,
  importExprInstances,
  liveExprInstances,
  exprInstancesFromChart,
  mintInstanceId,
  isMintedInstanceId,
  applyIndicator,
  isSubPaneInstance,
  mirrorAccelCompanion,
  validateInstanceName,
  renameIndicatorInstance,
} = await import("./indicators");

// In-memory localStorage shim (node env, no DOM) so the persistence-round-trip
// tests below can read what addIndicatorInstance wrote. Mirrors templates.test.ts.
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

const persist = await import("./persist");

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
  // v10 getIndicators() (flat, all-panes form; the helper getIndicatorsByPane
  // rebuilds the per-pane map from ind.paneId) and overrideIndicator() (paneId
  // folded into the patch object).
  function fakeChart(panes: Map<string, Map<string, { name: string; extendData?: unknown; visible?: boolean }>>) {
    const overrides: { name: string; visible: boolean; paneId: string; extendData?: unknown }[] = [];
    const chart = {
      getIndicators: () =>
        [...panes].flatMap(([paneId, inner]) =>
          [...inner.values()].map((ind) => ({ ...ind, paneId })),
        ),
      overrideIndicator: (opts: { name: string; paneId: string; visible?: boolean; extendData?: unknown }) => {
        overrides.push({
          name: opts.name,
          visible: !!opts.visible,
          paneId: opts.paneId,
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

describe("applySlopeBarHours (keeps a live Slope's barHours in step with resolution)", () => {
  // Same minimal fake shape as setAllIndicatorsHidden's fakeChart above: v10
  // getIndicators() (flat, all-panes) + overrideIndicator() (paneId folded in).
  function fakeChart(panes: Map<string, Map<string, { name: string; extendData?: unknown }>>) {
    const overrides: { name: string; paneId: string; extendData?: unknown }[] = [];
    const chart = {
      getIndicators: () =>
        [...panes].flatMap(([paneId, inner]) =>
          [...inner.values()].map((ind) => ({ ...ind, paneId })),
        ),
      overrideIndicator: (opts: { name: string; paneId: string; extendData?: unknown }) => {
        overrides.push({
          name: opts.name,
          paneId: opts.paneId,
          ...(opts.extendData !== undefined ? { extendData: opts.extendData } : {}),
        });
      },
    } as unknown as Chart;
    return { chart, overrides };
  }

  it("writes the nominal barHours (resolution seconds / 3600) onto a SLOPE instance", () => {
    const panes = new Map([
      ["pane_1", new Map([["SLOPE_1", { name: "SLOPE_1", extendData: { indType: "SLOPE", slopePeriod: 3 } }]])],
    ]);
    const { chart, overrides } = fakeChart(panes);
    applySlopeBarHours(chart, "HOUR_4"); // 14400s / 3600 = 4h/bar
    expect(overrides).toEqual([
      { name: "SLOPE_1", paneId: "pane_1", extendData: { indType: "SLOPE", slopePeriod: 3, barHours: 4 } },
    ]);
  });

  it("preserves every other extendData field on the write", () => {
    const ext = { indType: "SLOPE", maType: "ema", units: "pctHr", threshold: { on: true, level: 2 } };
    const panes = new Map([["pane_1", new Map([["SLOPE_1", { name: "SLOPE_1", extendData: ext }]])]]);
    const { chart, overrides } = fakeChart(panes);
    applySlopeBarHours(chart, "HOUR");
    expect(overrides[0].extendData).toEqual({ ...ext, barHours: 1 });
  });

  it("also updates a SLOPE_ACCEL companion pane", () => {
    const panes = new Map([
      ["pane_1", new Map([["SLOPE_1", { name: "SLOPE_1", extendData: { indType: "SLOPE" } }]])],
      ["pane_2", new Map([["SLOPE_1__accel", { name: "SLOPE_1__accel", extendData: { indType: "SLOPE_ACCEL" } }]])],
    ]);
    const { chart, overrides } = fakeChart(panes);
    applySlopeBarHours(chart, "MINUTE_15"); // 900s / 3600 = 0.25h/bar
    expect(overrides).toEqual([
      { name: "SLOPE_1", paneId: "pane_1", extendData: { indType: "SLOPE", barHours: 0.25 } },
      { name: "SLOPE_1__accel", paneId: "pane_2", extendData: { indType: "SLOPE_ACCEL", barHours: 0.25 } },
    ]);
  });

  it("leaves a non-SLOPE indicator untouched", () => {
    const panes = new Map([["candle_pane", new Map([["MA_1", { name: "MA_1", extendData: { maType: "sma" } }]])]]);
    const { chart, overrides } = fakeChart(panes);
    applySlopeBarHours(chart, "HOUR");
    expect(overrides).toEqual([]);
  });

  it("skips the write when barHours is already correct (no pointless recalc)", () => {
    const panes = new Map([
      ["pane_1", new Map([["SLOPE_1", { name: "SLOPE_1", extendData: { indType: "SLOPE", barHours: 1 } }]])],
    ]);
    const { chart, overrides } = fakeChart(panes);
    applySlopeBarHours(chart, "HOUR"); // already 1h/bar
    expect(overrides).toEqual([]);
  });

  it("no-ops for an unrecognized resolution", () => {
    const panes = new Map([
      ["pane_1", new Map([["SLOPE_1", { name: "SLOPE_1", extendData: { indType: "SLOPE" } }]])],
    ]);
    const { chart, overrides } = fakeChart(panes);
    applySlopeBarHours(chart, "NOT_A_RESOLUTION");
    expect(overrides).toEqual([]);
  });
});

describe("collapse / expand sub-panes (double-click hide bottom sub-panes)", () => {
  // Minimal fake exposing what collapse/expand touch: v10 getIndicators() (flat;
  // getIndicatorsByPane rebuilds the per-pane map to enumerate reorderable
  // sub-panes), getSize() (their heights), setPaneOptions().
  function fakeChart(heights: Record<string, number>, subPanes: string[]) {
    const opts: { id: string; height?: number; minHeight?: number; dragEnabled?: boolean }[] = [];
    const map = new Map<string, Map<string, { name: string }>>(
      subPanes.map((p) => [p, new Map([[`I_${p}`, { name: `I_${p}` }]])]),
    );
    map.set("candle_pane", new Map([["MA_1", { name: "MA_1" }]])); // never collapsed
    const chart = {
      getIndicators: () =>
        [...map].flatMap(([paneId, inner]) =>
          [...inner.values()].map((ind) => ({ ...ind, paneId })),
        ),
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

  it("collapses the accel companion pane (parent-owned, but a user pane) yet leaves EQUITY alone", () => {
    // The accel companion counts as internal for reorder/legend purposes, but its
    // pane must still collapse on the double-click gesture: only the app-owned
    // EQUITY pane is exempt.
    const [equityName] = INTERNAL_INDICATORS;
    const accelName = accelCompanionId("SLOPE_1");
    const opts: { id: string; height?: number }[] = [];
    const map = new Map<string, Map<string, { name: string }>>([
      ["candle_pane", new Map([["MA_1", { name: "MA_1" }]])],
      ["pane_slope", new Map([["SLOPE_1", { name: "SLOPE_1" }]])],
      ["pane_accel", new Map([[accelName, { name: accelName }]])],
      ["pane_equity", new Map([[equityName, { name: equityName }]])],
    ]);
    const chart = {
      getIndicators: () =>
        [...map].flatMap(([paneId, inner]) =>
          [...inner.values()].map((ind) => ({ ...ind, paneId })),
        ),
      getSize: () => ({ height: 100, top: 0 }),
      setPaneOptions: (o: (typeof opts)[number]) => opts.push(o),
    } as unknown as Chart;

    const heights = collapseSubPanes(chart);
    expect(opts.map((o) => o.id).sort()).toEqual(["pane_accel", "pane_slope"]);
    expect(heights.get("pane_accel")).toBe(100);

    opts.length = 0;
    expandSubPanes(chart, heights);
    expect(opts.map((o) => o.id).sort()).toEqual(["pane_accel", "pane_slope"]);
  });
});

describe("addIndicatorInstance persists an explicit config (Paste)", () => {
  // A fresh instance created FROM a config snapshot (Paste) must write that
  // snapshot to per-instance storage under its new id. Otherwise a later
  // teardown+recreate (pane reorder, or a plain reload) rehydrates with no
  // saved config and falls back to the bare template, resetting the settings.
  function pasteChart() {
    let seq = 0;
    const chart = {
      getIndicators: () => [], // no existing instances → clean minted id
      createIndicator: () => `pane_${++seq}`,
      overrideIndicator: () => {},
      setPaneOptions: () => {},
      overrideYAxis: () => {},
    } as unknown as Chart;
    return chart;
  }

  it("saves the pasted SLOPE config so it survives a recreate", () => {
    localStorage.clear();
    const scope = "tab.paste";
    const config = { calcParams: [30], extendData: { units: "deg", indType: "SLOPE" } };

    const inst = addIndicatorInstance(pasteChart(), scope, "US100", "SLOPE", { config });
    expect(inst).not.toBeNull();

    // The crux: the config is now retrievable under the new instance id, so the
    // rehydrate path (loadIndicatorConfigs(scope)[id]) finds it on reorder/reload.
    expect(persist.loadIndicatorConfigs(scope)[inst!.id]).toEqual(config);
  });

  it("does not write a config for a plain add (no snapshot): toolbar add is unaffected", () => {
    localStorage.clear();
    const scope = "tab.add";
    const inst = addIndicatorInstance(pasteChart(), scope, "US100", "SLOPE");
    expect(inst).not.toBeNull();
    expect(persist.loadIndicatorConfigs(scope)[inst!.id]).toBeUndefined();
  });
});

describe("a type's default preset survives a recreate", () => {
  // "Save as default" seeds every NEW instance of a type (applyIndicator's third
  // config source). Nothing wrote that seed under the instance's own id, so the
  // first teardown+recreate — Move up, the inset toggle, or a plain reload, all of
  // which rehydrate and so deliberately skip the type default — brought the
  // indicator back at the bare template's params: a Slope(2,9,50,100,200) came
  // back as Slope(9).
  function recordingChart(created: Array<{ name?: string; calcParams?: number[] }>) {
    let seq = 0;
    return {
      getIndicators: () => [],
      createIndicator: (value: { name?: string; calcParams?: number[] }) => {
        created.push(value);
        return `pane_${++seq}`;
      },
      overrideIndicator: () => {},
      setPaneOptions: () => {},
      overrideYAxis: () => {},
    } as unknown as Chart;
  }

  it("recreates a defaults-seeded SLOPE at its own params, not the template's", () => {
    localStorage.clear();
    const scope = "tab.default";
    const calcParams = [2, 9, 50, 100, 200];
    persist.saveIndicatorDefault("SLOPE", { calcParams });
    const created: Array<{ name?: string; calcParams?: number[] }> = [];
    const chart = recordingChart(created);

    // Fresh add: the type default seeds it.
    applyIndicator(chart, scope, "US100", { id: "SLOPE", type: "SLOPE" });
    expect(created[0].calcParams).toEqual(calcParams);

    // Recreate (inset toggle / Move up / reload) — rehydrate skips the type default
    // on purpose, so the instance's own saved config is the ONLY thing that can
    // carry these params through.
    applyIndicator(chart, scope, "US100", { id: "SLOPE", type: "SLOPE" }, { rehydrate: true });
    expect(created[1].calcParams).toEqual(calcParams);
  });

  it("leaves an add with no default preset writing nothing, as before", () => {
    localStorage.clear();
    const scope = "tab.nodefault";
    const created: Array<{ name?: string; calcParams?: number[] }> = [];
    applyIndicator(recordingChart(created), scope, "US100", { id: "SLOPE", type: "SLOPE" });
    expect(persist.loadIndicatorConfigs(scope).SLOPE).toBeUndefined();
  });
});

describe("isInternalIndicator", () => {
  it("matches the fixed equity pane", () => {
    expect(isInternalIndicator("EQUITY")).toBe(true);
  });
  it("matches any accel companion, whose id is dynamic", () => {
    expect(isInternalIndicator("SLOPE__accel")).toBe(true);
    expect(isInternalIndicator("SLOPE#a1b2c3__accel")).toBe(true);
  });
  it("does not match a normal indicator", () => {
    expect(isInternalIndicator("SLOPE")).toBe(false);
    expect(isInternalIndicator("RSI#a1b2c3")).toBe(false);
  });
});

describe("accelCompanionId", () => {
  it("derives a deterministic id from the parent", () => {
    expect(accelCompanionId("SLOPE#a1b2c3")).toBe("SLOPE#a1b2c3__accel");
  });
});

describe("mintInstanceId (bare name for the first instance, except ref/function collisions)", () => {
  // Same minimal fake as above: v10 getIndicators() (flat, all-panes).
  function fakeChart(inds: Array<{ name: string; paneId: string }>) {
    return { getIndicators: () => inds } as unknown as Chart;
  }

  it("never gives an ATR pane the bare name — `ATR.14` would not parse as a ref", () => {
    expect(mintInstanceId(fakeChart([]), "ATR")).toBe("ATR1");
  });

  it("numbers later ATR panes sequentially, filling the first gap", () => {
    expect(mintInstanceId(fakeChart([{ name: "ATR1", paneId: "pane_1" }]), "ATR")).toBe("ATR2");
    expect(
      mintInstanceId(
        fakeChart([{ name: "ATR1", paneId: "pane_1" }, { name: "ATR2", paneId: "pane_2" }]),
        "ATR",
      ),
    ).toBe("ATR3");
    // A deleted ATR1 frees its number for the next pane.
    expect(mintInstanceId(fakeChart([{ name: "ATR2", paneId: "pane_2" }]), "ATR")).toBe("ATR1");
  });

  it("keeps the bare-name fast path for SLOPE (referenceable, but not a function name)", () => {
    expect(mintInstanceId(fakeChart([]), "SLOPE")).toBe("SLOPE");
  });

  it("keeps the bare-name fast path for EMA (a function name, but not referenceable)", () => {
    expect(mintInstanceId(fakeChart([]), "EMA")).toBe("EMA");
  });

  it("numbers a second instance of a bare-name type from 2 (the bare name IS number 1)", () => {
    expect(mintInstanceId(fakeChart([{ name: "SLOPE", paneId: "pane_1" }]), "SLOPE")).toBe(
      "SLOPE2",
    );
    expect(
      mintInstanceId(
        fakeChart([{ name: "SLOPE", paneId: "pane_1" }, { name: "SLOPE2", paneId: "pane_2" }]),
        "SLOPE",
      ),
    ).toBe("SLOPE3");
  });

  it("legacy #-suffixed panes coexist with the numbered scheme", () => {
    expect(
      mintInstanceId(fakeChart([{ name: "ATR#oek8ei", paneId: "pane_1" }]), "ATR"),
    ).toBe("ATR1");
  });
});

describe("liveExprInstances / exprInstancesFromChart (editor + request instance list)", () => {
  // Same minimal fake as above: v10 getIndicators() (flat, all-panes).
  function fakeChart(
    inds: Array<{ name: string; paneId: string; calcParams?: unknown[]; extendData?: unknown }>,
  ) {
    return { getIndicators: () => inds } as unknown as Chart;
  }

  it("flattens the live panes, skipping app-owned and accel companion panes", () => {
    const chart = fakeChart([
      { name: "SLOPE", paneId: "pane_1", calcParams: [9, 21], extendData: { indType: "SLOPE" } },
      {
        name: "SLOPE__accel",
        paneId: "pane_2",
        calcParams: [9, 21],
        extendData: { indType: "SLOPE_ACCEL" },
      },
      { name: "EQUITY", paneId: "pane_3", extendData: {} },
      { name: "EMA#a1b", paneId: "candle_pane", calcParams: [9], extendData: { indType: "EMA" } },
    ]);
    expect(liveExprInstances(chart)).toEqual([
      { id: "SLOPE", type: "SLOPE", calcParams: [9, 21], extendData: { indType: "SLOPE" } },
      { id: "EMA#a1b", type: "EMA", calcParams: [9], extendData: { indType: "EMA" } },
    ]);
  });

  it("exposes only referenceable panes, with the outputs their settings expose", () => {
    const chart = fakeChart([
      {
        name: "SLOPE",
        paneId: "pane_1",
        calcParams: [9, 21],
        extendData: { indType: "SLOPE", showAccel: true },
      },
      { name: "EMA#a1b", paneId: "candle_pane", calcParams: [9], extendData: { indType: "EMA" } },
    ]);
    expect(exprInstancesFromChart(chart)).toEqual([
      { id: "SLOPE", outputs: ["9", "21", "accel9", "accel21"], timeframe: null, detail: "EMA · % / hour" },
    ]);
  });
});

describe("importExprInstances (rule-clipboard paste: recreate referenced panes)", () => {
  // A stateful chart fake: createIndicator records the instance so later
  // getIndicators / liveExprInstances / mintInstanceId calls see it — enough to
  // exercise the reuse / recreate / mint-on-conflict branches for real.
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
        inds.filter(
          (i) => (!q?.paneId || i.paneId === q.paneId) && (!q?.name || i.name === q.name),
        ),
      createIndicator: (value: FakeInd & { paneId?: string }) => {
        const paneId = value.paneId ?? `pane_${++seq}`;
        inds.push({
          paneId,
          name: value.name,
          calcParams: value.calcParams,
          extendData: value.extendData,
          visible: value.visible,
        });
        return paneId;
      },
      overrideIndicator: () => {},
      setPaneOptions: () => {},
      overrideYAxis: () => {},
    } as unknown as Chart;
    return { chart, inds };
  }

  it("reuses an identically-configured pane instead of duplicating it", () => {
    localStorage.clear();
    const { chart, inds } = statefulChart([
      { name: "SLOPE", type: "SLOPE", calcParams: [30], extendData: { units: "deg" } },
    ]);
    const { idMap, added } = importExprInstances(chart, "tab.i", "US100", {
      SLOPE: { type: "SLOPE", calcParams: [30], extendData: { units: "deg" } },
    });
    expect(idMap).toEqual({ SLOPE: "SLOPE" });
    expect(added).toEqual([]);
    expect(inds).toHaveLength(1);
  });

  it("recreates a missing pane under the copied id and persists its config", () => {
    localStorage.clear();
    const { chart, inds } = statefulChart([]);
    const { idMap, added } = importExprInstances(chart, "tab.i", "US100", {
      SLOPE2: { type: "SLOPE", calcParams: [30], extendData: { units: "deg" }, visible: false },
    });
    expect(idMap).toEqual({ SLOPE2: "SLOPE2" });
    expect(added).toEqual([{ id: "SLOPE2", type: "SLOPE" }]);
    const created = inds.find((i) => i.name === "SLOPE2")!;
    expect(created.calcParams).toEqual([30]);
    expect(created.visible).toBe(false); // shipped appearance applied
    // Persisted under the copied id so the pane survives teardown/reload.
    expect(persist.loadIndicatorConfigs("tab.i").SLOPE2).toMatchObject({
      calcParams: [30],
      visible: false,
    });
  });

  it("mints a fresh id on conflict, and a repeat paste reuses it (idempotent)", () => {
    localStorage.clear();
    const { chart, inds } = statefulChart([
      { name: "SLOPE", type: "SLOPE", calcParams: [9], extendData: { units: "pctBar" } },
    ]);
    const payload = {
      SLOPE: { type: "SLOPE", calcParams: [30], extendData: { units: "deg" } },
    };
    const first = importExprInstances(chart, "tab.i", "US100", payload);
    expect(first.idMap.SLOPE).toBe("SLOPE2"); // minted — "SLOPE" is a different pane
    expect(first.added).toHaveLength(1);
    expect(inds).toHaveLength(2);

    // Pasting the same clipboard again must not pile up SLOPE3, SLOPE4, …
    const second = importExprInstances(chart, "tab.i", "US100", payload);
    expect(second.idMap.SLOPE).toBe("SLOPE2");
    expect(second.added).toEqual([]);
    expect(inds).toHaveLength(2);
  });

  it("matching ignores runtime/display state (barHours, MTF stash, visibility)", () => {
    localStorage.clear();
    const { chart, inds } = statefulChart([
      {
        name: "SLOPE",
        type: "SLOPE",
        calcParams: [9],
        extendData: {
          units: "deg",
          barHours: 4,
          userVisible: false,
          mtf: { timeframe: "HOUR", htfStarts: [1, 2], htfSeriesByLine: [[1]] },
        },
      },
    ]);
    const { idMap, added } = importExprInstances(chart, "tab.i", "US100", {
      SLOPE: { type: "SLOPE", calcParams: [9], extendData: { units: "deg", mtf: { timeframe: "HOUR" } } },
    });
    expect(idMap).toEqual({ SLOPE: "SLOPE" });
    expect(added).toEqual([]);
    expect(inds).toHaveLength(1);
  });
});

describe("isMintedInstanceId (keeps per-instance names out of the indicator menu)", () => {
  // getSupportedIndicators() returns minted INSTANCE names ("FVG2") alongside the
  // real types, because every 2nd+ instance is registered as its own template.
  // The menu must be able to tell them apart — and it cannot do so by SHAPE,
  // since mintInstanceId just appends a digit, so "FVG2" looks exactly like a
  // type name. Getting this wrong lists instances as addable "types", and
  // clicking one mints an instance OF that fake type ("FVG22"), which breeds.
  function chartWith(existing: string[]) {
    let seq = 0;
    return {
      getIndicators: () => existing.map((name) => ({ name, paneId: "candle_pane" })),
      createIndicator: () => `pane_${++seq}`,
      overrideIndicator: () => {},
      setPaneOptions: () => {},
      overrideYAxis: () => {},
    } as unknown as Chart;
  }

  it("does not flag a TYPE, whose first instance takes the bare name", () => {
    const first = addIndicatorInstance(chartWith([]), "tab.menu", "US100", "FVG");
    expect(first!.id).toBe("FVG");
    expect(isMintedInstanceId("FVG")).toBe(false);
  });

  it("flags the id minted for a second instance", () => {
    const second = addIndicatorInstance(chartWith(["FVG"]), "tab.menu", "US100", "FVG");
    expect(second!.id).toBe("FVG2");
    expect(isMintedInstanceId("FVG2")).toBe(true);
  });

  it("flags a REHYDRATED instance id, which is registered without ever being minted", () => {
    // A reload replays saved ids straight through applyIndicator — no mint call —
    // so recording ids at the mint site would miss every instance after a refresh.
    applyIndicator(chartWith([]), "tab.menu", "US100", { id: "FVG7", type: "FVG" });
    expect(isMintedInstanceId("FVG7")).toBe(true);
  });

  it("still flags legacy '#'-suffixed ids from earlier builds", () => {
    expect(isMintedInstanceId("EMA#a1b2c3")).toBe(true);
  });
});

describe("inset placement", () => {
  function recordingChart() {
    const created: Array<Record<string, unknown>> = [];
    const paneOptions: Array<Record<string, unknown>> = [];
    let seq = 0;
    const chart = {
      getIndicators: () => [],
      createIndicator: (value: unknown) => {
        const v = value as Record<string, unknown>;
        created.push(v);
        return (v.paneId as string) ?? `pane_${++seq}`;
      },
      overrideIndicator: () => {},
      setPaneOptions: (o: unknown) => paneOptions.push(o as Record<string, unknown>),
      overrideYAxis: () => {},
    } as unknown as Chart;
    return { chart, created, paneOptions };
  }

  // The template registered under `name`, as klinecharts saw it. registerIndicator is
  // the ONLY observation point for the inset-vs-base template choice: createIndicator
  // just names a template, so the created value carries neither figures nor precision.
  async function registeredTemplate(name: string) {
    const { registerIndicator } = await import("klinecharts");
    const calls = vi.mocked(registerIndicator).mock.calls;
    const hit = [...calls].reverse().find(([t]) => (t as { name?: string })?.name === name);
    return hit?.[0] as unknown as
      | { name: string; figures?: unknown[]; precision?: number }
      | undefined;
  }

  it("registers the INSET template: no figures for the price axis, neutral precision", async () => {
    // The two properties the whole design rests on. Without them an inset RSI lands on
    // candle_pane still feeding rsi values into the pane's range math, and reporting
    // precision 2 — which becomes the pane MIN and rounds a 5-decimal price axis.
    const { chart } = recordingChart();
    applyIndicator(chart, "tab.inset7", "US100", { id: "RSI", type: "RSI", inset: true });
    const tmpl = await registeredTemplate("RSI");
    expect(tmpl).toBeDefined();
    expect(tmpl!.figures).toEqual([]);
    expect(tmpl!.precision).toBe(8);
  });

  it("registers the BASE template without the flag, so the assertion above pins the branch", async () => {
    const { chart } = recordingChart();
    applyIndicator(chart, "tab.inset8", "US100", { id: "RSI", type: "RSI" });
    const tmpl = await registeredTemplate("RSI");
    expect(tmpl).toBeDefined();
    expect(tmpl!.figures).not.toEqual([]);
    expect(tmpl!.precision).toBe(2);
  });

  it("puts an inset instance on the candle pane and sizes no sub-pane", () => {
    const { chart, created, paneOptions } = recordingChart();
    const paneId = applyIndicator(chart, "tab.inset", "US100", { id: "RSI", type: "RSI", inset: true });
    expect(paneId).toBe("candle_pane");
    expect(created[0].paneId).toBe("candle_pane");
    expect(paneOptions).toEqual([]);
  });

  it("marks the live instance so the draw and the legend can recognise it", () => {
    const { chart, created } = recordingChart();
    applyIndicator(chart, "tab.inset", "US100", { id: "RSI", type: "RSI", inset: true });
    expect((created[0].extendData as { inset?: boolean }).inset).toBe(true);
  });

  it("opens a normal sub-pane without the flag, and leaves extendData clean", () => {
    const { chart, created, paneOptions } = recordingChart();
    applyIndicator(chart, "tab.inset2", "US100", { id: "RSI", type: "RSI" });
    expect(created[0].paneId).toBeUndefined();
    expect(paneOptions.length).toBe(1);
    expect(
      Object.prototype.hasOwnProperty.call(created[0].extendData as object, "inset"),
    ).toBe(false);
  });

  it("ignores a stale inset in a saved config, deriving the mode from the instance", () => {
    // A template or pasted payload can carry a stale extendData.inset; the
    // instance list is the source of truth.
    const { chart, created } = recordingChart();
    applyIndicator(chart, "tab.inset3", "US100", { id: "RSI", type: "RSI" }, {
      config: { extendData: { inset: true } } as never,
    });
    expect(
      Object.prototype.hasOwnProperty.call(created[0].extendData as object, "inset"),
    ).toBe(false);
  });

  it("drops a trendline pin from a saved config: pins are session-only", () => {
    // A pre-change snapshot (or a template copied from one) can still carry
    // extendData.pinned. Restoring it would re-extend lines the user pinned in
    // some earlier session and cannot remember.
    const { chart, created } = recordingChart();
    applyIndicator(chart, "tab.pin1", "US100", { id: "TRENDLINES", type: "TRENDLINES" }, {
      config: { extendData: { pinned: ["a"], extend: "segment" } } as never,
    });
    const ext = created[0].extendData as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(ext, "pinned")).toBe(false);
    expect(ext.extend).toBe("segment");
  });

  it("refuses inset for a type that is not inset-capable, without blocking creation", () => {
    // SESSIONS is one of ours but is not in INSET_CAPABLE, so a stale flag on it
    // must be inert AND must not stop the indicator from opening its own pane.
    // (A klinecharts built-in like MACD cannot be used for this assertion: this
    // file mocks getSupportedIndicators to [], so a built-in never registers here.)
    const { chart, created, paneOptions } = recordingChart();
    applyIndicator(chart, "tab.inset4", "US100", { id: "SESSIONS", type: "SESSIONS", inset: true });
    expect(created).toHaveLength(1);
    expect(created[0].paneId).toBeUndefined();
    expect(paneOptions).toHaveLength(1);
    expect(
      Object.prototype.hasOwnProperty.call(created[0].extendData as object, "inset"),
    ).toBe(false);
  });
});

describe("isSubPaneInstance", () => {
  it("is true for a plain pane indicator", () => {
    expect(isSubPaneInstance({ id: "RSI", type: "RSI" })).toBe(true);
  });
  it("is false once that instance is inset", () => {
    expect(isSubPaneInstance({ id: "RSI", type: "RSI", inset: true })).toBe(false);
  });
  it("is false for a candle-pane overlay", () => {
    expect(isSubPaneInstance({ id: "EMA", type: "EMA" })).toBe(false);
  });
});

describe("inset marker does not leak onto a Slope's accel companion", () => {
  // The companion is DERIVED from its parent by spreading the parent's extendData,
  // but `inset` is a per-instance PLACEMENT marker and the companion always draws
  // in its own sub-pane. Copying it would make isInsetInstance (and the legend
  // helpers that branch on it) treat a sub-pane indicator as inset.
  function slopeChart() {
    const created: Array<Record<string, unknown>> = [];
    let seq = 0;
    const chart = {
      getIndicators: () =>
        created.map((v) => ({ ...v, paneId: (v.paneId as string) ?? "pane_1" })),
      createIndicator: (value: unknown) => {
        const v = value as Record<string, unknown>;
        created.push(v);
        return (v.paneId as string) ?? `pane_${++seq}`;
      },
      removeIndicator: () => {},
      overrideIndicator: (o: unknown) => overrides.push(o as Record<string, unknown>),
      setPaneOptions: () => {},
      overrideYAxis: () => {},
    } as unknown as Chart;
    const overrides: Array<Record<string, unknown>> = [];
    return { chart, created, overrides };
  }

  it("spawns the companion clean when the parent is inset", () => {
    const { chart, created } = slopeChart();
    applyIndicator(chart, "tab.inset5", "US100", { id: "SLOPE", type: "SLOPE", inset: true }, {
      config: { extendData: { showAccel: true } } as never,
    });
    const companion = created.find((v) => v.name === accelCompanionId("SLOPE"));
    expect(companion).toBeDefined();
    expect((companion!.extendData as { indType?: string }).indType).toBe("SLOPE_ACCEL");
    expect(
      Object.prototype.hasOwnProperty.call(companion!.extendData as object, "inset"),
    ).toBe(false);
  });

  it("strips it from a mirrored patch too (the settings-modal path)", () => {
    const { chart, overrides } = slopeChart();
    applyIndicator(chart, "tab.inset6", "US100", { id: "SLOPE", type: "SLOPE", inset: true }, {
      config: { extendData: { showAccel: true } } as never,
    });
    mirrorAccelCompanion(chart, "SLOPE", { extendData: { showAccel: true, inset: true } });
    const patch = overrides.find((o) => o.name === accelCompanionId("SLOPE") && o.extendData);
    expect(patch).toBeDefined();
    expect(
      Object.prototype.hasOwnProperty.call(patch!.extendData as object, "inset"),
    ).toBe(false);
  });
});

describe("validateInstanceName", () => {
  function fakeChart(inds: Array<{ name: string; paneId: string }>) {
    return { getIndicators: () => inds } as unknown as Chart;
  }

  it("accepts a fresh, well-formed name", () => {
    expect(validateInstanceName(fakeChart([]), "MyPivot", "PIVOT_ANALYSIS")).toBeNull();
  });

  it("flags renaming to the same name as unchanged", () => {
    expect(validateInstanceName(fakeChart([]), "PIVOT_ANALYSIS", "PIVOT_ANALYSIS")).toBe("unchanged");
  });

  it("rejects a name with illegal characters or a leading digit", () => {
    expect(validateInstanceName(fakeChart([]), "My Pivot", "PIVOT_ANALYSIS")).toBe("invalid");
    expect(validateInstanceName(fakeChart([]), "1Pivot", "PIVOT_ANALYSIS")).toBe("invalid");
    expect(validateInstanceName(fakeChart([]), "", "PIVOT_ANALYSIS")).toBe("invalid");
  });

  it("rejects a name already used by another live pane", () => {
    const chart = fakeChart([{ name: "FVG2", paneId: "candle_pane" }]);
    expect(validateInstanceName(chart, "FVG2", "PIVOT_ANALYSIS")).toBe("taken");
  });

  it("rejects an expr grammar name (function, wrapper, keyword, root)", () => {
    const chart = fakeChart([]);
    expect(validateInstanceName(chart, "EMA", "PIVOT_ANALYSIS")).toBe("reserved");
    expect(validateInstanceName(chart, "slope", "PIVOT_ANALYSIS")).toBe("reserved");
    expect(validateInstanceName(chart, "count", "PIVOT_ANALYSIS")).toBe("reserved");
    expect(validateInstanceName(chart, "candle", "PIVOT_ANALYSIS")).toBe("reserved");
    expect(validateInstanceName(chart, "AND", "PIVOT_ANALYSIS")).toBe("reserved");
  });

  it("rejects a real base-type name", () => {
    expect(validateInstanceName(fakeChart([]), "SLOPE", "PIVOT_ANALYSIS")).toBe("reserved");
  });
});

describe("renameIndicatorInstance", () => {
  // A stateful chart fake supporting create/remove/getSize, on top of the
  // importExprInstances fixture above — enough to exercise the full
  // teardown+recreate dance.
  function statefulChart(
    initial: Array<{
      name: string;
      type: string;
      paneId?: string;
      calcParams?: number[];
      extendData?: Record<string, unknown>;
      visible?: boolean;
    }>,
  ) {
    let seq = 0;
    type FakeInd = {
      paneId: string;
      name: string;
      calcParams?: number[];
      extendData?: Record<string, unknown>;
      visible?: boolean;
      styles?: { lines?: Array<Record<string, unknown>> };
    };
    const inds: FakeInd[] = initial.map((i) => ({
      paneId: i.paneId ?? `pane_${++seq}`,
      name: i.name,
      calcParams: i.calcParams,
      extendData: { ...i.extendData, indType: i.type },
      visible: i.visible,
    }));
    const removed: string[] = [];
    const created: FakeInd[] = [];
    const chart = {
      getIndicators: (q?: { paneId?: string; name?: string }) =>
        inds.filter(
          (i) => (!q?.paneId || i.paneId === q.paneId) && (!q?.name || i.name === q.name),
        ),
      createIndicator: (value: FakeInd & { paneId?: string }) => {
        const paneId = value.paneId ?? `pane_${++seq}`;
        const rec = {
          paneId,
          name: value.name,
          calcParams: value.calcParams,
          extendData: value.extendData,
          visible: value.visible,
        };
        inds.push(rec);
        created.push(rec);
        return paneId;
      },
      removeIndicator: (filter: { paneId?: string; name?: string }) => {
        const i = inds.findIndex(
          (x) => (!filter.paneId || x.paneId === filter.paneId) && x.name === filter.name,
        );
        if (i > -1) {
          removed.push(inds[i].name);
          inds.splice(i, 1);
        }
      },
      overrideIndicator: () => {},
      setPaneOptions: () => {},
      overrideYAxis: () => {},
      getSize: () => ({ height: 150 }),
    } as unknown as Chart;
    return { chart, inds, removed, created };
  }

  it("recreates the instance under the new id with the same config", () => {
    localStorage.clear();
    const { chart, inds } = statefulChart([
      {
        name: "PIVOT_ANALYSIS",
        type: "PIVOT_ANALYSIS",
        calcParams: [34, 34, 0, 0],
        extendData: { showLevels: true },
        visible: true,
      },
    ]);
    const result = renameIndicatorInstance(chart, "tab.rename", "US100", "PIVOT_ANALYSIS", "MyPivots");
    expect(result.ok).toBe(true);
    expect(inds.find((i) => i.name === "PIVOT_ANALYSIS")).toBeUndefined();
    const created = inds.find((i) => i.name === "MyPivots")!;
    expect(created).toBeDefined();
    expect(created.calcParams).toEqual([34, 34, 0, 0]);
    expect((created.extendData as { showLevels?: boolean }).showLevels).toBe(true);
    // Persisted under the new id, so a later reload/teardown carries it forward.
    expect(persist.loadIndicatorConfigs("tab.rename").MyPivots).toMatchObject({
      calcParams: [34, 34, 0, 0],
    });
  });

  it("refuses and makes no changes when the new name is invalid", () => {
    localStorage.clear();
    const { chart, inds, removed } = statefulChart([
      { name: "PIVOT_ANALYSIS", type: "PIVOT_ANALYSIS", calcParams: [34, 34, 0, 0] },
    ]);
    const result = renameIndicatorInstance(chart, "tab.rename2", "US100", "PIVOT_ANALYSIS", "1bad");
    expect(result).toEqual({ ok: false, error: "invalid" });
    expect(removed).toEqual([]);
    expect(inds.map((i) => i.name)).toEqual(["PIVOT_ANALYSIS"]);
  });

  it("refuses when the new name is already taken by another live pane", () => {
    localStorage.clear();
    const { chart, removed } = statefulChart([
      { name: "PIVOT_ANALYSIS", type: "PIVOT_ANALYSIS", calcParams: [34, 34, 0, 0] },
      { name: "FVG2", type: "FVG", calcParams: [0.25, 500, 10] },
    ]);
    const result = renameIndicatorInstance(chart, "tab.rename3", "US100", "PIVOT_ANALYSIS", "FVG2");
    expect(result).toEqual({ ok: false, error: "taken" });
    expect(removed).toEqual([]);
  });

  it("removing itself does not count as a collision (renaming to its own id is a no-op error)", () => {
    localStorage.clear();
    const { chart } = statefulChart([
      { name: "PIVOT_ANALYSIS", type: "PIVOT_ANALYSIS", calcParams: [34, 34, 0, 0] },
    ]);
    const result = renameIndicatorInstance(chart, "tab.rename4", "US100", "PIVOT_ANALYSIS", "PIVOT_ANALYSIS");
    expect(result).toEqual({ ok: false, error: "unchanged" });
  });
});
