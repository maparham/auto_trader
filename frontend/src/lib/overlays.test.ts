import { describe, it, expect, beforeEach, vi } from "vitest";

// klinecharts' runtime enums (LineType) aren't resolvable under the node test env,
// and overlays.ts reads LineType.Dashed at module load. We only need the enum value
// to exist — stub the package's runtime surface (types are erased at compile time).
vi.mock("klinecharts", () => ({
  LineType: { Solid: "solid", Dashed: "dashed" },
}));

// node env: provide in-memory localStorage before importing the modules (same idiom
// as persist.test.ts — OverlayManager.persist() writes through persist.ts).
class MemStorage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
(globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage();

const { OverlayManager, asDrawingExtra } = await import("./overlays");
const P = await import("./persist");
const { alertsChanged } = await import("./signals");

// Minimal faithful stand-in for a klinecharts Chart: the only 4 methods
// OverlayManager calls (createOverlay/getOverlayById/overrideOverlay/removeOverlay),
// backed by an in-memory overlay map that mirrors klinecharts' merge-on-override.
class FakeChart {
  overlays = new Map<string, Record<string, unknown>>();
  private seq = 0;
  createOverlay(spec: Record<string, unknown>) {
    const id = `ov_${++this.seq}`;
    this.overlays.set(id, { id, ...spec });
    return id;
  }
  getOverlayById(id: string) { return this.overlays.get(id) ?? null; }
  overrideOverlay(o: { id: string } & Record<string, unknown>) {
    const cur = this.overlays.get(o.id);
    if (cur) this.overlays.set(o.id, { ...cur, ...o });
  }
  removeOverlay(id: string) {
    const cur = this.overlays.get(id);
    this.overlays.delete(id); // delete first so the onRemoved → persist doesn't see it
    const cb = cur?.onRemoved;
    if (typeof cb === "function") (cb as (e: { overlay: unknown }) => void)({ overlay: cur });
  }
  // hoverAlert toggles the crosshair's horizontal guide. It does so by merging into
  // the chart STORE (not chart.setStyles, which would jolt the whole view via
  // adjustPaneViewport). Model both: _chartStore.setOptions is the real path, and
  // setStyles is the fallback. setStylesCalls counts the fallback so a regression
  // back to the heavyweight call is caught.
  crosshairHorizontalShow: boolean | undefined;
  setStylesCalls = 0;
  _chartStore = {
    setOptions: (o: { styles?: { crosshair?: { horizontal?: { show?: boolean } } } }) => {
      const show = o?.styles?.crosshair?.horizontal?.show;
      if (typeof show === "boolean") this.crosshairHorizontalShow = show;
    },
  };
  styles: Record<string, unknown> = {};
  setStyles(s: { crosshair?: { horizontal?: { show?: boolean } } } & Record<string, unknown>) {
    this.setStylesCalls += 1;
    const show = s?.crosshair?.horizontal?.show;
    if (typeof show === "boolean") this.crosshairHorizontalShow = show;
    this.styles = { ...this.styles, ...s };
  }
}

function setup() {
  const chart = new FakeChart();
  const m = new OverlayManager();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  m.attach(chart as any);
  m.setScope("tab.A");
  m.setEpic("US100");
  m.rehydrate(); // real cells always rehydrate on mount; arms persist()'s epic guard
  return { chart, m };
}

beforeEach(() => localStorage.clear());

describe("OverlayManager per-interval visibility (data-corruption guards)", () => {
  it("visible intent survives an interval where the drawing is filtered out", () => {
    const { chart, m } = setup();
    m.setResolution("HOUR");
    const id = m.addDrawing("segment", [{ value: 1 }, { value: 2 }])!;

    // User pins the drawing to 1H only, and wants it visible.
    m.setVisibleIntervals(id, ["HOUR"]);
    m.setVisible(id, true);
    expect(chart.getOverlayById(id)!.visible).toBe(true); // effective: on, 1H matches

    // Switch to a 5m chart → effective visibility goes false (filtered out)...
    m.setResolution("MINUTE_5");
    expect(chart.getOverlayById(id)!.visible).toBe(false);

    // ...and ANY edit fires persist() here. If persist sampled the effective flag,
    // it would save visible=false and corrupt the user's intent. Trigger one:
    m.setText(id, "noted");

    // Switch back to 1H → the drawing must REAPPEAR (intent was preserved).
    m.setResolution("HOUR");
    expect(chart.getOverlayById(id)!.visible).toBe(true);

    // And the persisted record carries INTENT (true), not the filtered flag.
    const saved = P.loadDrawings("tab.A", "US100").find((d) => d.extendData);
    expect(asDrawingExtra(saved!.extendData).userVisible).toBe(true);
  });

  it("getDrawing().visible returns intent, not the interval-filtered flag", () => {
    const { m } = setup();
    m.setResolution("HOUR");
    const id = m.addDrawing("segment", [{ value: 1 }, { value: 2 }])!;
    m.setVisible(id, true);
    m.setVisibleIntervals(id, ["MINUTE_5"]); // not the current interval → effective off
    expect(m.getDrawing(id)!.visible).toBe(true); // checkbox/clone must see intent
  });
});

describe("OverlayManager alert hover/select line-weight sync (sidebar ↔ chart)", () => {
  const lineSize = (chart: FakeChart, id: string) =>
    (chart.getOverlayById(id)!.styles as { line?: { size?: number } } | undefined)?.line?.size;

  it("hoverAlert emphasizes the line and surfaces `hovered`; clearing restores it", () => {
    const { chart, m } = setup();
    const id = m.addAlert(50, { condition: "crossing", trigger: "once", message: "" })!;
    expect(lineSize(chart, id)).toBe(1); // resting weight
    expect(m.getAlerts().find((a) => a.id === id)!.hovered).toBe(false);

    m.hoverAlert(id);
    expect(lineSize(chart, id)).toBe(2); // emphasized on hover
    expect(m.getAlerts().find((a) => a.id === id)!.hovered).toBe(true);
    expect(chart.crosshairHorizontalShow).toBe(false); // horizontal guide hidden over the line

    m.hoverAlert(null);
    expect(lineSize(chart, id)).toBe(1); // back to resting
    expect(m.getAlerts().find((a) => a.id === id)!.hovered).toBe(false);
    expect(chart.crosshairHorizontalShow).toBe(true); // guide restored on un-hover

    // The crosshair toggle must NOT go through chart.setStyles — that runs
    // adjustPaneViewport(forceY) and jolts the whole view on every hover. It must
    // route through the store instead (regression guard for the hover-jolt fix).
    expect(chart.setStylesCalls).toBe(0);
  });

  it("un-hovering a SELECTED line keeps it emphasized (states don't fight)", () => {
    const { chart, m } = setup();
    const id = m.addAlert(50, { condition: "crossing", trigger: "once", message: "" })!;
    m.selectAlert(id);
    expect(lineSize(chart, id)).toBe(2); // selected → thick

    m.hoverAlert(id); // both selected and hovered
    expect(lineSize(chart, id)).toBe(2);
    m.hoverAlert(null); // still selected → must stay thick
    expect(lineSize(chart, id)).toBe(2);

    m.selectAlert(null); // now neither → thin
    expect(lineSize(chart, id)).toBe(1);
  });
});

describe("OverlayManager alert-level rounding (no raw cursor-pixel floats)", () => {
  const RAW = 70.64347166211272;

  it("addAlert quantizes the level to the instrument precision on write", () => {
    const { chart, m } = setup();
    m.setPricePrecision(2);
    const id = m.addAlert(RAW, { condition: "crossing", trigger: "every", message: "" })!;
    expect(chart.getOverlayById(id)!.points).toEqual([{ value: 70.64 }]);
    expect(m.getAlert(id)!.level).toBe(70.64);
  });

  it("updateAlert quantizes too (edit-modal save path)", () => {
    const { m } = setup();
    m.setPricePrecision(2);
    const id = m.addAlert(10, { condition: "crossing", trigger: "every", message: "" })!;
    m.updateAlert(id, RAW, { condition: "crossing", trigger: "every", message: "" });
    expect(m.getAlert(id)!.level).toBe(70.64);
  });

  it("getAlert rounds on READ so legacy raw-stored alerts show clean in the modal", () => {
    const { chart, m } = setup();
    // Simulate an alert stored before rounding-on-write existed: write raw directly.
    const id = m.addAlert(RAW, { condition: "crossing", trigger: "every", message: "" })!;
    expect(chart.getOverlayById(id)!.points).toEqual([{ value: RAW }]); // raw on disk (precision unset)
    m.setPricePrecision(2);
    expect(m.getAlert(id)!.level).toBe(70.64); // but the modal sees it clean
  });

  it("leaves the level raw when precision is unknown (no wrong-default mangling)", () => {
    const { m } = setup();
    const id = m.addAlert(RAW, { condition: "crossing", trigger: "every", message: "" })!;
    expect(m.getAlert(id)!.level).toBe(RAW);
  });
});

// The stable id is the join key the engine relies on to tell "same alert moved"
// from "different alert". This guards the overlay HALF of that contract: a drag /
// edit must persist the SAME id, not mint a new one (the seam where the
// drag-deletes-the-alert bug lived). See alert-identity-redesign.md.
describe("OverlayManager alert identity (stable id survives drag/edit)", () => {
  const cfg = { condition: "crossing" as const, trigger: "every" as const, message: "" };

  it("addAlert persists a stable id and updateAlert keeps it across a move", () => {
    const { m } = setup();
    const ovId = m.addAlert(100, cfg)!;
    const id1 = P.loadAlerts("US100")[0].id;
    expect(id1).toBeTruthy();

    m.updateAlert(ovId, 104, { ...cfg, trigger: "once" }); // move + reconfigure
    const saved = P.loadAlerts("US100");
    expect(saved).toHaveLength(1);
    expect(saved[0].id).toBe(id1); // identity survives the edit
    expect(saved[0].level).toBe(104);
  });

  it("reconcileAlerts drops a line by id when the engine removed it from storage", () => {
    const { chart, m } = setup();
    const ovId = m.addAlert(100, cfg)!;
    expect(chart.getOverlayById(ovId)).not.toBeNull();

    // Engine fired a "once" and wrote survivors=[] (the id is gone from storage).
    P.saveAlerts("US100", []);
    m.reconcileAlerts();
    expect(chart.getOverlayById(ovId)).toBeNull(); // line removed off the id mismatch
  });
});

// The alerts sidebar's "go to chart" navigation selects a line on a (possibly
// just-opened) chart. Two guards: the saved-id ↔ overlay-id lookups the sidebar/App
// use to find the line, and selection SURVIVING a same-epic rehydrate — without
// that, a dev double-mount (or a live data refresh) re-mints overlay ids and
// silently drops the just-applied selection (the bug this navigation feature hit).
describe("OverlayManager alert lookup + selection survives rehydrate (sidebar nav)", () => {
  const cfg = { condition: "crossing" as const, trigger: "every" as const, message: "" };

  it("findAlertOverlayId maps a stored saved-id to the live overlay id", () => {
    const { m } = setup();
    const ovId = m.addAlert(100, cfg)!;
    const savedId = P.loadAlerts("US100")[0].id;
    expect(m.findAlertOverlayId(savedId)).toBe(ovId);
    expect(m.findAlertOverlayId("no-such-id")).toBeNull();
  });

  it("findAlertOverlayIdByMatch resolves a history row by condition + level", () => {
    const { m } = setup();
    m.setPricePrecision(2);
    const ovId = m.addAlert(70.64, cfg)!;
    expect(m.findAlertOverlayIdByMatch("crossing", 70.64, 2)).toBe(ovId);
    expect(m.findAlertOverlayIdByMatch("less", 70.64, 2)).toBeNull(); // condition differs
    expect(m.findAlertOverlayIdByMatch("crossing", 71, 2)).toBeNull(); // level differs
  });

  it("a selected alert stays selected (by saved id) across a same-epic rehydrate", () => {
    const { chart, m } = setup();
    const ovId = m.addAlert(100, cfg)!;
    m.selectAlert(ovId);
    expect(m.getSelectedAlertId()).toBe(ovId);

    // A second rehydrate (dev double-mount / live data refresh) re-mints overlay ids.
    m.rehydrate();
    const newOvId = m.findAlertOverlayId(P.loadAlerts("US100")[0].id)!;
    expect(newOvId).not.toBe(ovId); // id was genuinely re-minted
    expect(m.getSelectedAlertId()).toBe(newOvId); // selection followed the alert
    const size = (chart.getOverlayById(newOvId)!.styles as { line?: { size?: number } }).line?.size;
    expect(size).toBe(2); // and the line is drawn emphasized
  });

  it("selection drops cleanly if the selected alert is gone after rehydrate", () => {
    const { m } = setup();
    const ovId = m.addAlert(100, cfg)!;
    m.selectAlert(ovId);
    P.saveAlerts("US100", []); // alert removed (e.g. a fired "once")
    m.rehydrate();
    expect(m.getSelectedAlertId()).toBeNull();
  });
});

// Alerts are GLOBAL per epic: two cells of one tab showing the SAME epic (a split
// layout, both mounted at once) share one stored list. reconcileAlerts must keep
// each cell's lines in sync with that list — add a peer's new alert, follow a moved
// level — AND a cell's persist() must write the COMPLETE list so it never drops a
// peer's alert. This is the regression the per-epic redesign introduced and this
// reconcile-as-full-resync fixes.
describe("OverlayManager global alerts shared across same-epic cells", () => {
  const cfg = { condition: "crossing" as const, trigger: "every" as const, message: "" };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const priceLines = (c: FakeChart) => [...c.overlays.values()].filter((o: any) => o.name === "priceLine");

  function twoCells() {
    const ca = new FakeChart();
    const a = new OverlayManager();
    a.attach(ca as unknown as Parameters<OverlayManager["attach"]>[0]);
    a.setScope("tab.T"); // primary cell
    a.setEpic("US100");
    a.rehydrate();
    const cb = new FakeChart();
    const b = new OverlayManager();
    b.attach(cb as unknown as Parameters<OverlayManager["attach"]>[0]);
    b.setScope("tab.T.cell.c1"); // second cell, SAME epic, different scope
    b.setEpic("US100");
    b.rehydrate();
    return { a, ca, b, cb };
  }

  it("an alert added in one cell materialises in the other on reconcile", () => {
    const { a, b, cb } = twoCells();
    a.addAlert(100, cfg);
    expect(priceLines(cb)).toHaveLength(0); // B hasn't reconciled yet
    b.reconcileAlerts(); // the alerts signal would call this
    const lines = priceLines(cb);
    expect(lines).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((lines[0] as any).points[0].value).toBe(100);
  });

  it("a second cell's persist() does NOT drop the first cell's alert", () => {
    const { a, b } = twoCells();
    a.addAlert(100, cfg); // storage: [100]
    b.reconcileAlerts(); // B now mirrors [100]
    b.addAlert(200, cfg); // B persists its full set — must still include 100
    expect(P.loadAlerts("US100").map((x) => x.level).sort((p, q) => p - q)).toEqual([100, 200]);
  });

  it("a level moved in one cell re-levels the line in the other", () => {
    const { a, b, cb } = twoCells();
    const ovId = a.addAlert(100, cfg)!;
    b.reconcileAlerts();
    a.updateAlert(ovId, 105, cfg); // drag/edit in A → storage 105
    b.reconcileAlerts();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((priceLines(cb)[0] as any).points[0].value).toBe(105);
  });

  it("an alert deleted in one cell disappears from the other", () => {
    const { a, b, cb } = twoCells();
    const ovId = a.addAlert(100, cfg)!;
    b.reconcileAlerts();
    expect(priceLines(cb)).toHaveLength(1);
    a.remove(ovId); // delete in A
    b.reconcileAlerts();
    expect(priceLines(cb)).toHaveLength(0);
  });

  it("a notify-only edit in one cell is synced to the other (not reverted on its next persist)", () => {
    const { a, b } = twoCells();
    const ovId = a.addAlert(100, cfg)!; // notify defaults: all on
    b.reconcileAlerts(); // B mirrors [100] with notify all-on
    // A mutes ONLY the sound channel (level/condition/trigger/message unchanged).
    a.updateAlert(ovId, 100, { ...cfg, notify: { toast: true, browser: true, sound: false } });
    b.reconcileAlerts(); // B must pull the notify change in...
    // ...so when B persists (adds another alert), it writes the muted notify, not stale all-on.
    b.addAlert(200, cfg);
    const at100 = P.loadAlerts("US100").find((x) => x.level === 100)!;
    expect(at100.notify.sound).toBe(false);
  });
});

// The symbol-change window: setEpic advances this.epic, but the old epic's overlays
// linger in `entries` until the async data load + rehydrate(). A stray persist() in
// that window must NOT write the old overlays under the NEW epic's (global, shared)
// alert key. persist() bails while hydratedEpic !== epic.
describe("OverlayManager symbol-change persist guard", () => {
  const cfg = { condition: "crossing" as const, trigger: "every" as const, message: "" };

  it("a persist during the setEpic→rehydrate window does not corrupt the new epic's alerts", () => {
    const { m } = setup(); // US100, rehydrated
    m.addAlert(100, cfg); // US100 storage = [100]
    expect(P.loadAlerts("US100").map((x) => x.level)).toEqual([100]);

    // Symbol changes: epic advances, but rehydrate() hasn't run for BTCUSD yet.
    m.setEpic("BTCUSD");
    m.addAlert(200, cfg); // triggers persist() while hydratedEpic=US100 != BTCUSD

    // BTCUSD's shared list must be untouched (not clobbered with US100's overlays).
    expect(P.loadAlerts("BTCUSD")).toEqual([]);
    // US100's list is likewise not rewritten in the window.
    expect(P.loadAlerts("US100").map((x) => x.level)).toEqual([100]);

    // After BTCUSD rehydrates, persistence resumes normally.
    m.rehydrate();
    m.addAlert(300, cfg);
    expect(P.loadAlerts("BTCUSD").map((x) => x.level)).toEqual([300]);
  });
});

// reconcileAlerts removes overlays whose onRemoved synchronously re-fires the alerts
// signal this cell subscribes to (ChartCore wires `alertsChanged -> reconcileAlerts`).
// The re-entrancy guard must keep that from recursing into itself / leaking the
// hydrating guard and writing a half-removed list back to the shared key.
describe("OverlayManager reconcile re-entrancy (self-triggered alerts signal)", () => {
  const cfg = { condition: "crossing" as const, trigger: "every" as const, message: "" };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const priceLines = (c: FakeChart) => [...c.overlays.values()].filter((o: any) => o.name === "priceLine");

  it("removing multiple alerts via a wired signal terminates and doesn't resurrect storage", () => {
    const { chart, m } = setup();
    m.addAlert(100, cfg);
    m.addAlert(200, cfg); // US100 storage = [100, 200], two lines drawn
    // Wire the cell's reconcile to the GLOBAL signal exactly as ChartCore does.
    const unsub = alertsChanged.subscribe(() => m.reconcileAlerts());
    // Engine clears the stored list, then signals a reconcile.
    P.saveAlerts("US100", []);
    expect(() => m.reconcileAlerts()).not.toThrow(); // no infinite recursion
    unsub();
    expect(priceLines(chart)).toHaveLength(0); // both lines removed
    expect(P.loadAlerts("US100")).toEqual([]); // not rewritten by a mid-removal persist
  });
});

describe("OverlayManager setExtend preserves extendData (text + intervals survive name-swap)", () => {
  it("text and pinned intervals ride through segment -> ray -> straight", () => {
    const { m } = setup();
    m.setResolution("HOUR");
    let id = m.addDrawing("segment", [{ value: 1 }, { value: 2 }])!;
    m.setText(id, "LABEL");
    m.setShowMiddle(id, true);
    m.setVisibleIntervals(id, ["HOUR"]);

    // Extend right (segment -> rayLine): new id, but extendData must survive.
    id = m.setExtend(id, "ray")!;
    let ex = asDrawingExtra(m.getDrawing(id)!.extendData);
    expect(ex.text).toBe("LABEL");
    expect(ex.showMiddle).toBe(true);
    expect(ex.intervals).toEqual(["HOUR"]);

    // Extend both (rayLine -> straightLine): still survives.
    id = m.setExtend(id, "both")!;
    ex = asDrawingExtra(m.getDrawing(id)!.extendData);
    expect(ex.text).toBe("LABEL");
    expect(ex.intervals).toEqual(["HOUR"]);
  });
});
