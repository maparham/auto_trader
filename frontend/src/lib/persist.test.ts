import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { installMemStorage } from "./testMemStorage";

// vitest runs in the 'node' env (see vite.config.ts), so provide a tiny in-memory
// localStorage before importing the module under test.
installMemStorage();

const P = await import("./persist");

const SYMBOL = { epic: "US100", name: "US Tech 100", status: null, pricePrecision: 2 };
const PERIOD = { resolution: "HOUR", label: "1H" } as unknown as import("./feed").Period;

beforeEach(() => localStorage.clear());

describe("persist scoping", () => {
  it("scopes drawings/alerts by the opaque scope prefix and keeps cells independent", () => {
    P.saveDrawings("tab.A", "US100", [{ name: "x", points: [{ value: 1 }] }]);
    expect(P.loadDrawings("tab.A", "US100")).toHaveLength(1);
    // A different scope (another cell) sees nothing.
    expect(P.loadDrawings("tab.B", "US100")).toEqual([]);
    // A different epic in the same scope is separate.
    expect(P.loadDrawings("tab.A", "BTC")).toEqual([]);
    // Key shape is byte-identical to the pre-cells layout for a primary scope.
    expect(localStorage.getItem("auto-trader.tab.A.drawings.US100")).not.toBeNull();
  });

  it("alerts are global per epic (scope-independent); avwap anchors are scope+epic keyed", () => {
    P.saveAlerts("US100", [
      { id: "a1", level: 5, condition: "crossing", trigger: "every", message: "" },
    ]);
    P.saveAvwapAnchor("tab.A", "US100", "AVWAP", 123);
    // Alerts belong to the instrument, not a cell — readable without a scope, and a
    // different epic is separate.
    expect(P.loadAlerts("US100")).toHaveLength(1);
    expect(P.loadAlerts("BTC")).toEqual([]);
    expect(localStorage.getItem("auto-trader.b.capital.alerts.US100")).not.toBeNull();
    // AVWAP anchors stay per-scope.
    expect(P.loadAvwapAnchor("tab.A", "US100", "AVWAP")).toBe(123);
    expect(P.loadAvwapAnchor("tab.B", "US100", "AVWAP")).toBe(0);
  });

  it("primaryCellScope / cellScope produce the documented prefixes", () => {
    expect(P.primaryCellScope("t1")).toBe("tab.t1");
    expect(P.cellScope("t1", "c2")).toBe("tab.t1.cell.c2");
  });

  it("legendCollapsed round-trips per scope, default false", () => {
    expect(P.loadLegendCollapsed("tab.A")).toBe(false);
    P.saveLegendCollapsed("tab.A", true);
    expect(P.loadLegendCollapsed("tab.A")).toBe(true);
    // Another cell is independent.
    expect(P.loadLegendCollapsed("tab.B")).toBe(false);
    P.saveLegendCollapsed("tab.A", false);
    expect(P.loadLegendCollapsed("tab.A")).toBe(false);
  });
});

