// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { installMemStorage } from "../lib/testMemStorage";
import { saveLayout, saveDefaultLayoutId, type Workspace } from "../lib/persist";
import { mirroredWorkspace, flattenCells, isWorkspaceKey } from "./mobileWorkspace";

installMemStorage();

const cell = (id: string, epic: string, scope: string) => ({
  id, symbol: { epic, name: epic }, period: { resolution: "MINUTE_5", label: "5m" }, scope,
});

const ws = (tabs: unknown[]): Workspace =>
  ({ tabs, activeTabId: "" }) as unknown as Workspace;

describe("mobileWorkspace", () => {
  beforeEach(() => localStorage.clear());

  it("mirrors the default-marked saved layout", () => {
    saveLayout("l1", "first", ws([{ id: "t1", layout: "1", cells: [cell("c1", "US100", "s1")], activeCellId: "c1" }]));
    saveLayout("l2", "main", ws([{ id: "t2", layout: "1", cells: [cell("c2", "GOLD", "s2")], activeCellId: "c2" }]));
    saveDefaultLayoutId("l2");
    const m = mirroredWorkspace();
    expect(m?.name).toBe("main");
    expect(m?.ws.tabs[0].cells[0].symbol.epic).toBe("GOLD");
  });

  it("falls back to the first saved layout without a default", () => {
    saveLayout("l1", "first", ws([{ id: "t1", layout: "1", cells: [cell("c1", "US100", "s1")], activeCellId: "c1" }]));
    expect(mirroredWorkspace()?.name).toBe("first");
  });

  it("returns null with no saved layouts", () => {
    expect(mirroredWorkspace()).toBeNull();
  });

  it("flattens tabs into ordered cells with tab indexes", () => {
    const w = ws([
      { id: "t1", layout: "2h", cells: [cell("c1", "US100", "s1"), cell("c2", "GOLD", "s2")], activeCellId: "c1" },
      { id: "t2", layout: "1", cells: [cell("c3", "IBM", "s3")], activeCellId: "c3" },
    ]);
    expect(flattenCells(w).map((f) => [f.tabIndex, f.cell.symbol.epic])).toEqual(
      [[0, "US100"], [0, "GOLD"], [1, "IBM"]],
    );
  });

  it("classifies workspace-affecting persist keys", () => {
    expect(isWorkspaceKey("auto-trader.f.capital.layouts")).toBe(true);
    expect(isWorkspaceKey("auto-trader.f.capital.layout.layout-abc")).toBe(true);
    expect(isWorkspaceKey("auto-trader.b.capital.defaultLayoutId")).toBe(true);
    expect(isWorkspaceKey("auto-trader.b.capital.view.US100")).toBe(false);
    expect(isWorkspaceKey("auto-trader.tab.t1.drawings.US100")).toBe(false);
  });
});
