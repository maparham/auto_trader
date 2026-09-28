// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { installMemStorage } from "../lib/testMemStorage";
import {
  saveLayout,
  loadLayout,
  loadLayouts,
  loadDefaultLayoutId,
  deleteLayout,
  PREFIX,
  type Workspace,
} from "../lib/persist";
import { setMobileLayout, mobileWorkspaceVersion } from "./mobileWorkspace";
import {
  addMobileTab,
  closeMobileTab,
  setMobileTabOrder,
  setMobileTabSymbol,
  UNDO_MS,
} from "./mobileLayoutEdit";

installMemStorage();
const P = { resolution: "HOUR", label: "1H" } as const;
const tab = (id: string, ...epics: string[]) => ({
  id,
  layout: epics.length > 1 ? "2h" : "1",
  activeCellId: `${id}-c0`,
  cells: epics.map((epic, i) => ({ id: `${id}-c${i}`, symbol: { epic, name: epic }, period: P, scope: i ? `tab.${id}.cell.${id}-c${i}` : `tab.${id}` })),
});
const ws = (...tabs: unknown[]) => ({ tabs, activeTabId: "" }) as unknown as Workspace;
const epics = (id = "a") => loadLayout(id)!.tabs.map((t) => t.cells[0].symbol.epic);

describe("mobileLayoutEdit", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    saveLayout("a", "Main", ws(tab("t1", "US100"), tab("t2", "GOLD"), tab("t3", "EURUSD", "GBPUSD")));
  });
  afterEach(() => vi.useRealTimers());

  it("adds a one-chart tab at the end and bumps the version", () => {
    const v = mobileWorkspaceVersion.value;
    const t = addMobileTab({ epic: "NVDA", name: "NVDA", status: null, pricePrecision: 2 }, P);
    expect(epics()).toEqual(["US100", "GOLD", "EURUSD", "NVDA"]);
    expect(t.cells[0].scope).toBe(`tab.${t.id}`);
    expect(mobileWorkspaceVersion.value).toBeGreaterThan(v);
  });

  it("with no saved layout, adds into a new default layout named Mobile", () => {
    localStorage.clear();
    addMobileTab({ epic: "NVDA", name: "NVDA", status: null, pricePrecision: 2 }, P);
    const [meta] = loadLayouts();
    expect(meta.name).toBe("Mobile");
    expect(loadDefaultLayoutId()).toBe(meta.id);
    expect(loadLayout(meta.id)!.tabs).toHaveLength(1);
  });

  it("sets the tab order, ignoring unknown ids and keeping unlisted tabs after", () => {
    setMobileTabOrder(["t3", "gone", "t1"]);
    expect(epics()).toEqual(["EURUSD", "US100", "GOLD"]);
  });

  it("an unchanged order writes nothing", () => {
    const v = mobileWorkspaceVersion.value;
    setMobileTabOrder(["t1", "t2", "t3"]);
    expect(mobileWorkspaceVersion.value).toBe(v);
  });

  it("changes the symbol of a single-chart tab, keeping its scope", () => {
    setMobileTabSymbol("t2", { epic: "SILVER", name: "SILVER", status: null, pricePrecision: 2 });
    const c = loadLayout("a")!.tabs[1].cells[0];
    expect(c.symbol.epic).toBe("SILVER");
    expect(c.scope).toBe("tab.t2");
    setMobileTabSymbol("t3", { epic: "X", name: "X", status: null, pricePrecision: 2 });
    expect(loadLayout("a")!.tabs[2].cells[0].symbol.epic).toBe("EURUSD");
  });

  it("refuses to close the last tab or a missing one", () => {
    saveLayout("a", "Main", ws(tab("t1", "US100")));
    expect(closeMobileTab("t1")).toBeNull();
    expect(closeMobileTab("nope")).toBeNull();
  });

  it("close removes the tab now and purges its scope only after UNDO_MS", () => {
    localStorage.setItem(`${PREFIX}.tab.t2.drawings`, "[1]");
    closeMobileTab("t2");
    expect(epics()).toEqual(["US100", "EURUSD"]);
    expect(localStorage.getItem(`${PREFIX}.tab.t2.drawings`)).toBe("[1]");
    vi.advanceTimersByTime(UNDO_MS);
    expect(localStorage.getItem(`${PREFIX}.tab.t2.drawings`)).toBeNull();
  });

  it("undo restores the tab at its old index with its content", () => {
    localStorage.setItem(`${PREFIX}.tab.t2.drawings`, "[1]");
    const undo = closeMobileTab("t2")!;
    undo();
    vi.advanceTimersByTime(UNDO_MS);
    expect(epics()).toEqual(["US100", "GOLD", "EURUSD"]);
    expect(localStorage.getItem(`${PREFIX}.tab.t2.drawings`)).toBe("[1]");
  });

  it("undo lands in the layout the tab came from, even after a layout switch", () => {
    saveLayout("b", "Swing", ws(tab("s1", "DE40")));
    const undo = closeMobileTab("t2")!;
    setMobileLayout("b");
    undo();
    expect(epics("a")).toEqual(["US100", "GOLD", "EURUSD"]);
    expect(epics("b")).toEqual(["DE40"]);
  });

  it("a second undo call does nothing", () => {
    const undo = closeMobileTab("t2")!;
    undo();
    undo();
    expect(epics()).toEqual(["US100", "GOLD", "EURUSD"]);
  });

  it("skips the purge when a concurrent save still has the tab (close reverted underneath it)", () => {
    localStorage.setItem(`${PREFIX}.tab.t2.drawings`, "[1]");
    closeMobileTab("t2");
    // A concurrent desktop write re-saves the layout with t2 back in it
    // before the undo window elapses.
    saveLayout("a", "Main", ws(tab("t1", "US100"), tab("t2", "GOLD"), tab("t3", "EURUSD", "GBPUSD")));
    vi.advanceTimersByTime(UNDO_MS);
    expect(localStorage.getItem(`${PREFIX}.tab.t2.drawings`)).toBe("[1]");
  });

  it("undo re-arms the purge when the layout is gone by the time it fires", () => {
    localStorage.setItem(`${PREFIX}.tab.t2.drawings`, "[1]");
    const undo = closeMobileTab("t2")!;
    deleteLayout("a"); // t2 was already removed from "a", so this doesn't purge it itself
    undo(); // restoring editLayout("a", ...) fails: the layout no longer exists
    expect(localStorage.getItem(`${PREFIX}.tab.t2.drawings`)).toBe("[1]");
    vi.advanceTimersByTime(UNDO_MS);
    expect(localStorage.getItem(`${PREFIX}.tab.t2.drawings`)).toBeNull();
  });
});