// Overlay-less edits of a stored alert (the alerts panel's all-symbols rows act on
// alerts whose chart may not be open). Keyed by the NORMALIZED stable id so legacy
// rows (no stored id) match by their deterministic backfilled id too.
describe("stored-alert direct edits (loadStoredAlert / updateStoredAlert / deleteStoredAlert)", () => {
  const A = { id: "a1", level: 5, condition: "crossing" as const, trigger: "every" as const, message: "" };
  const B = { id: "a2", level: 7, condition: "less" as const, trigger: "once" as const, message: "hi" };

  it("loadStoredAlert finds by id (incl. a legacy row by its backfilled id)", () => {
    P.saveAlerts("US100", [A]);
    expect(P.loadStoredAlert("US100", "a1")!.level).toBe(5);
    expect(P.loadStoredAlert("US100", "nope")).toBeNull();
    // Legacy row (no stored id): match by the same id normalizeAlert backfills.
    localStorage.setItem("auto-trader.b.capital.alerts.BTC", JSON.stringify([{ level: 3, condition: "crossing" }]));
    const legacyId = P.normalizeAlert({ level: 3, condition: "crossing" }, 0).id;
    expect(P.loadStoredAlert("BTC", legacyId)!.level).toBe(3);
  });

  it("updateStoredAlert replaces level + cfg in place, keeps id, leaves siblings untouched", () => {
    P.saveAlerts("US100", [A, B]);
    P.updateStoredAlert("US100", "a1", 9, {
      condition: "greater", trigger: "once", message: "edited", expiresAt: null,
      notify: { toast: true, browser: false, sound: true },
    });
    const list = P.loadAlerts("US100");
    const a1 = list.find((x) => x.id === "a1")!;
    expect(a1.level).toBe(9);
    expect(a1.condition).toBe("greater");
    expect(a1.message).toBe("edited");
    expect(a1.notify).toEqual({ toast: true, browser: false, sound: true });
    expect(list.find((x) => x.id === "a2")).toEqual(B); // sibling unchanged
  });

  it("deleteStoredAlert removes only the matching id", () => {
    P.saveAlerts("US100", [A, B]);
    P.deleteStoredAlert("US100", "a1");
    expect(P.loadAlerts("US100").map((x) => x.id)).toEqual(["a2"]);
    P.deleteStoredAlert("US100", "ghost"); // no-op
    expect(P.loadAlerts("US100").map((x) => x.id)).toEqual(["a2"]);
  });
});

describe("loadTabs migration (v1 single-chart → cell-based)", () => {
  it("wraps a pre-cells tab into one primary cell, preserving symbol/period", () => {
    localStorage.setItem(
      "auto-trader.b.capital.tabs",
      JSON.stringify([{ id: "t1", symbol: SYMBOL, period: PERIOD }]),
    );
    const tabs = P.loadTabs();
    expect(tabs).not.toBeNull();
    const t = tabs![0];
    expect(t.layout).toBe("1");
    expect(t.cells).toHaveLength(1);
    expect(t.activeCellId).toBe(t.cells[0].id);
    expect(t.cells[0].symbol).toEqual(SYMBOL);
    expect(t.cells[0].period).toEqual(PERIOD);
    // Migrated cell reuses the tab's primary scope so existing keys still resolve.
    expect(t.cells[0].scope).toBe(P.primaryCellScope("t1"));
  });

  it("a drawing saved under the pre-cells key is readable via the migrated cell's scope", () => {
    // Pre-cells key shape: auto-trader.tab.<id>.drawings.<epic>
    localStorage.setItem(
      "auto-trader.tab.t1.drawings.US100",
      JSON.stringify([{ name: "trend", points: [{ value: 1 }] }]),
    );
    localStorage.setItem(
      "auto-trader.b.capital.tabs",
      JSON.stringify([{ id: "t1", symbol: SYMBOL, period: PERIOD }]),
    );
    const t = P.loadTabs()![0];
    expect(P.loadDrawings(t.cells[0].scope, "US100")).toHaveLength(1);
  });

  it("leaves already-migrated (cell-based) tabs untouched", () => {
    const cellBased = [
      {
        id: "t9",
        layout: "2h",
        activeCellId: "c1",
        cells: [
          { id: "c1", symbol: SYMBOL, period: PERIOD, scope: "tab.t9" },
          { id: "c2", symbol: SYMBOL, period: PERIOD, scope: "tab.t9.cell.c2" },
        ],
      },
    ];
    localStorage.setItem("auto-trader.b.capital.tabs", JSON.stringify(cellBased));
    expect(P.loadTabs()).toEqual(cellBased);
  });
});

describe("per-indicator presets (global, keyed by type)", () => {
  it("default save/load/clear round-trips, keyed by type", () => {
    const cfg = { calcParams: [21], visible: true };
    P.saveIndicatorDefault("EMA", cfg);
    expect(P.loadIndicatorDefault("EMA")).toEqual(cfg);
    // Keyed by type, not scope; another type sees nothing.
    expect(P.loadIndicatorDefault("RSI")).toBeNull();
    expect(localStorage.getItem("auto-trader.indicatorDefault.EMA")).not.toBeNull();
    P.clearIndicatorDefault("EMA");
    expect(P.loadIndicatorDefault("EMA")).toBeNull();
  });

  it("named presets save/load/delete independently per name", () => {
    P.saveIndicatorPreset("EMA", "Fast", { calcParams: [9] });
    P.saveIndicatorPreset("EMA", "Slow", { calcParams: [50] });
    expect(Object.keys(P.loadIndicatorPresets("EMA")).sort()).toEqual(["Fast", "Slow"]);
    expect(P.loadIndicatorPresets("EMA").Fast).toEqual({ calcParams: [9] });
    P.deleteIndicatorPreset("EMA", "Fast");
    expect(Object.keys(P.loadIndicatorPresets("EMA"))).toEqual(["Slow"]);
    // Presets and default are separate stores.
    expect(P.loadIndicatorDefault("EMA")).toBeNull();
  });
});

