import { describe, it, expect, beforeEach } from "vitest";

// vitest runs in the 'node' env (see vite.config.ts), so provide a tiny in-memory
// localStorage before importing the module under test.
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

  it("alerts and avwap anchors are scope+epic keyed", () => {
    P.saveAlerts("tab.A", "US100", [
      { id: "a1", level: 5, condition: "crossing", trigger: "every", message: "" },
    ]);
    P.saveAvwapAnchor("tab.A", "US100", "AVWAP", 123);
    expect(P.loadAlerts("tab.A", "US100")).toHaveLength(1);
    expect(P.loadAlerts("tab.B", "US100")).toEqual([]);
    expect(P.loadAvwapAnchor("tab.A", "US100", "AVWAP")).toBe(123);
    expect(P.loadAvwapAnchor("tab.B", "US100", "AVWAP")).toBe(0);
  });

  it("primaryCellScope / cellScope produce the documented prefixes", () => {
    expect(P.primaryCellScope("t1")).toBe("tab.t1");
    expect(P.cellScope("t1", "c2")).toBe("tab.t1.cell.c2");
  });
});

describe("loadTabs migration (v1 single-chart → cell-based)", () => {
  it("wraps a pre-cells tab into one primary cell, preserving symbol/period", () => {
    localStorage.setItem(
      "auto-trader.tabs",
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
      "auto-trader.tabs",
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
    localStorage.setItem("auto-trader.tabs", JSON.stringify(cellBased));
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
    expect(localStorage.getItem("auto-trader.template.US100")).not.toBeNull();
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

describe("migrateToNamedLayouts", () => {
  it("wraps an existing bare `tabs` workspace into a named default and retires the bare keys", () => {
    localStorage.setItem(
      "auto-trader.tabs",
      JSON.stringify([{ id: "t1", symbol: SYMBOL, period: PERIOD }]),
    );
    localStorage.setItem("auto-trader.activeTab", JSON.stringify("t1"));

    expect(P.migrateToNamedLayouts()).toBe(true);
    const layouts = P.loadLayouts();
    expect(layouts).toHaveLength(1);
    expect(P.loadDefaultLayoutId()).toBe(layouts[0].id);
    expect(P.loadActiveLayoutId()).toBe(layouts[0].id);
    // Bare keys retired so the workspace isn't double-sourced.
    expect(localStorage.getItem("auto-trader.tabs")).toBeNull();
    expect(localStorage.getItem("auto-trader.activeTab")).toBeNull();
    // The migrated layout body carries the (migrated, cell-based) tab.
    expect(P.loadLayout(layouts[0].id)?.tabs[0].cells).toHaveLength(1);
  });

  it("is a no-op once a layouts index exists, and for a fresh install", () => {
    P.saveLayout("L1", "X", { tabs: [seedTab("t1")], activeTabId: "t1" });
    expect(P.migrateToNamedLayouts()).toBe(false);

    localStorage.clear();
    expect(P.migrateToNamedLayouts()).toBe(false); // fresh install → stays blank
    expect(P.loadLayouts()).toEqual([]);
  });
});
