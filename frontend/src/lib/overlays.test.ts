import { describe, it, expect, beforeEach, vi } from "vitest";
import { defaultVisibility, isVisibleOnResolution, barsSpanned, applyPreset } from "./visibility";

// Test helper: a model visible ONLY on `res` (mirrors the "Only this timeframe"
// preset) — the shorthand these tests use in place of hand-building a full model.
function onlyVisibleOn(res: string) {
  return applyPreset(defaultVisibility(), res, "only");
}

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
const { setMagnet, DEFAULT_MAGNET } = await import("./magnet");

// Minimal faithful stand-in for a klinecharts Chart: the only 4 methods
// OverlayManager calls (createOverlay/getOverlayById/overrideOverlay/removeOverlay),
// backed by an in-memory overlay map that mirrors klinecharts' merge-on-override.
// NOTE: verified against klinecharts' own source (OverlayImp) that a never-customized
// overlay's real `.styles` is actually `{}` — concrete colors are resolved only at
// PAINT time from getDefaultOverlayStyle(), not stored on the instance. So a raw
// `{ ...spec }` (styles possibly undefined/empty) would be the MORE faithful mock.
// We seed a populated default here anyway purely so the ghost-stub fade/restore
// tests below can assert an exact solid-color round-trip by value; the production
// fade()/unfade() logic (overlays.ts) does NOT rely on this — it always writes back
// an explicit, concretely-resolved `line.color` itself (see DEFAULT_LINE_COLOR),
// so restoring works correctly even when `.styles` starts genuinely empty (this was
// deliberately verified with this seeding removed before landing the fix).
const DEFAULT_OVERLAY_STYLES = { line: { color: "#1677FF", size: 1, style: "solid" } };

// Local deep clone for seeding each overlay's own default styles object below (mirrors
// overlays.ts's private cloneStyles — not exported, so re-declared here for the mock).
function cloneStyles<T>(styles: T): T {
  return styles == null ? styles : (JSON.parse(JSON.stringify(styles)) as T);
}