describe("saveIndicatorVisible (legend eye-icon toggle)", () => {
  it("patches extendData.userVisible alongside the legacy visible flag", () => {
    // Regression: applyIndicatorIntervalVisibility (lib/indicators.ts) reads intent
    // from extendData.userVisible on every period change and does not fall back to
    // the legacy `visible` flag once userVisible has ever been explicitly set — so
    // the eye icon must keep both in sync, or it silently self-reverts on the next
    // timeframe switch.
    P.saveIndicatorConfig("scope1", "EMA#1", {
      visible: true,
      extendData: { userVisible: true, someOtherKey: "keep-me" },
    });
    P.saveIndicatorVisible("scope1", "EMA#1", false);
    const cfg = P.loadIndicatorConfigs("scope1")["EMA#1"];
    expect(cfg.visible).toBe(false);
    expect((cfg.extendData as { userVisible?: boolean }).userVisible).toBe(false);
    // Doesn't clobber unrelated extendData keys.
    expect((cfg.extendData as { someOtherKey?: string }).someOtherKey).toBe("keep-me");
  });

  it("works when no prior config exists for this id", () => {
    P.saveIndicatorVisible("scope1", "RSI#1", true);
    const cfg = P.loadIndicatorConfigs("scope1")["RSI#1"];
    expect(cfg.visible).toBe(true);
    expect((cfg.extendData as { userVisible?: boolean }).userVisible).toBe(true);
  });
});

describe("per-symbol templates", () => {
  it("save/load/delete round-trips and is keyed globally by epic", () => {
    const t = {
      epic: "US100",
      indicators: [{ id: "EMA", type: "EMA" }],
      indicatorConfigs: { EMA: { calcParams: [9] } },
      drawings: [{ name: "trend", points: [{ value: 1 }] }],
      avwapAnchors: {},
      savedAt: 1,
    };
    P.saveSymbolTemplate(t);
    expect(P.loadSymbolTemplate("US100")).toEqual(t);
    // Global, not scope-prefixed: another symbol sees nothing.
    expect(P.loadSymbolTemplate("BTC")).toBeNull();
    // Key shape.
    expect(localStorage.getItem("auto-trader.b.capital.template.US100")).not.toBeNull();
    P.deleteSymbolTemplate("US100");
    expect(P.loadSymbolTemplate("US100")).toBeNull();
  });
});

describe("scope lifecycle", () => {
  it("purgeTabScope removes the primary AND nested cell keys for the tab", () => {
    P.saveDrawings("tab.t1", "US100", [{ name: "a", points: [] }]); // primary cell
    P.saveDrawings("tab.t1.cell.c2", "US100", [{ name: "b", points: [] }]); // 2nd cell
    P.saveDrawings("tab.t2", "US100", [{ name: "c", points: [] }]); // other tab
    P.purgeTabScope("t1");
    expect(P.loadDrawings("tab.t1", "US100")).toEqual([]);
    expect(P.loadDrawings("tab.t1.cell.c2", "US100")).toEqual([]);
    // Another tab is untouched.
    expect(P.loadDrawings("tab.t2", "US100")).toHaveLength(1);
  });

  it("purgeScope removes only the exact cell's keys", () => {
    P.saveDrawings("tab.t1", "US100", [{ name: "a", points: [] }]);
    P.saveDrawings("tab.t1.cell.c2", "US100", [{ name: "b", points: [] }]);
    P.purgeScope("tab.t1.cell.c2");
    expect(P.loadDrawings("tab.t1.cell.c2", "US100")).toEqual([]);
    expect(P.loadDrawings("tab.t1", "US100")).toHaveLength(1);
  });
});

