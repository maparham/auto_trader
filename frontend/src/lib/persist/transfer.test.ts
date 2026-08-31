import { beforeEach, describe, expect, it } from "vitest";
import { installMemStorage, type MemStorage } from "../testMemStorage";
import { exportLayout, importLayout, type LayoutExportV1 } from "./transfer";
import { saveLayout, loadLayouts, loadLayout, type Workspace } from "./workspace";
import { ns, primaryCellScope, cellScope } from "./core";

let storage: MemStorage;

beforeEach(() => {
  storage = installMemStorage();
});

const SYM = { epic: "US100", name: "US 100", status: null } as never;
const SYM2 = { epic: "DE40", name: "Germany 40", status: null } as never;
const P15 = { resolution: "MINUTE_15", label: "15m" } as never;
const P1H = { resolution: "HOUR", label: "1h" } as never;

let tSeq = 0;
let cSeq = 0;
const mintTabId = () => `t-new-${++tSeq}`;
const mintCellId = () => `c-new-${++cSeq}`;

// A two-cell tab: cell0 on the primary scope, cell1 nested — the shape that
// exercises the primary-scope-is-a-prefix-of-nested-scopes subtlety.
function seedLayout(id: string, name: string): Workspace {
  const tabId = `T-${id}`;
  const s0 = primaryCellScope(tabId);
  const s1 = cellScope(tabId, "C1");
  const ws: Workspace = {
    tabs: [
      {
        id: tabId,
        layout: "2h",
        activeCellId: "C1",
        syncCrosshair: true,
        sizes: { cols: [0.3, 0.7], rows: [1] },
        cells: [
          { id: `${tabId}-c0`, symbol: SYM, period: P15, scope: s0 },
          { id: "C1", symbol: SYM2, period: P1H, scope: s1 },
        ],
      },
    ],
    activeTabId: "",
  };
  saveLayout(id, name, ws);
  localStorage.setItem(ns(s0, "drawings"), JSON.stringify([{ name: "segment" }]));
  localStorage.setItem(ns(s0, "indicators"), JSON.stringify([{ id: "EMA" }]));
  localStorage.setItem(ns(s1, "drawings"), JSON.stringify([{ name: "ray" }]));
  localStorage.setItem(ns(s1, "indicatorConfig"), JSON.stringify({ EMA: { calcParams: [21] } }));
  return ws;
}

describe("exportLayout", () => {
  it("returns null for an unknown layout id", () => {
    expect(exportLayout("nope")).toBeNull();
  });

  it("captures the workspace body and every cell scope's content", () => {
    seedLayout("L1", "Alpha");
    const data = exportLayout("L1")!;
    expect(data.format).toBe("auto-trader.layout");
    expect(data.version).toBe(1);
    expect(data.name).toBe("Alpha");
    expect(data.workspace.tabs).toHaveLength(1);
    const s0 = primaryCellScope("T-L1");
    const s1 = cellScope("T-L1", "C1");
    expect(JSON.parse(data.scopes[s0].drawings)).toEqual([{ name: "segment" }]);
    expect(JSON.parse(data.scopes[s0].indicators)).toEqual([{ id: "EMA" }]);
    expect(JSON.parse(data.scopes[s1].drawings)).toEqual([{ name: "ray" }]);
    expect(JSON.parse(data.scopes[s1].indicatorConfig)).toEqual({
      EMA: { calcParams: [21] },
    });
    // The nested cell's keys belong to ITS scope entry only — the primary scope
    // map must not drag them in via the prefix overlap.
    expect(Object.keys(data.scopes[s0]).some((k) => k.startsWith("cell."))).toBe(false);
  });
});

describe("importLayout", () => {
  it("rejects malformed payloads without writing anything", () => {
    const before = storage.length;
    expect(importLayout(null, mintTabId, mintCellId)).toBeNull();
    expect(importLayout({}, mintTabId, mintCellId)).toBeNull();
    expect(
      importLayout({ format: "other", version: 1, name: "x", workspace: { tabs: [] }, scopes: {} }, mintTabId, mintCellId),
    ).toBeNull();
    expect(storage.length).toBe(before);
  });

  it("round-trips a layout into a fresh browser under fresh ids", () => {
    seedLayout("L1", "Alpha");
    const data = exportLayout("L1")!;

    // A different machine: nothing in storage.
    storage = installMemStorage();
    const res = importLayout(JSON.parse(JSON.stringify(data)), mintTabId, mintCellId)!;
    expect(res).not.toBeNull();
    expect(res.name).toBe("Alpha");
    expect(loadLayouts()).toEqual([{ id: res.id, name: "Alpha" }]);

    const ws = loadLayout(res.id)!;
    expect(ws.tabs).toHaveLength(1);
    const tab = ws.tabs[0];
    expect(tab.id).not.toBe("T-L1"); // fresh ids
    expect(tab.layout).toBe("2h");
    expect(tab.syncCrosshair).toBe(true);
    expect(tab.sizes).toEqual({ cols: [0.3, 0.7], rows: [1] });
    expect(tab.cells.map((c) => c.symbol.epic)).toEqual(["US100", "DE40"]);
    expect(tab.cells.map((c) => c.period.label)).toEqual(["15m", "1h"]);
    // cell0 sits on the tab's primary scope; cell1 on its own nested scope.
    expect(tab.cells[0].scope).toBe(primaryCellScope(tab.id));
    expect(tab.cells[1].scope).toBe(cellScope(tab.id, tab.cells[1].id));
    // The active cell survives the id remap.
    expect(tab.activeCellId).toBe(tab.cells[1].id);

    // Scope content landed under the NEW scopes.
    expect(JSON.parse(localStorage.getItem(ns(tab.cells[0].scope, "drawings"))!)).toEqual([
      { name: "segment" },
    ]);
    expect(JSON.parse(localStorage.getItem(ns(tab.cells[1].scope, "drawings"))!)).toEqual([
      { name: "ray" },
    ]);
    expect(
      JSON.parse(localStorage.getItem(ns(tab.cells[1].scope, "indicatorConfig"))!),
    ).toEqual({ EMA: { calcParams: [21] } });
    // Nothing left addressed to the OLD scopes.
    expect(localStorage.getItem(ns(primaryCellScope("T-L1"), "drawings"))).toBeNull();
  });

  it("suffixes the name when it collides with an existing layout", () => {
    seedLayout("L1", "Alpha");
    const data = exportLayout("L1")!;
    const res1 = importLayout(data, mintTabId, mintCellId)!;
    expect(res1.name).toBe("Alpha (imported)");
    const res2 = importLayout(data, mintTabId, mintCellId)!;
    expect(res2.name).toBe("Alpha (imported 2)");
    expect(new Set([res1.id, res2.id, "L1"]).size).toBe(3);
  });

  it("skips scope values that are not valid JSON instead of failing the import", () => {
    seedLayout("L1", "Alpha");
    const data = exportLayout("L1")! as LayoutExportV1;
    const s0 = primaryCellScope("T-L1");
    data.scopes[s0].drawings = "{not json";
    storage = installMemStorage();
    const res = importLayout(data, mintTabId, mintCellId)!;
    const tab = loadLayout(res.id)!.tabs[0];
    expect(localStorage.getItem(ns(tab.cells[0].scope, "drawings"))).toBeNull();
    expect(localStorage.getItem(ns(tab.cells[0].scope, "indicators"))).not.toBeNull();
  });
});
