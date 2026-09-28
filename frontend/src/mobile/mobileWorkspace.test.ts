// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { installMemStorage } from "../lib/testMemStorage";
import { saveLayout, saveDefaultLayoutId, isDeviceLocalKey, type Workspace } from "../lib/persist";
import {
  mirroredWorkspace,
  flattenCells,
  isWorkspaceKey,
  setMobileLayout,
  mobileLayoutList,
  mobileWorkspaceVersion,
  MOBILE_LAYOUT_KEY,
} from "./mobileWorkspace";

installMemStorage();

const cell = (id: string, epic: string, scope: string) => ({
  id, symbol: { epic, name: epic }, period: { resolution: "MINUTE_5", label: "5m" }, scope,
});

const wsTabs = (tabs: unknown[]): Workspace =>
  ({ tabs, activeTabId: "" }) as unknown as Workspace;

const ws = (epic: string): Workspace =>
  ({
    tabs: [{ id: `t-${epic}`, layout: "1", activeCellId: "c", cells: [{ id: "c", symbol: { epic, name: epic }, period: { resolution: "HOUR", label: "1H" }, scope: `tab.t-${epic}` }] }],
    activeTabId: "",
  }) as unknown as Workspace;

describe("mobileWorkspace", () => {
  beforeEach(() => localStorage.clear());

  it("returns null with no saved layouts", () => {
    expect(mirroredWorkspace()).toBeNull();
  });

  it("flattens tabs into ordered cells with tab indexes", () => {
    const w = wsTabs([
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

describe("mobile layout choice", () => {
  beforeEach(() => {
    localStorage.clear();
    saveLayout("a", "Main", ws("US100"));
    saveLayout("b", "Swing", ws("GOLD"));
  });

  it("defaults to the desktop default layout, else the first", () => {
    expect(mirroredWorkspace()?.id).toBe("a");
    saveDefaultLayoutId("b");
    expect(mirroredWorkspace()?.id).toBe("b");
  });

  it("a mobile pick wins over the default, and bumps the version", () => {
    saveDefaultLayoutId("a");
    const v = mobileWorkspaceVersion.value;
    setMobileLayout("b");
    expect(mirroredWorkspace()).toMatchObject({ id: "b", name: "Swing" });
    expect(mobileWorkspaceVersion.value).toBe(v + 1);
  });

  it("falls back when the picked layout was deleted", () => {
    setMobileLayout("gone");
    expect(mirroredWorkspace()?.id).toBe("a");
  });

  it("the pick is device-local, never mirrored", () => {
    expect(isDeviceLocalKey(MOBILE_LAYOUT_KEY)).toBe(true);
  });

  it("lists the saved layouts", () => {
    expect(mobileLayoutList().map((l) => l.name)).toEqual(["Main", "Swing"]);
  });
});