// --- named workspace layouts -------------------------------------------------

// Build a single-cell tab whose primary cell already has a drawing saved.
function seedTab(id: string): import("./persist").ChartTab {
  P.saveDrawings(P.primaryCellScope(id), "US100", [{ name: "trend", points: [{ value: 1 }] }]);
  return {
    id,
    layout: "1",
    activeCellId: `${id}-c0`,
    cells: [{ id: `${id}-c0`, symbol: SYMBOL, period: PERIOD, scope: P.primaryCellScope(id) }],
  };
}

describe("named layouts CRUD + default", () => {
  it("saveLayout registers the index entry and stores the body", () => {
    const ws = { tabs: [seedTab("t1")], activeTabId: "t1" };
    P.saveLayout("L1", "Crypto", ws);
    expect(P.loadLayouts()).toEqual([{ id: "L1", name: "Crypto" }]);
    expect(P.loadLayout("L1")?.activeTabId).toBe("t1");
    expect(P.loadLayout("L1")?.tabs).toHaveLength(1);
  });

  it("saveLayout on an existing id updates in place (no duplicate index entry)", () => {
    P.saveLayout("L1", "Crypto", { tabs: [seedTab("t1")], activeTabId: "t1" });
    P.saveLayout("L1", "Crypto FX", { tabs: [seedTab("t1")], activeTabId: "t1" });
    expect(P.loadLayouts()).toEqual([{ id: "L1", name: "Crypto FX" }]);
  });

  it("rename / delete / default round-trip", () => {
    P.saveLayout("L1", "A", { tabs: [seedTab("t1")], activeTabId: "t1" });
    P.renameLayout("L1", "B");
    expect(P.loadLayouts()[0].name).toBe("B");

    P.saveDefaultLayoutId("L1");
    expect(P.loadDefaultLayoutId()).toBe("L1");

    // Deleting the default clears the default AND purges the layout's tab scopes.
    P.deleteLayout("L1");
    expect(P.loadLayouts()).toEqual([]);
    expect(P.loadDefaultLayoutId()).toBeNull();
    expect(P.loadLayout("L1")).toBeNull();
    expect(P.loadDrawings(P.primaryCellScope("t1"), "US100")).toEqual([]);
  });

  it("activeLayoutId and scratch are device-local (no backend key shape clash)", () => {
    P.saveActiveLayoutId("L1");
    expect(P.loadActiveLayoutId()).toBe("L1");
    P.saveActiveLayoutId(null);
    expect(P.loadActiveLayoutId()).toBeNull();

    P.saveScratch({ tabs: [seedTab("s1")], activeTabId: "s1" });
    expect(P.loadScratch()?.activeTabId).toBe("s1");
    P.clearScratch();
    expect(P.loadScratch()).toBeNull();
  });
});

