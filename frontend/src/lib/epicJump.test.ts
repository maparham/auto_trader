import { describe, it, expect, vi } from "vitest";
import { jumpToEpic, type EpicJumpDeps } from "./epicJump";
import type { ChartTab } from "./persist";
import type { Instrument } from "./feed";

const inst = (epic: string): Instrument => ({ epic, name: `${epic} Inc`, status: "TRADEABLE", type: "SHARES" });

// A tab store whose reads see writes at once, as App's refs do.
function harness(initial: string[] = [], resolveImpl?: (epic: string) => Promise<Instrument>) {
  let n = 0;
  const mk = (symbol: Instrument): ChartTab => {
    const id = `t${n++}`;
    return { id, layout: "1", activeCellId: `${id}c`, cells: [{ id: `${id}c`, symbol, period: { resolution: "DAY", label: "1D" }, scope: id }] } as ChartTab;
  };
  let tabs = initial.map((e) => mk(inst(e)));
  let active = tabs[0]?.id ?? "";
  const replaying = new Set<string>();
  const resolve = vi.fn(resolveImpl ?? (async (epic: string) => inst(epic)));
  const deps: EpicJumpDeps = {
    tabs: () => tabs,
    activeId: () => active,
    applyTabs: (fn) => { tabs = fn(tabs); },
    setActive: (id) => { active = id; },
    openTab: (symbol) => { const t = mk(symbol); tabs = [...tabs, t]; active = t.id; return t; },
    resolve,
    isReplaying: (id) => replaying.has(id),
  };
  return { deps, resolve, replaying, tabs: () => tabs, active: () => active };
}

describe("jumpToEpic", () => {
  it("focuses an open epic without touching the catalogue", async () => {
    const h = harness(["AAPL", "MU"]);
    const r = await jumpToEpic(h.deps, "MU");
    expect(r).toEqual({ cellId: "t1c", tabId: "t1", opened: false });
    expect(h.active()).toBe("t1");
    expect(h.resolve).not.toHaveBeenCalled();
  });

  it("opens an unopened epic on its resolved instrument", async () => {
    const h = harness(["AAPL"]);
    const r = await jumpToEpic(h.deps, "MU", 4);
    expect(h.resolve).toHaveBeenCalledWith("MU", 4);
    expect(r.opened).toBe(true);
    expect(h.tabs().map((t) => t.cells[0].symbol)).toEqual([inst("AAPL"), inst("MU")]);
    expect(h.active()).toBe(r.tabId);
  });

  it("opens one tab when two jumps to the same epic overlap", async () => {
    const h = harness(["AAPL"]);
    const [a, b] = await Promise.all([jumpToEpic(h.deps, "MU"), jumpToEpic(h.deps, "MU")]);
    expect(h.tabs()).toHaveLength(2);
    expect(b.tabId).toBe(a.tabId);
  });

  it("reuses the tab an overlapping same-tab jump opened", async () => {
    const h = harness(["AAPL"]);
    let reuse: string | null = null;
    const slot = { get: () => reuse, opened: (id: string) => { reuse = id; } };
    await Promise.all([jumpToEpic(h.deps, "MU", 2, slot), jumpToEpic(h.deps, "INTC", 2, slot)]);
    expect(h.tabs()).toHaveLength(2);
    expect(h.tabs()[1].cells[0].symbol.epic).toBe("INTC");
  });

  it("opens a new tab instead of reusing a replaying cell", async () => {
    const h = harness(["AAPL"]);
    h.replaying.add("t0c");
    await jumpToEpic(h.deps, "MU", 2, { get: () => "t0", opened: () => {} });
    expect(h.tabs().map((t) => t.cells[0].symbol.epic)).toEqual(["AAPL", "MU"]);
  });
});