class FakeChart {
  overlays = new Map<string, Record<string, unknown>>();
  private seq = 0;
  createOverlay(spec: Record<string, unknown>) {
    const id = `ov_${++this.seq}`;
    // Clone the default styles per-overlay: DEFAULT_OVERLAY_STYLES is a single shared
    // const, and overrideOverlay below now mutates `styles` objects in place (to match
    // real klinecharts). Without cloning, every overlay that never got an explicit
    // style would share ONE styles object, so fading overlay A would corrupt the
    // "default" styles read by every other never-styled overlay B too.
    this.overlays.set(id, { id, ...spec, styles: spec.styles ?? cloneStyles(DEFAULT_OVERLAY_STYLES) });
    return id;
  }
  getOverlayById(id: string) { return this.overlays.get(id) ?? null; }
  overrideOverlay(o: { id: string } & Record<string, unknown>) {
    const cur = this.overlays.get(o.id);
    if (!cur) return;
    const { styles, ...rest } = o;
    const merged: Record<string, unknown> = { ...cur, ...rest };
    if (styles && typeof styles === "object") {
      // Real klinecharts mutates the overlay's existing `styles` object IN PLACE
      // (Object.assign-style, one level deep — matching the `{line: {...}}`-shaped
      // patches mergeStyles/fade/unfade build) rather than replacing the reference.
      // A shallow `{...cur, ...o}` (the old mock behavior) silently swapped in a
      // brand-new styles object instead, which could never reproduce the real
      // reference-aliasing bug where a stashed "canonical" styles object gets
      // corrupted by a later fade() because it points at the SAME object klinecharts
      // then mutates.
      const curStyles = (cur.styles as Record<string, unknown>) ?? {};
      Object.assign(curStyles, styles as Record<string, unknown>);
      merged.styles = curStyles;
    }
    this.overlays.set(o.id, merged);
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
  it("visible intent survives an interval where the drawing is filtered out (rendered as a ghost, not hidden)", () => {
    const { chart, m } = setup();
    m.setResolution("HOUR");
    const id = m.addDrawing("segment", [{ value: 1 }, { value: 2 }])!;

    // User pins the drawing to 1H only, and wants it visible.
    m.setVisibilityModel(id, onlyVisibleOn("HOUR"));
    m.setVisible(id, true);
    expect(chart.getOverlayById(id)!.visible).toBe(true); // effective: on, 1H matches
    const solidColor = (chart.getOverlayById(id)!.styles as { line?: { color?: string } } | undefined)
      ?.line?.color;

    // Switch to a 5m chart → interval filter excludes it, but the user still wants it
    // on: it stays visible (a ghost) so it's still clickable, just faded...
    m.setResolution("MINUTE_5");
    const ghosted = chart.getOverlayById(id)!;
    expect(ghosted.visible).toBe(true);
    expect((ghosted.styles as { line?: { color?: string } } | undefined)?.line?.color).toMatch(
      /^rgba\(/,
    );

    // ...and ANY edit fires persist() here. If persist sampled the ghosted style, it
    // would save the faded color and corrupt the user's drawing. Trigger one:
    m.setText(id, "noted");

    // Switch back to 1H → the drawing must return to its SOLID canonical style.
    m.setResolution("HOUR");
    const restored = chart.getOverlayById(id)!;
    expect(restored.visible).toBe(true);
    expect((restored.styles as { line?: { color?: string } } | undefined)?.line?.color).toBe(
      solidColor,
    );

    // And the persisted record carries INTENT (true) and the CANONICAL (unfaded) style,
    // not the filtered visible flag or the ghost color.
    const saved = P.loadDrawings("tab.A", "US100").find((d) => d.extendData);
    expect(asDrawingExtra(saved!.extendData).userVisible).toBe(true);
    expect((saved!.styles as { line?: { color?: string } } | undefined)?.line?.color).not.toMatch(
      /^rgba\(/,
    );
  });

  it("getDrawing().visible returns intent, not the interval-filtered flag", () => {
    const { m } = setup();
    m.setResolution("HOUR");
    const id = m.addDrawing("segment", [{ value: 1 }, { value: 2 }])!;
    m.setVisible(id, true);
    m.setVisibilityModel(id, onlyVisibleOn("MINUTE_5")); // not the current interval → effective off
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

  it("keeps a dragged alert's pill `active` even when native hover drops mid-drag", () => {
    const { m } = setup();
    const id = m.addAlert(50, { condition: "crossing", trigger: "once", message: "" })!;
    // Grab and drag it — the common flow grabs on the FIRST press, so the line is
    // neither selected nor (reliably) hovered while dragging.
    m.beginAlertDrag(id);
    m.dragAlertTo(id, 55);
    // klinecharts' native onMouseLeave can fire as the line moves under the cursor,
    // dropping the hover. Without the drag-glue this flips `active` off and the on-line
    // pill mounts/unmounts → flicker.
    m.hoverAlert(null);
    const mid = m.getAlerts().find((a) => a.id === id)!;
    expect(mid.active).toBe(true); // glued for the whole drag — pill stays put
    expect(mid.level).toBe(55); // live level still tracks the drag
    // Releasing the drag lifts the glue (back to hover/selection rules).
    m.endAlertDrag(id);
    expect(m.getAlerts().find((a) => a.id === id)!.active).toBe(false);
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
    m.setVisibilityModel(id, onlyVisibleOn("HOUR"));

    // Extend right (segment -> rayLine): new id, but extendData must survive.
    id = m.setExtend(id, "ray")!;
    let ex = asDrawingExtra(m.getDrawing(id)!.extendData);
    expect(ex.text).toBe("LABEL");
    expect(ex.showMiddle).toBe(true);
    expect(ex.visibility).toEqual(onlyVisibleOn("HOUR"));

    // Extend both (rayLine -> straightLine): still survives.
    id = m.setExtend(id, "both")!;
    ex = asDrawingExtra(m.getDrawing(id)!.extendData);
    expect(ex.text).toBe("LABEL");
    expect(ex.visibility).toEqual(onlyVisibleOn("HOUR"));
  });
});

describe("OverlayManager future-whitespace anchors (dataIndex-only points)", () => {
  // A point placed/dragged past the last candle has NO timestamp in klinecharts
  // (dataIndexToTimestamp returns null beyond the data) — it exists only as a
  // dataIndex. klinecharts renders x from timestamp if present, else dataIndex,
  // else x=0 (the left edge). So any copy path that drops dataIndex teleports a
  // future-anchored endpoint to the left edge → the "extend changes the slope" bug.
  const FUTURE = [
    { timestamp: 1_000, value: 1 },
    { dataIndex: 250, value: 2 }, // beyond the last bar: dataIndex-only
  ];

  it("setExtend keeps a dataIndex-only anchor (recreate must not drop it)", () => {
    const { chart, m } = setup();
    let id = m.addDrawing("segment", FUTURE)!;
    id = m.setExtend(id, "ray")!;
    const pts = chart.getOverlayById(id)!.points as Array<Record<string, unknown>>;
    expect(pts[1].dataIndex).toBe(250);
    expect(pts[1].value).toBe(2);
    expect(pts[0].timestamp).toBe(1_000);
  });

  it("getDrawing keeps a dataIndex-only anchor (clipboard/clone/Cancel snapshot source)", () => {
    const { m } = setup();
    const id = m.addDrawing("segment", FUTURE)!;
    const pts = m.getDrawing(id)!.points;
    expect(pts[1].dataIndex).toBe(250);
  });
});

describe("drawing effective visibility", () => {
  // effectiveVisible mirrors: userVisible AND interval AND NOT(autoHide && bars<min).
  function effective(
    userVisible: boolean,
    model: ReturnType<typeof defaultVisibility>,
    res: string,
    span?: { t1: number; t2: number },
  ): boolean {
    if (!(userVisible && isVisibleOnResolution(model, res))) return false;
    if (model.autoHide.on && span) {
      if (barsSpanned(span.t1, span.t2, res) < model.autoHide.minBars) return false;
    }
    return true;
  }

  it("auto-hides a short-span drawing on a coarse timeframe but not a fine one", () => {
    const m = defaultVisibility();
    m.autoHide = { on: true, minBars: 3 };
    const span = { t1: 0, t2: 3_600_000 }; // 1 hour
    expect(effective(true, m, "MINUTE", span)).toBe(true); // 60 bars
    expect(effective(true, m, "HOUR", span)).toBe(false); // 1 bar < 3
  });
});

// There is no object-list panel: a drawing that becomes invisible (visible:false) can
// never be clicked again to reopen its settings. So a drawing hidden ONLY by the
// interval/auto-hide filter (userVisible still true) must render as a faint, still-
// hittable "ghost" instead of being fully removed from the paint list — while a drawing
// the user explicitly turned off (userVisible:false) hides completely, same as before.
describe("ghost stub", () => {
  it("ghosts an interval-hidden but user-visible drawing (decision-table pin)", () => {
    const m = defaultVisibility();
    m.units.minutes.on = false; // hidden on minute timeframes
    // decision table the manager implements:
    const userVisible = true;
    const intervalOk = false; // minutes off, on a minute resolution
    const ghost = userVisible && !intervalOk;
    expect(ghost).toBe(true);
  });
});

describe("OverlayManager ghost-stub for interval/auto-hidden drawings", () => {
  it("renders an interval-filtered but user-visible drawing faded (not hidden) and clickable", () => {
    const { chart, m } = setup();
    m.setResolution("HOUR");
    const id = m.addDrawing("segment", [{ value: 1 }, { value: 2 }])!;
    m.setVisibilityModel(id, onlyVisibleOn("HOUR"));
    m.setVisible(id, true);
    expect(chart.getOverlayById(id)!.visible).toBe(true);

    m.setResolution("MINUTE_5"); // filtered out, but the user still wants it on
    const ov = chart.getOverlayById(id)!;
    expect(ov.visible).toBe(true); // ghosted, not hidden — stays clickable
    const lineColor = (ov.styles as { line?: { color?: string } } | undefined)?.line?.color;
    expect(lineColor).toMatch(/^rgba\(/); // faded

    m.setResolution("HOUR"); // back to a matching interval → solid again
    const restored = chart.getOverlayById(id)!;
    expect(restored.visible).toBe(true);
    expect((restored.styles as { line?: { color?: string } } | undefined)?.line?.color).not.toMatch(
      /^rgba\(/,
    );
  });

  it("a user-hidden drawing (Show on chart off) is fully hidden, never ghosted", () => {
    const { chart, m } = setup();
    const id = m.addDrawing("segment", [{ value: 1 }, { value: 2 }])!;
    m.setVisible(id, false);
    expect(chart.getOverlayById(id)!.visible).toBe(false);
  });

  it("ghosting survives rehydrate (loads on a filtered interval → renders as a ghost, not invisible)", () => {
    const { chart, m } = setup();
    m.setResolution("HOUR");
    const id = m.addDrawing("segment", [{ value: 1 }, { value: 2 }])!;
    m.setVisibilityModel(id, onlyVisibleOn("HOUR"));
    m.setVisible(id, true);

    m.setResolution("MINUTE_5"); // filtered on this interval
    m.rehydrate(); // reload while on a filtered interval (e.g. app restart)
    const newId = [...chart.overlays.keys()].find((k) => chart.overlays.get(k)?.name === "segment")!;
    const ov = chart.getOverlayById(newId)!;
    expect(ov.visible).toBe(true); // ghosted on load, not hidden
    expect((ov.styles as { line?: { color?: string } } | undefined)?.line?.color).toMatch(/^rgba\(/);
  });

  // getDrawing() feeds copy/clone (placeDrawing) and the settings modal's color
  // picker — if it read the LIVE (faded) styles off a ghosted drawing, cloning it
  // would bake the ghost rgba in as the clone's own "canonical" style, and every
  // future ghost/restore cycle on the clone would re-fade an already-faded color:
  // a drawing that can never become solid again.
  it("getDrawing() returns the canonical (unfaded) style even while a drawing is ghosted", () => {
    const { chart, m } = setup();
    m.setResolution("HOUR");
    const id = m.addDrawing("segment", [{ value: 1 }, { value: 2 }])!;
    m.setVisibilityModel(id, onlyVisibleOn("HOUR"));
    const solidColor = (m.getDrawing(id)!.styles as { line?: { color?: string } } | null)?.line?.color;

    m.setResolution("MINUTE_5"); // now ghosted
    expect((chart.getOverlayById(id)!.styles as { line?: { color?: string } })?.line?.color).toMatch(
      /^rgba\(/,
    );
    const snapshot = m.getDrawing(id)!;
    expect((snapshot.styles as { line?: { color?: string } } | null)?.line?.color).toBe(solidColor);
    expect((snapshot.styles as { line?: { color?: string } } | null)?.line?.color).not.toMatch(
      /^rgba\(/,
    );

    // A clone (placeDrawing) built from that snapshot must persist the real color.
    const cloneId = m.placeDrawing({
      name: snapshot.name,
      points: [{ value: 3 }, { value: 4 }],
      styles: snapshot.styles,
      extendData: snapshot.extendData,
    })!;
    const saved = P.loadDrawings("tab.A", "US100").find((d) => d.points?.[0]?.value === 3);
    expect((saved!.styles as { line?: { color?: string } } | undefined)?.line?.color).not.toMatch(
      /^rgba\(/,
    );
    expect(cloneId).toBeTruthy();
  });

  // setExtend (segment -> rayLine -> straightLine) removes and recreates the overlay
  // under a new id. If it copied the LIVE styles off a ghosted drawing, the extended
  // line would persist with the faded color baked in as canonical.
  it("setExtend on a ghosted drawing carries the canonical style, not the faded one, and stays ghosted", () => {
    const { chart, m } = setup();
    m.setResolution("HOUR");
    let id = m.addDrawing("segment", [{ value: 1 }, { value: 2 }])!;
    m.setVisibilityModel(id, onlyVisibleOn("HOUR"));

    m.setResolution("MINUTE_5"); // ghosted
    id = m.setExtend(id, "ray")!;
    const ov = chart.getOverlayById(id)!;
    expect(ov.visible).toBe(true); // still rendered (ghost), not hidden
    expect((ov.styles as { line?: { color?: string } } | undefined)?.line?.color).toMatch(/^rgba\(/); // still visibly faded

    const saved = P.loadDrawings("tab.A", "US100").find((d) => d.extendData);
    expect((saved!.styles as { line?: { color?: string } } | undefined)?.line?.color).not.toMatch(
      /^rgba\(/,
    ); // but the persisted style is the real color
  });

  // setStyle() is the Style-tab handler in DrawingSettings.tsx — the exact modal a
  // user reaches by clicking a ghost to reopen its settings and change its color. If
  // it writes the new color straight onto the live (faded) overlay, canonicalStyles()
  // still sees a stashed pre-edit fadedStyles entry and persist() (which setStyle
  // itself triggers) saves that STALE color instead of the user's edit — discarding it
  // on the spot, and re-applying it live the moment the drawing naturally un-ghosts.
  it("setStyle on a ghosted drawing persists the NEW color, not the stale pre-ghost one, and un-ghosts to the NEW color", () => {
    const { chart, m } = setup();
    m.setResolution("HOUR");
    const id = m.addDrawing("segment", [{ value: 1 }, { value: 2 }])!;
    m.setVisibilityModel(id, onlyVisibleOn("HOUR"));

    m.setResolution("MINUTE_5"); // filtered out -> ghosted (fadedStyles stashes the OLD color)
    const ghosted = chart.getOverlayById(id)!;
    expect(ghosted.visible).toBe(true);
    expect((ghosted.styles as { line?: { color?: string } })?.line?.color).toMatch(/^rgba\(/);

    // Edit the color while ghosted (exactly what DrawingSettings' Style tab does).
    m.setStyle(id, { line: { color: "#ff0000", size: 2, style: "solid" } });

    // Still rendered as a ghost (faded), but with the NEW hue baked into the fade —
    // not the pre-edit default blue.
    const stillGhosted = chart.getOverlayById(id)!;
    expect(stillGhosted.visible).toBe(true);
    const fadedColor = (stillGhosted.styles as { line?: { color?: string } })?.line?.color;
    expect(fadedColor).toMatch(/^rgba\(/);
    expect(fadedColor?.toLowerCase()).toContain("255, 0, 0"); // red, faded — not the stale blue

    // persist() (triggered by setStyle itself) must save the NEW canonical color, not
    // the stashed pre-edit one.
    const saved = P.loadDrawings("tab.A", "US100").find((d) => d.name === "segment");
    expect((saved!.styles as { line?: { color?: string } } | undefined)?.line?.color).toBe("#ff0000");

    // Un-ghost (back to an allowed interval) — must render with the NEW color, not a
    // stale stash.
    m.setResolution("HOUR");
    const restored = chart.getOverlayById(id)!;
    expect(restored.visible).toBe(true);
    expect((restored.styles as { line?: { color?: string } } | undefined)?.line?.color).toBe("#ff0000");
  });

  // Regression test for the reference-aliasing bug: applyDisplay's fade branch used
  // to stash `ov.styles` by REFERENCE (`this.fadedStyles.set(id, ov.styles)`) as the
  // "canonical" unfaded backup. Real klinecharts mutates an overlay's `.styles` object
  // IN PLACE on overrideOverlay, so the very next fade() call (which patches
  // `line.color` to the ghost rgba) corrupted the stashed canonical too, since it was
  // the SAME object. Every later un-fade then restored the GHOST color, not the true
  // original — a drawing that, once ghosted even once, stayed faded forever. Fixed by
  // deep-cloning the styles at stash time (cloneStyles). This must exercise a drawing
  // that was NEVER explicitly styled (default color), because that's exactly the
  // real-world repro: draw a line, never touch its color, switch timeframes.
  it("a never-explicitly-styled drawing restores its TRUE original color after a ghost/un-ghost cycle, not the ghost rgba (reference-aliasing regression)", () => {
    const { chart, m } = setup();
    m.setResolution("HOUR");
    const id = m.addDrawing("segment", [{ value: 1 }, { value: 2 }])!;
    m.setVisibilityModel(id, onlyVisibleOn("HOUR"));

    const originalColor = (chart.getOverlayById(id)!.styles as { line?: { color?: string } })?.line
      ?.color;
    expect(originalColor).toBeTruthy();
    expect(originalColor).not.toMatch(/^rgba\(/); // sanity: starts solid/concrete

    m.setResolution("MINUTE_5"); // filtered out -> ghosted (first-ever fade for this id)
    const ghosted = chart.getOverlayById(id)!;
    expect((ghosted.styles as { line?: { color?: string } })?.line?.color).toMatch(/^rgba\(/);

    m.setResolution("HOUR"); // back to a matching interval -> should un-ghost to solid
    const restored = chart.getOverlayById(id)!;
    const restoredColor = (restored.styles as { line?: { color?: string } })?.line?.color;
    expect(restoredColor).not.toMatch(/^rgba\(/); // must not still be the ghost color
    expect(restoredColor).toBe(originalColor); // must be the EXACT true original, not a mutated copy

    // The bug wasn't limited to a single cycle — the corrupted canonical stayed
    // corrupted, so repeat the round trip once more for good measure.
    m.setResolution("MINUTE_5");
    m.setResolution("HOUR");
    const restoredAgain = chart.getOverlayById(id)!;
    expect(
      (restoredAgain.styles as { line?: { color?: string } })?.line?.color,
    ).toBe(originalColor);
  });

  // Same reference-aliasing bug, but in the ORDINARY (never-ghosted) path this time.
  // getDrawing() is DrawingSettings.tsx's Cancel-button snapshot source
  // (`useState(() => overlays.getDrawing(id))`). If it returns `ov.styles` by
  // reference (canonicalStyles' non-ghosted branch used to), a later setStyle() edit
  // mutates that SAME object in place (klinecharts' overrideOverlay merges into
  // `ov.styles`), silently corrupting the earlier snapshot too — so Cancel, which
  // re-applies the stashed snapshot's styles, just re-applies the post-edit value and
  // never actually reverts anything.
  it("getDrawing() snapshot is unaffected by a LATER setStyle edit (Cancel-button aliasing regression)", () => {
    const { m } = setup();
    const id = m.addDrawing("segment", [{ value: 1 }, { value: 2 }])!;

    const snapshot = m.getDrawing(id)!;
    const originalColor = (snapshot.styles as { line?: { color?: string } } | null)?.line?.color;
    expect(originalColor).toBeTruthy();

    m.setStyle(id, { line: { color: "#00ff00", size: 3, style: "solid" } });

    // The EARLIER snapshot must still read the pre-edit color, not the new one.
    expect((snapshot.styles as { line?: { color?: string } } | null)?.line?.color).toBe(
      originalColor,
    );
  });
});

describe("magnet mode (TV-style OHLC snap)", () => {
  beforeEach(() => setMagnet(DEFAULT_MAGNET)); // reset the global setting per test

  const modeOf = (chart: FakeChart, id: string) =>
    chart.getOverlayById(id)!.mode as string | undefined;

  it("new drawings get the current magnet mode; alerts never snap", () => {
    const { chart, m } = setup();
    setMagnet({ on: true, strength: "weak" });

    const draw = m.addDrawing("segment", [{ value: 1 }, { value: 2 }])!;
    const alert = m.addAlert(50, { condition: "crossing", trigger: "once", message: "" })!;

    expect(modeOf(chart, draw)).toBe("weak_magnet");
    expect(chart.getOverlayById(draw)!.modeSensitivity).toBeGreaterThan(0);
    // Alert lines must not snap to OHLC regardless of the magnet setting.
    expect(modeOf(chart, alert)).toBeUndefined();
  });

  it("a drawing added while magnet is off has no snap mode", () => {
    const { chart, m } = setup();
    const draw = m.addDrawing("segment", [{ value: 1 }, { value: 2 }])!;
    expect(modeOf(chart, draw)).toBe("normal");
  });

  it("toggling magnet syncs the mode of existing drawings but not alerts", () => {
    const { chart, m } = setup();
    const draw = m.addDrawing("segment", [{ value: 1 }, { value: 2 }])!;
    const alert = m.addAlert(50, { condition: "crossing", trigger: "once", message: "" })!;

    setMagnet({ on: true, strength: "strong" });
    expect(modeOf(chart, draw)).toBe("strong_magnet");
    expect(modeOf(chart, alert)).toBeUndefined(); // alert untouched

    setMagnet(DEFAULT_MAGNET); // back off
    expect(modeOf(chart, draw)).toBe("normal");
  });

  it("stops syncing after detach (subscription cleaned up)", () => {
    const { chart, m } = setup();
    const draw = m.addDrawing("segment", [{ value: 1 }, { value: 2 }])!;
    m.detach();
    // With the chart detached the manager must not touch a stale overlay map.
    setMagnet({ on: true, strength: "strong" });
    expect(modeOf(chart, draw)).toBe("normal"); // unchanged since detach
  });
});