describe("cloneWorkspace — scope isolation (the Save-as correctness rule)", () => {
  let n = 0;
  const mintTab = () => `clone-tab-${n++}`;
  const mintCell = () => `clone-cell-${n++}`;

  it("single-cell: clone gets fresh ids and an INDEPENDENT copy of the drawings", () => {
    const src = { tabs: [seedTab("t1")], activeTabId: "t1" };
    const clone = P.cloneWorkspace(src, mintTab, mintCell);

    // Fresh ids, not the originals.
    expect(clone.tabs[0].id).not.toBe("t1");
    const newScope = clone.tabs[0].cells[0].scope;
    // Content copied.
    expect(P.loadDrawings(newScope, "US100")).toHaveLength(1);

    // Editing the clone must NOT touch the original.
    P.saveDrawings(newScope, "US100", []);
    expect(P.loadDrawings(newScope, "US100")).toEqual([]);
    expect(P.loadDrawings(P.primaryCellScope("t1"), "US100")).toHaveLength(1);
  });

  it("multi-cell: nested cell content does NOT leak into the clone's primary scope", () => {
    // A 2-cell tab: primary + one nested cell, each with its own drawing.
    P.saveDrawings("tab.m1", "US100", [{ name: "primary", points: [] }]);
    P.saveDrawings("tab.m1.cell.c2", "US100", [{ name: "second", points: [] }]);
    const src = {
      tabs: [
        {
          id: "m1",
          layout: "2h" as const,
          activeCellId: "m1-c0",
          cells: [
            { id: "m1-c0", symbol: SYMBOL, period: PERIOD, scope: "tab.m1" },
            { id: "c2", symbol: SYMBOL, period: PERIOD, scope: "tab.m1.cell.c2" },
          ],
        },
      ],
      activeTabId: "m1",
    };
    const clone = P.cloneWorkspace(src, mintTab, mintCell);
    const primaryScope = clone.tabs[0].cells[0].scope;
    const nestedScope = clone.tabs[0].cells[1].scope;

    // Each cell's drawing landed under ITS OWN new scope.
    expect(P.loadDrawings(primaryScope, "US100")).toHaveLength(1);
    expect(P.loadDrawings(primaryScope, "US100")[0].name).toBe("primary");
    expect(P.loadDrawings(nestedScope, "US100")[0].name).toBe("second");

    // The leak guard: the nested cell's content lives under its OWN new scope
    // (primaryScope.cell.<newCellId>) — that's correct. The bug we guard against is
    // the OLD nested key (`...cell.c2...`) being duplicated into the clone's PRIMARY
    // scope under the stale `c2` id. Assert no clone key references the old cell id.
    const leaked: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(`auto-trader.${primaryScope}.`) && k.includes(".cell.c2"))
        leaked.push(k);
    }
    expect(leaked).toEqual([]);
    // And the clone's primary scope has exactly ONE drawing key (its own), not two.
    const primaryDrawingKeys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(`auto-trader.${primaryScope}.drawings.`)) primaryDrawingKeys.push(k);
    }
    expect(primaryDrawingKeys).toHaveLength(1);
  });
});

// Per-broker workspace isolation: each data-broker (capital / ig-demo / ig-live) is
// its own platform instance. Roots (tabs/layouts/scratch/recent/templates/alerts)
// are namespaced by broker; scoped per-cell keys and global preferences are not.
describe("per-broker workspace isolation", () => {
  // setPersistBroker is module state; restore the default so later tests are unaffected.
  afterEach(() => P.setPersistBroker("capital"));

  it("roots (tabs) are isolated per broker", () => {
    P.setPersistBroker("capital");
    P.saveTabs([seedTab("cap1")]);
    P.setPersistBroker("ig-demo");
    expect(P.loadTabs()).toBeNull(); // ig-demo starts empty — capital's tabs don't leak
    P.saveTabs([seedTab("ig1")]);
    expect(P.loadTabs()!.map((t) => t.id)).toEqual(["ig1"]);
    // Each broker's tabs live under its own key; switching back restores capital's.
    P.setPersistBroker("capital");
    expect(P.loadTabs()!.map((t) => t.id)).toEqual(["cap1"]);
    expect(localStorage.getItem("auto-trader.b.capital.tabs")).not.toBeNull();
    expect(localStorage.getItem("auto-trader.b.ig-demo.tabs")).not.toBeNull();
  });

  it("alerts are isolated per broker (explicit broker arg)", () => {
    const A = { id: "a1", level: 5, condition: "crossing" as const, trigger: "every" as const, message: "" };
    P.saveAlerts("CS.D.EURUSD.CFD.IP", [A], "ig-demo");
    // Same epic on a different broker (ig-live) is a separate store.
    expect(P.loadAlerts("CS.D.EURUSD.CFD.IP", "ig-live")).toEqual([]);
    expect(P.loadAlerts("CS.D.EURUSD.CFD.IP", "ig-demo").map((a) => a.id)).toEqual(["a1"]);
    expect(localStorage.getItem("auto-trader.b.ig-demo.alerts.CS.D.EURUSD.CFD.IP")).not.toBeNull();
    // loadAllAlerts only scans the requested broker.
    expect(P.loadAllAlerts("ig-demo").map((g) => g.epic)).toEqual(["CS.D.EURUSD.CFD.IP"]);
    expect(P.loadAllAlerts("ig-live")).toEqual([]);
  });

  it("recent symbols and templates are isolated per broker", () => {
    P.setPersistBroker("capital");
    P.pushRecentSymbol("US100");
    P.saveSymbolTemplate({ epic: "US100", indicators: [], indicatorConfigs: {}, drawings: [], avwapAnchors: {}, savedAt: 1 });
    P.setPersistBroker("ig-demo");
    expect(P.loadRecentSymbols()).toEqual([]);
    expect(P.loadSymbolTemplate("US100")).toBeNull();
  });

  it("global preferences are SHARED across brokers (not isolated)", () => {
    P.setPersistBroker("capital");
    P.saveIndicatorDefault("EMA", { calcParams: [21] });
    P.saveFavoriteIndicators(["EMA", "RSI"]);
    P.setPersistBroker("ig-live");
    // Preferences follow the user across brokers — they're not workspace state.
    expect(P.loadIndicatorDefault("EMA")).toEqual({ calcParams: [21] });
    expect(P.loadFavoriteIndicators()).toEqual(["EMA", "RSI"]);
  });

  it("pruneLegacyGlobalWorkspace removes old global roots once, preserving prefs + per-broker keys", () => {
    // Old GLOBAL workspace (pre per-broker) + a global preference + a per-broker key.
    localStorage.setItem("auto-trader.tabs", JSON.stringify([{ id: "t1", symbol: SYMBOL, period: PERIOD }]));
    localStorage.setItem("auto-trader.layout.L1", JSON.stringify({ tabs: [], activeTabId: "" }));
    localStorage.setItem("auto-trader.alerts.US100", JSON.stringify([{ id: "x", level: 1, condition: "crossing" }]));
    localStorage.setItem("auto-trader.template.US100", JSON.stringify({ epic: "US100" }));
    localStorage.setItem("auto-trader.settings", JSON.stringify({ theme: "dark" })); // global pref
    localStorage.setItem("auto-trader.indicatorDefault.EMA", JSON.stringify({ calcParams: [9] })); // global pref
    localStorage.setItem("auto-trader.b.capital.tabs", JSON.stringify([{ id: "c1" }])); // new per-broker key

    expect(P.pruneLegacyGlobalWorkspace()).toBe(true);
    // Old global roots gone.
    expect(localStorage.getItem("auto-trader.tabs")).toBeNull();
    expect(localStorage.getItem("auto-trader.layout.L1")).toBeNull();
    expect(localStorage.getItem("auto-trader.alerts.US100")).toBeNull();
    expect(localStorage.getItem("auto-trader.template.US100")).toBeNull();
    // Global preferences preserved.
    expect(localStorage.getItem("auto-trader.settings")).not.toBeNull();
    expect(localStorage.getItem("auto-trader.indicatorDefault.EMA")).not.toBeNull();
    // Per-broker key preserved.
    expect(localStorage.getItem("auto-trader.b.capital.tabs")).not.toBeNull();
    // Idempotent: a second run is a sentinel-gated no-op.
    expect(P.pruneLegacyGlobalWorkspace()).toBe(false);
  });
});

// The active tab is per-instance, never synced. pickActiveTabId is the rule that
// keeps THIS instance on its own tab when a sibling's edit pushes new tabs in.
describe("pickActiveTabId (per-instance active tab)", () => {
  const tab = (id: string) => ({ id }) as unknown as import("./persist").ChartTab;
  const ws = (ids: string[], seed = "") =>
    ({ tabs: ids.map(tab), activeTabId: seed }) as import("./persist").Workspace;

  it("keeps the instance's own selection when that tab still exists", () => {
    // A sibling renamed a tab → body re-pushed with the SAME tab ids; we must stay put.
    expect(P.pickActiveTabId("b", ws(["a", "b", "c"], "a"))).toBe("b");
  });

  it("falls back to the body seed when the prior selection is gone", () => {
    // e.g. layout/broker switch: prior id belongs to a different workspace.
    expect(P.pickActiveTabId("gone", ws(["a", "b"], "b"))).toBe("b");
  });

  it("falls back to the first tab when neither prior nor seed is valid", () => {
    expect(P.pickActiveTabId("gone", ws(["a", "b"], "alsoGone"))).toBe("a");
    expect(P.pickActiveTabId("", ws(["a", "b"]))).toBe("a");
  });

  it("returns empty for an empty workspace", () => {
    expect(P.pickActiveTabId("anything", ws([]))).toBe("");
  });
});

describe("cell sizes + detach support", () => {
  it("cloneWorkspace preserves the tab's sizes fractions", () => {
    let n = 0;
    const ws: P.Workspace = {
      tabs: [
        {
          id: "t1",
          layout: "2h",
          activeCellId: "t1-c0",
          sizes: { cols: [0.3, 0.7], rows: [1] },
          cells: [
            { id: "t1-c0", symbol: SYMBOL, period: PERIOD, scope: "tab.t1" },
            { id: "c2", symbol: SYMBOL, period: PERIOD, scope: "tab.t1.cell.c2" },
          ],
        },
      ],
      activeTabId: "t1",
    };
    const out = P.cloneWorkspace(ws, () => `nt${++n}`, () => `nc${++n}`);
    expect(out.tabs[0].sizes).toEqual({ cols: [0.3, 0.7], rows: [1] });
  });

  it("copyScopeContent is exported and copies scope keys", () => {
    localStorage.setItem("auto-trader.tab.src.drawings.EPIC", "[1]");
    P.copyScopeContent("tab.src", "tab.dst");
    expect(localStorage.getItem("auto-trader.tab.dst.drawings.EPIC")).toBe("[1]");
  });
});

// The named-layout library (index + bodies) is SHARED across accounts of the same
// broker family (capital/capital-live, ig-demo/ig-live) — see Task 6. Everything
// else (active layout, scratch, autosave, tabs) stays per-feed so each feed still
// opens blank.
describe("named-layout library is shared across a broker family", () => {
  afterEach(() => P.setPersistBroker("capital"));
  beforeEach(() => localStorage.clear());

  const body = (tabId: string) =>
    ({
      tabs: [
        {
          id: tabId,
          layout: "single",
          cells: [{ id: `${tabId}-c0`, symbol: "GOLD", period: "1D", scope: `tab.${tabId}` }],
          activeCellId: `${tabId}-c0`,
          syncSymbol: false, syncInterval: false, syncCrosshair: false, syncTime: false,
          locked: false,
        },
      ],
      activeTabId: tabId,
    }) as unknown as P.Workspace;

  it("capital-live sees the same layouts saved under capital, and vice versa", () => {
    P.setPersistBroker("capital");
    P.saveLayout("L1", "Demo Layout", body("tabA"));

    // capital-live (same family "capital") reads the SAME list
    P.setPersistBroker("capital-live");
    const list = P.loadLayouts();
    expect(list.map((l) => l.name)).toEqual(["Demo Layout"]);
    expect(P.loadLayout("L1")).not.toBeNull();

    // a layout saved on live shows up on demo too (shared)
    P.saveLayout("L2", "Live Layout", body("tabB"));
    P.setPersistBroker("capital");
    expect(P.loadLayouts().map((l) => l.name).sort()).toEqual(["Demo Layout", "Live Layout"]);
  });

  it("a different broker family (ig) does NOT see capital's layouts", () => {
    P.setPersistBroker("capital");
    P.saveLayout("L1", "Demo Layout", body("tabA"));
    P.setPersistBroker("ig-live");
    expect(P.loadLayouts()).toHaveLength(0);
  });

  it("IG keeps its own per-feed layout library (sharing is Capital-only)", () => {
    // ig-demo registers as its own broker with its own saved layouts — the
    // Capital family-share must NOT fold IG into a shared "ig" namespace (that
    // would orphan a user's existing IG layouts). ig-demo reads its OWN layouts,
    // and Capital never sees them.
    P.setPersistBroker("ig-demo");
    P.saveLayout("IG1", "IG Layout", body("tabIg"));
    expect(P.loadLayouts().map((l) => l.name)).toEqual(["IG Layout"]);

    P.setPersistBroker("capital");
    expect(P.loadLayouts()).toHaveLength(0);

    // ig-demo still sees its own layout after the capital round-trip
    P.setPersistBroker("ig-demo");
    expect(P.loadLayouts().map((l) => l.name)).toEqual(["IG Layout"]);
  });
});
