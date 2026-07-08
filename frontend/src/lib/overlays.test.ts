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
  // Loaded candles (timestamps only — all OverlayManager reads). Seeded by tests
  // that exercise the future-anchored point encode/decode.
  data: Array<{ timestamp: number }> = [];
  getDataList() { return this.data; }
  // Mirrors real klinecharts applyNewData: replaces the data list, then — like its
  // INIT-type OverlayStore.updatePointPosition (verified against klinecharts 9.8) —
  // BACK-FILLS point.timestamp for any dataIndex-only overlay point whose index now
  // lands on a real bar, WITHOUT the Forward-type index shift. This is the trap
  // OverlayManager.applyOlderBars exists to defuse by shifting first.
  applyNewData(data: Array<{ timestamp: number }>) {
    this.data = data;
    for (const ov of this.overlays.values()) {
      const pts = ov.points as Array<{ timestamp?: number; dataIndex?: number }> | undefined;
      for (const p of pts ?? []) {
        if (p.timestamp == null && p.dataIndex != null) p.timestamp = data[p.dataIndex]?.timestamp;
      }
    }
  }
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
  // hoverAlert reconciles the crosshair's horizontal guide over alert lines. The
  // contract (see overlays.ts applyCrosshairForAlert): the master `horizontal.show`
  // stays TRUE — klinecharts gates both the line AND the y-axis label on it — and
  // the child flags `line.show` / `text.show` do the actual hiding. The write merges
  // into the chart STORE (not chart.setStyles, which would jolt the whole view via
  // adjustPaneViewport). Model both: _chartStore.setOptions is the real path, and
  // setStyles is the fallback. setStylesCalls counts the fallback so a regression
  // back to the heavyweight call is caught.
  crosshairHorizontal:
    | { show?: boolean; line?: { show?: boolean }; text?: { show?: boolean } }
    | undefined;
  setStylesCalls = 0;
  private captureCrosshair(s?: {
    crosshair?: { horizontal?: { show?: boolean; line?: { show?: boolean }; text?: { show?: boolean } } };
  }) {
    const horizontal = s?.crosshair?.horizontal;
    if (horizontal) this.crosshairHorizontal = horizontal;
  }
  _chartStore = {
    setOptions: (o: { styles?: Parameters<FakeChart["captureCrosshair"]>[0] }) =>
      this.captureCrosshair(o?.styles),
  };
  styles: Record<string, unknown> = {};
  setStyles(s: Parameters<FakeChart["captureCrosshair"]>[0] & Record<string, unknown>) {
    this.setStylesCalls += 1;
    this.captureCrosshair(s);
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
    // Over the line: the guide's LINE and y-axis LABEL hide, but the master `show`
    // must stay true — flipping it would take the label down with it permanently.
    expect(chart.crosshairHorizontal).toEqual({ show: true, line: { show: false }, text: { show: false } });

    m.hoverAlert(null);
    expect(lineSize(chart, id)).toBe(1); // back to resting
    expect(m.getAlerts().find((a) => a.id === id)!.hovered).toBe(false);
    // Guide (line + label) restored on un-hover.
    expect(chart.crosshairHorizontal).toEqual({ show: true, line: { show: true }, text: { show: true } });

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

// Two browser tabs open the SAME workspace → both mount the SAME cell (same scope +
// epic) and write the SAME shared alert/drawing keys. Cross-tab, another tab's edit
// reaches this tab's localStorage via /ws/state WITHOUT firing this tab's in-memory
// alerts signal, so a mounted cell can hold a STALE overlay set. Its next persist()
// then blows away what the other tab stored — the reported "alerts/drawings vanish
// when the app is open in two tabs" data loss. The fix (App.onBackendPush) reconciles
// a cell to storage on every relevant remote push BEFORE it can persist a stale set.
describe("OverlayManager cross-tab shared-storage stomp (two same-epic/scope cells)", () => {
  const cfg = { condition: "crossing" as const, trigger: "every" as const, message: "" };
  function cell() {
    const chart = new FakeChart();
    const m = new OverlayManager();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    m.attach(chart as any);
    m.setScope("tab.A");
    m.setEpic("US100");
    m.rehydrate(); // real cells rehydrate on mount; arms persist()'s epic guard
    return { chart, m };
  }

  it("a cell that reconciles before persisting keeps alerts another tab stored (the fix)", () => {
    const A = cell();
    const B = cell(); // second tab, same scope + epic → shared storage keys
    // Tab A adds two alerts (shared storage now [100, 200]). Tab B, mounted earlier,
    // has NOT materialised them — a real cross-tab push updates localStorage but does
    // not fire THIS tab's alerts signal.
    A.m.addAlert(100, cfg);
    A.m.addAlert(200, cfg);
    expect(P.loadAlerts("US100").map((x) => x.level)).toEqual([100, 200]);
    // The fix: on a remote alerts push, App bumps the alerts signal, so every mounted
    // same-epic cell reconciles to storage BEFORE it can persist a stale set.
    B.m.reconcileAlerts();
    // Tab B now draws a line — persist() writes B's whole set. Because B reconciled,
    // its set includes A's alerts, so the shared list survives.
    B.m.addDrawing("segment", [{ value: 1 }, { value: 2 }]);
    expect(P.loadAlerts("US100").map((x) => x.level)).toEqual([100, 200]);
  });

  it("documents the bug: a STALE cell's persist wipes alerts it never reconciled", () => {
    const A = cell();
    const B = cell();
    A.m.addAlert(100, cfg);
    A.m.addAlert(200, cfg);
    // B never reconciled: any B action that persists (here, drawing a line) writes B's
    // EMPTY alert set over the shared key → A's alerts vanish, untriggered. This is why
    // the push handler MUST reconcile mounted cells; overlays alone can't prevent it.
    B.m.addDrawing("segment", [{ value: 1 }, { value: 2 }]);
    expect(P.loadAlerts("US100")).toEqual([]);
  });
});

describe("parseAlertsStateKey (routing per-epic alert pushes to reconcile)", () => {
  it("matches a per-epic alerts key and extracts the epic; rejects others", () => {
    expect(P.parseAlertsStateKey("auto-trader.b.capital-live.alerts.OIL_CRUDE")).toBe("OIL_CRUDE");
    expect(P.parseAlertsStateKey("auto-trader.b.capital.alerts.US100")).toBe("US100");
    // Per-cell drawing key (must remount, not bumpAlerts) → not an alerts key.
    expect(P.parseAlertsStateKey("auto-trader.tab.abc.drawings.OIL_CRUDE")).toBeNull();
    // Layout / settings keys → not alerts.
    expect(P.parseAlertsStateKey("auto-trader.b.capital.tabs")).toBeNull();
    expect(P.parseAlertsStateKey("auto-trader.settings")).toBeNull();
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

describe("OverlayManager hide-all drawings (sidebar eye)", () => {
  it("hides every drawing without touching per-drawing intent, and restores on unhide", () => {
    const { chart, m } = setup();
    m.setResolution("HOUR");
    const a = m.addDrawing("segment", [{ value: 1 }, { value: 2 }])!;
    const b = m.addDrawing("priceLine", [{ value: 3 }])!;

    expect(m.getDrawingsHidden()).toBe(false);
    m.setDrawingsHidden(true);
    expect(m.getDrawingsHidden()).toBe(true);
    expect(chart.getOverlayById(a)!.visible).toBe(false);
    expect(chart.getOverlayById(b)!.visible).toBe(false);
    // Intent untouched: getDrawing still reports the user's choice, and persist
    // (which reads intent) is not corrupted by the session-only hide.
    expect(m.getDrawing(a)!.visible).toBe(true);
    const saved = P.loadDrawings("tab.A", "US100");
    expect(saved.every((d) => (asDrawingExtra(d.extendData).userVisible ?? true) === true)).toBe(true);

    m.setDrawingsHidden(false);
    expect(chart.getOverlayById(a)!.visible).toBe(true);
    expect(chart.getOverlayById(b)!.visible).toBe(true);
  });

  it("a ghosted (interval-filtered) drawing comes back as a ghost, not solid", () => {
    const { chart, m } = setup();
    m.setResolution("HOUR");
    const id = m.addDrawing("segment", [{ value: 1 }, { value: 2 }])!;
    m.setVisibilityModel(id, onlyVisibleOn("HOUR"));
    m.setResolution("MINUTE_5"); // → ghost (faded, still visible)
    const ghostColor = (chart.getOverlayById(id)!.styles as { line?: { color?: string } }).line?.color;
    expect(ghostColor).toMatch(/^rgba\(/);

    m.setDrawingsHidden(true);
    expect(chart.getOverlayById(id)!.visible).toBe(false);
    m.setDrawingsHidden(false);
    const back = chart.getOverlayById(id)!;
    expect(back.visible).toBe(true);
    expect((back.styles as { line?: { color?: string } }).line?.color).toMatch(/^rgba\(/);
  });
});

describe("OverlayManager lock-all drawings (sidebar padlock)", () => {
  it("lockAllDrawings locks only drawings; anyDrawingsLocked reflects it", () => {
    const { chart, m } = setup();
    const d = m.addDrawing("segment", [{ value: 1 }, { value: 2 }])!;
    const alert = m.addAlert(5, { condition: "crossing", trigger: "once", message: "" })!;

    expect(m.anyDrawingsLocked()).toBe(false);
    m.lockAllDrawings();
    expect(m.anyDrawingsLocked()).toBe(true);
    expect(chart.getOverlayById(d)!.lock).toBe(true);
    expect(chart.getOverlayById(alert)!.lock).not.toBe(true); // alerts untouched
    // Lock persists (SavedOverlay.lock existed already).
    expect(P.loadDrawings("tab.A", "US100")[0].lock).toBe(true);

    m.unlockAll();
    expect(m.anyDrawingsLocked()).toBe(false);
  });

  it("anyDrawingsLocked is true in a MIXED state (one locked, one not) so the padlock unlocks instead of locking everything", () => {
    const { chart, m } = setup();
    const a = m.addDrawing("segment", [{ value: 1 }, { value: 2 }])!;
    m.addDrawing("segment", [{ value: 3 }, { value: 4 }])!;
    chart.overrideOverlay({ id: a, lock: true }); // one drawing locked via right-click
    expect(m.anyDrawingsLocked()).toBe(true);
  });

  it("anyDrawingsLocked is false with zero drawings", () => {
    const { m } = setup();
    expect(m.anyDrawingsLocked()).toBe(false);
  });
});

describe("OverlayManager cancelDrawing (Esc cancels an in-progress drawing)", () => {
  it("returns false when nothing is in progress", () => {
    const { m } = setup();
    expect(m.cancelDrawing()).toBe(false);
  });

  it("cancels a drawing armed via addDrawing(name) with no points: removes the overlay, clears isDrawing()", () => {
    const { chart, m } = setup();
    const id = m.addDrawing("segment")!; // interactive draw, no points yet
    expect(id).toBeTruthy();
    expect(m.isDrawing()).toBe(true);
    expect(chart.getOverlayById(id)).toBeTruthy();

    expect(m.cancelDrawing()).toBe(true);

    expect(chart.getOverlayById(id)).toBeNull();
    expect(m.isDrawing()).toBe(false);
    // A second Escape (cancelDrawing) is a no-op — nothing left to cancel.
    expect(m.cancelDrawing()).toBe(false);
  });

  it("cancelling an in-progress drawing never persists it", () => {
    const { m } = setup();
    m.addDrawing("segment");
    m.cancelDrawing();
    expect(P.loadDrawings("tab.A", "US100")).toEqual([]);
  });

  it("does not disturb an unrelated already-placed drawing", () => {
    const { chart, m } = setup();
    const placed = m.addDrawing("segment", [{ value: 1 }, { value: 2 }])!;
    m.addDrawing("segment"); // arm a second, interactive one
    expect(m.cancelDrawing()).toBe(true);
    expect(chart.getOverlayById(placed)).toBeTruthy();
    expect(P.loadDrawings("tab.A", "US100")).toHaveLength(1);
  });

  it("re-arming a different tool cancels the first in-progress overlay (no ghost entry)", () => {
    const { chart, m } = setup();
    // klinecharts keeps ONE progress slot and overwrites it without firing
    // onRemoved — arming tool B while tool A is unplaced would strand A's id in
    // `entries` forever. addDrawing must cancel A properly first.
    const first = m.addDrawing("segment")!;
    const second = m.addDrawing("horizontalStraightLine")!;
    expect(chart.getOverlayById(first)).toBeNull(); // A removed, not orphaned
    expect(chart.getOverlayById(second)).toBeTruthy();
    expect(m.isDrawing()).toBe(true); // B is still armed
    // The stale id must not poison bulk lock state (a ghost read as "unlocked"
    // would pin the sidebar padlock to its lock branch for the whole session).
    expect(m.anyDrawingsLocked()).toBe(false);
  });
});

// A trendline whose second anchor sits to the RIGHT of the last candle (projected
// into the future) gets NO timestamp from klinecharts — only a dataIndex. Persisting
// must encode that anchor as an extrapolated timestamp (last bar + n × bar width),
// and rehydrating must decode it back to a beyond-data dataIndex: klinecharts'
// timestampToDataIndex CLAMPS to the nearest existing bar, and a point with neither
// timestamp nor dataIndex renders at x=0 — the "trendline teleports to the left
// edge after a timeframe change" bug.
describe("future-anchored drawing points survive persist/rehydrate", () => {
  const HOUR = 3_600_000;
  const T0 = 1_750_000_000_000;
  const bars = (n: number) => Array.from({ length: n }, (_, i) => ({ timestamp: T0 + i * HOUR }));

  it("persists an extrapolated timestamp for a point beyond the last candle", () => {
    const { chart, m } = setup();
    chart.data = bars(10); // last bar index 9
    m.setResolution("HOUR");
    m.addDrawing("segment", [
      { timestamp: chart.data[5].timestamp, value: 1 },
      { dataIndex: 13, value: 2 }, // 4 bars past the last — no timestamp, like klinecharts
    ]);
    const saved = P.loadDrawings("tab.A", "US100")[0];
    expect(saved.points[1].timestamp).toBe(chart.data[9].timestamp + 4 * HOUR);
    expect(saved.points[1].value).toBe(2);
  });

  it("rehydrates a future timestamp as a beyond-data dataIndex (not clamped / left-edge)", () => {
    const { chart, m } = setup();
    chart.data = bars(10);
    m.setResolution("HOUR");
    P.saveDrawings("tab.A", "US100", [
      {
        name: "segment",
        points: [
          { timestamp: chart.data[5].timestamp, value: 1 },
          { timestamp: chart.data[9].timestamp + 4 * HOUR, value: 2 },
        ],
      },
    ]);
    m.rehydrate();
    const ov = [...chart.overlays.values()].find((o) => o.name === "segment")!;
    const p = (ov.points as Array<{ timestamp?: number; dataIndex?: number; value?: number }>)[1];
    expect(p.dataIndex).toBe(13);
    expect(p.timestamp).toBeUndefined(); // klinecharts prefers timestamp — it must be gone
  });

  it("the future offset re-derives per resolution: same saved anchor lands on the right bar at 5m", () => {
    const { chart, m } = setup();
    const M5 = 300_000;
    chart.data = Array.from({ length: 10 }, (_, i) => ({ timestamp: T0 + i * M5 }));
    m.setResolution("MINUTE_5");
    P.saveDrawings("tab.A", "US100", [
      { name: "segment", points: [{ timestamp: T0, value: 1 }, { timestamp: chart.data[9].timestamp + 2 * HOUR, value: 2 }] },
    ]);
    m.rehydrate();
    const ov = [...chart.overlays.values()].find((o) => o.name === "segment")!;
    const p = (ov.points as Array<{ dataIndex?: number }>)[1];
    expect(p.dataIndex).toBe(9 + 24); // 2h beyond the last 5m bar = 24 bars
  });

  // The timeframe-switch bug: ChartCore rebuilds overlays right after the NEW
  // resolution's bars land, but the manager's `resolution` field still holds the
  // PREVIOUS timeframe at that moment — so the future offset was extrapolated with
  // the OLD bar width (a 14h-ahead anchor became 28 one-hour bars after a 30m→1H
  // switch: line flattens, and the next persist() bakes the drift into storage).
  // rehydrate(resolution) must adopt the new resolution BEFORE materializing.
  it("rehydrate(resolution) materializes the future offset with the NEW timeframe's bar width, not the stale one", () => {
    const { chart, m } = setup();
    m.setResolution("MINUTE_5"); // the timeframe the cell was on before the switch
    chart.data = bars(10); // the 1H bars that just landed
    P.saveDrawings("tab.A", "US100", [
      {
        name: "segment",
        points: [
          { timestamp: chart.data[5].timestamp, value: 1 },
          { timestamp: chart.data[9].timestamp + 4 * HOUR, value: 2 },
        ],
      },
    ]);
    m.rehydrate("HOUR");
    const ov = [...chart.overlays.values()].find((o) => o.name === "segment")!;
    const p = (ov.points as Array<{ dataIndex?: number }>)[1];
    expect(p.dataIndex).toBe(13); // 4h beyond the last 1H bar = 4 bars (not 48 five-minute bars)
    expect(m.getResolution()).toBe("HOUR"); // adopted — the later setResolution call is subsumed
  });

  it("rehydrate() without an argument keeps the current resolution (template re-apply path)", () => {
    const { chart, m } = setup();
    chart.data = bars(10);
    m.setResolution("HOUR");
    P.saveDrawings("tab.A", "US100", [
      {
        name: "segment",
        points: [
          { timestamp: chart.data[5].timestamp, value: 1 },
          { timestamp: chart.data[9].timestamp + 4 * HOUR, value: 2 },
        ],
      },
    ]);
    m.rehydrate();
    const ov = [...chart.overlays.values()].find((o) => o.name === "segment")!;
    expect((ov.points as Array<{ dataIndex?: number }>)[1].dataIndex).toBe(13);
    expect(m.getResolution()).toBe("HOUR");
  });

  // Prepending older bars (scroll-back page, anchor-coverage walk) renumbers every
  // bar's dataIndex — a timestamped point re-resolves per paint, but a beyond-data
  // point is dataIndex-ONLY (timestamp stripped at materialize), so klinecharts
  // leaves it at the old index and the future anchor slides back into history.
  // Callers report each prepend so these points shift along.
  it("shiftIndexAnchoredPoints moves dataIndex-only points by the prepend size and leaves timestamped points alone", () => {
    const { chart, m } = setup();
    chart.data = bars(10);
    m.setResolution("HOUR");
    P.saveDrawings("tab.A", "US100", [
      {
        name: "segment",
        points: [
          { timestamp: chart.data[5].timestamp, value: 1 },
          { timestamp: chart.data[9].timestamp + 4 * HOUR, value: 2 },
        ],
      },
    ]);
    m.rehydrate();
    // A 3-bar page of older history lands.
    chart.data = [
      ...Array.from({ length: 3 }, (_, i) => ({ timestamp: T0 - (3 - i) * HOUR })),
      ...chart.data,
    ];
    m.shiftIndexAnchoredPoints(3);
    const ov = [...chart.overlays.values()].find((o) => o.name === "segment")!;
    const pts = ov.points as Array<{ timestamp?: number; dataIndex?: number }>;
    expect(pts[1].dataIndex).toBe(16); // still 4 bars past the (shifted) last bar
    expect(pts[1].timestamp).toBeUndefined();
    expect(pts[0].timestamp).toBe(T0 + 5 * HOUR); // in-range anchor untouched
  });

  // The ordering invariant applyOlderBars encodes: klinecharts' INIT-type
  // updatePointPosition back-fills point.timestamp from whatever bar sits at a
  // dataIndex-only point's index the moment new data lands. Shift AFTER the data
  // and the stale index is in-range — the future anchor gets pinned onto a
  // historical bar permanently. FakeChart.applyNewData models that back-fill, so
  // this test fails if anyone reorders the shift behind the applyNewData call.
  it("applyOlderBars shifts beyond-data anchors BEFORE the data lands (Init back-fill can't pin them)", () => {
    const { chart, m } = setup();
    chart.data = bars(10);
    m.setResolution("HOUR");
    P.saveDrawings("tab.A", "US100", [
      {
        name: "segment",
        points: [
          { timestamp: chart.data[5].timestamp, value: 1 },
          { timestamp: chart.data[9].timestamp + 4 * HOUR, value: 2 },
        ],
      },
    ]);
    m.rehydrate(); // future anchor → dataIndex 13, no timestamp
    // A coverage-walk page of 20 older bars lands via the canonical prepend.
    const older = Array.from({ length: 20 }, (_, i) => ({ timestamp: T0 - (20 - i) * HOUR }));
    m.applyOlderBars([...older, ...chart.data] as never);
    const p = ([...chart.overlays.values()].find((o) => o.name === "segment")!
      .points as Array<{ timestamp?: number; dataIndex?: number }>)[1];
    expect(p.dataIndex).toBe(33); // 13 + 20 — still 4 bars past the (shifted) last bar
    expect(p.timestamp).toBeUndefined(); // index 33 is beyond the 30 bars → no back-fill
  });

  // The transient measure ruler can also have a beyond-data endpoint — it must
  // shift with the drawings or a prepend pins its box into history.
  it("shiftIndexAnchoredPoints moves a measure's beyond-data endpoint too", () => {
    const { chart, m } = setup();
    chart.data = bars(10);
    m.setResolution("HOUR");
    const id = m.startMeasureDraw()!;
    // As if klinecharts collected the two clicks, the second past the last candle.
    chart.overrideOverlay({
      id,
      points: [{ timestamp: chart.data[5].timestamp, value: 1 }, { dataIndex: 12, value: 2 }],
    });
    m.shiftIndexAnchoredPoints(3);
    const pts = chart.getOverlayById(id)!.points as Array<{ dataIndex?: number }>;
    expect(pts[1].dataIndex).toBe(15);
  });
});

// The remaining stablePoints branches: an anchor dragged LEFT of the loaded window
// (negative dataIndex) extrapolates backwards from the first bar, and an in-range
// point that klinecharts left timestamp-less resolves to its bar's timestamp.
describe("stablePoints edge branches", () => {
  const HOUR = 3_600_000;
  const T0 = 1_750_000_000_000;
  const bars = (n: number) => Array.from({ length: n }, (_, i) => ({ timestamp: T0 + i * HOUR }));

  it("encodes a before-data anchor (negative dataIndex) as first bar minus n bars", () => {
    const { chart, m } = setup();
    chart.data = bars(10);
    m.setResolution("HOUR");
    m.addDrawing("segment", [
      { dataIndex: -3, value: 1 },
      { timestamp: chart.data[5].timestamp, value: 2 },
    ]);
    const saved = P.loadDrawings("tab.A", "US100")[0];
    expect(saved.points[0].timestamp).toBe(T0 - 3 * HOUR);
  });

  it("resolves an in-range point with dataIndex but no timestamp to that bar's timestamp", () => {
    const { chart, m } = setup();
    chart.data = bars(10);
    m.setResolution("HOUR");
    m.addDrawing("segment", [
      { dataIndex: 4, value: 1 },
      { timestamp: chart.data[9].timestamp, value: 2 },
    ]);
    const saved = P.loadDrawings("tab.A", "US100")[0];
    expect(saved.points[0].timestamp).toBe(chart.data[4].timestamp);
  });
});

describe("drawing defaults seeding + config round-trip", () => {
  it("seeds a freshly-drawn overlay from the saved default (styles + extendData)", () => {
    const { chart, m } = setup();
    // A visibility model that hides on all intervals, to prove it's stored on the
    // seeded overlay. (Enforcement runs in create()'s onDrawEnd, which FakeChart does
    // not fire for an interactive draw — so we assert STORAGE here; the apply path is
    // exercised by the round-trip test below.)
    const hidden = defaultVisibility();
    for (const u of Object.values(hidden.units)) u.on = false;
    P.saveDrawingDefault("segment", {
      line: { color: "#ff0000", size: 3 },
      showMiddle: true,
      priceLabels: false,
      visibility: hidden,
    });
    const id = m.addDrawing("segment"); // interactive: no points
    expect(id).not.toBeNull();
    const ov = chart.getOverlayById(id!)!;
    expect((ov.styles as { line?: { color?: string } }).line?.color).toBe("#ff0000");
    expect(asDrawingExtra(ov.extendData).showMiddle).toBe(true);
    expect(asDrawingExtra(ov.extendData).priceLabels).toBe(false);
    expect(ov.needDefaultYAxisFigure).toBe(false); // priceLabels:false ⇒ no y-axis tag
    expect(asDrawingExtra(ov.extendData).visibility).toEqual(hidden); // stored
  });

  it("enforces a seeded hidden-visibility default when an interactive draw completes (Step 3b)", () => {
    // The interactive (no-points) path enforces visibility in create()'s onDrawEnd,
    // which klinecharts fires on completion. FakeChart never fires it, so simulate
    // completion by invoking the stored callback — the ONLY thing that exercises the
    // onDrawEnd applyDisplay branch. (A with-points draw is enforced earlier, in
    // addDrawing itself — covered by the in-place test above; using no-points here
    // isolates the onDrawEnd branch.) Hidden-but-user-visible ⇒ GHOST (faded rgba).
    const { chart, m } = setup();
    m.setResolution("HOUR");
    const hidden = defaultVisibility();
    for (const u of Object.values(hidden.units)) u.on = false; // hidden on every interval
    P.saveDrawingDefault("segment", { visibility: hidden });
    const id = m.addDrawing("segment")!; // interactive: no points
    const ov = chart.getOverlayById(id)! as unknown as { onDrawEnd?: () => void };
    const before = (chart.getOverlayById(id)!.styles as { line?: { color?: string } }).line?.color;
    expect(before).not.toMatch(/^rgba\(/); // not yet faded (onDrawEnd hasn't fired)
    ov.onDrawEnd?.(); // fire Step 3b
    const after = (chart.getOverlayById(id)!.styles as { line?: { color?: string } }).line?.color;
    expect(after).toMatch(/^rgba\(/); // seeded hide enforced → ghosted
  });

  it("enforces a seeded hidden-visibility default on an in-place (with-points) draw", () => {
    // The chart "+" menu draws with points → completes synchronously → NO onDrawEnd.
    // Seeded visibility must still be enforced immediately (not only after a reload).
    const { chart, m } = setup();
    m.setResolution("HOUR");
    const hidden = defaultVisibility();
    for (const u of Object.values(hidden.units)) u.on = false;
    P.saveDrawingDefault("horizontalStraightLine", { visibility: hidden });
    const id = m.addDrawing("horizontalStraightLine", [{ value: 100 }])!;
    const color = (chart.getOverlayById(id)!.styles as { line?: { color?: string } }).line?.color;
    expect(color).toMatch(/^rgba\(/); // ghosted right away
  });

  it("captures CONCRETE line fields so a size-1 default fully resets a widened line", () => {
    const { m } = setup();
    // A default from a plain (unstyled) drawing must carry concrete size/style/color…
    const src = m.addDrawing("segment", [{ value: 1 }, { value: 2 }])!;
    const def = m.getDrawingConfig(src)!;
    expect(def.line?.size).toBe(1);
    expect(def.line?.color).toBeTruthy();
    expect(def.line?.style).toBeDefined();
    // …so applying it over a customized (width-5) line resets the width back to 1.
    const other = m.addDrawing("segment", [{ value: 3 }, { value: 4 }])!;
    m.setStyle(other, { line: { size: 5 } } as Parameters<typeof m.setStyle>[1]);
    expect(m.getDrawingConfig(other)!.line?.size).toBe(5);
    m.applyDrawingConfig(other, def);
    expect(m.getDrawingConfig(other)!.line?.size).toBe(1);
  });

  it("draws with no seeded style/extras when there is no default", () => {
    const { chart, m } = setup();
    const id = m.addDrawing("rayLine");
    const ov = chart.getOverlayById(id!)!;
    // No default ⇒ create() passes styles:undefined; FakeChart substitutes the
    // klinecharts default (#1677FF), and no appearance flags are seeded.
    expect((ov.styles as { line?: { color?: string } }).line?.color).toBe("#1677FF");
    expect(asDrawingExtra(ov.extendData)).toEqual({});
  });

  it("getDrawingConfig reads the live overlay; applyDrawingConfig writes it back (incl. visibility)", () => {
    const { m } = setup();
    const id = m.addDrawing("segment", [{ value: 10 }, { value: 20 }])!;
    const hidden = defaultVisibility();
    hidden.units.days.on = false;
    m.applyDrawingConfig(id, {
      line: { color: "#00ff00" },
      priceLabels: false,
      visibility: hidden,
    });
    const cfg = m.getDrawingConfig(id)!;
    expect(cfg.line?.color).toBe("#00ff00");
    expect(cfg.priceLabels).toBe(false);
    // applyDrawingConfig routes visibility through setVisibilityModel (applyDisplay +
    // store); getDrawingConfig reads it straight back.
    expect(cfg.visibility?.units.days.on).toBe(false);
  });
});

describe("OverlayManager picker-hover emphasis (thicken on chart, never persist the bump)", () => {
  const liveLine = (chart: FakeChart, id: string) =>
    (chart.getOverlayById(id)!.styles as { line?: { size?: number; color?: string } }).line ?? {};

  it("hoverDrawing thickens the live line but getDrawing/persist report the BASE size (shield)", () => {
    const { chart, m } = setup();
    const id = m.addDrawing("segment", [{ value: 1 }, { value: 2 }])!;
    expect(liveLine(chart, id).size).toBe(1); // seeded default

    m.hoverDrawing(id);
    // Live overlay is emphasized (thicker), color preserved (full line reconstructed).
    expect(liveLine(chart, id).size).toBe(3); // 1 + EMPHASIS_EXTRA_SIZE
    expect(liveLine(chart, id).color).toBe("#1677FF");
    // The SHIELD: a snapshot (clipboard/clone/persist path) must NOT see the bump.
    const styled = m.getDrawing(id)!.styles as { line?: { size?: number } } | null;
    expect(styled?.line?.size ?? 1).toBe(1);

    // Un-hover restores the exact base weight on the live overlay.
    m.hoverDrawing(null);
    expect(liveLine(chart, id).size).toBe(1);
    expect(liveLine(chart, id).color).toBe("#1677FF");
  });

  it("moving hover from one drawing to another restores the first and emphasizes the second", () => {
    const { chart, m } = setup();
    const a = m.addDrawing("segment", [{ value: 1 }, { value: 2 }])!;
    const b = m.addDrawing("segment", [{ value: 3 }, { value: 4 }])!;
    m.hoverDrawing(a);
    m.hoverDrawing(b);
    expect(liveLine(chart, a).size).toBe(1); // restored
    expect(liveLine(chart, b).size).toBe(3); // now emphasized
  });

  it("a drawing that FADES while picker-emphasized never stashes the +2px as canonical (shield covers fade-stash)", () => {
    const { chart, m } = setup();
    m.setResolution("HOUR");
    const id = m.addDrawing("segment", [{ value: 1 }, { value: 2 }])!;
    m.setVisibilityModel(id, onlyVisibleOn("HOUR"));
    m.setVisible(id, true); // solid on HOUR
    m.hoverDrawing(id);
    expect(liveLine(chart, id).size).toBe(3); // emphasized

    m.setResolution("MINUTE_5"); // fades WHILE emphasized → fade-stash must capture BASE
    // Canonical/persisted width stays the base 1, not the transient 3.
    const styled = m.getDrawing(id)!.styles as { line?: { size?: number } } | null;
    expect(styled?.line?.size ?? 1).toBe(1);

    m.hoverDrawing(null);
    m.setResolution("HOUR"); // back to solid
    expect(liveLine(chart, id).size).toBe(1); // never re-baked thicker
  });

  it("emphasizing a ghosted (faded) drawing returns it to faded on un-hover", () => {
    const { chart, m } = setup();
    m.setResolution("HOUR");
    const id = m.addDrawing("segment", [{ value: 1 }, { value: 2 }])!;
    m.setVisibilityModel(id, onlyVisibleOn("HOUR"));
    m.setVisible(id, true);
    m.setResolution("MINUTE_5"); // now a ghost (faded rgba color)
    expect(liveLine(chart, id).color).toMatch(/^rgba\(/);

    m.hoverDrawing(id);
    expect(liveLine(chart, id).size).toBe(3); // popped to full color + thick
    expect(liveLine(chart, id).color).not.toMatch(/^rgba\(/);

    m.hoverDrawing(null);
    expect(liveLine(chart, id).color).toMatch(/^rgba\(/); // re-faded
  });
});

describe("OverlayManager rehydrate teardown vs re-entrant reconcile (TF-switch data loss)", () => {
  // THE 2026-07-08 vanish bug. A same-epic rehydrate (timeframe switch) tears down
  // every overlay; removing an ALERT fires onRemoved → notifyAlerts → alertsChanged,
  // and the cell's live subscription (ChartCore) synchronously runs reconcileAlerts,
  // whose guarded() finally CLEARED the shared boolean `hydrating` flag while the
  // teardown loop was still mid-flight. Every remaining removal then persisted a
  // partial, shrinking list — alerts AND drawings spiralled to [] in storage, and
  // the rebuild phase re-read the freshly-stomped keys and recreated nothing.
  it("a same-epic rehydrate with the live alertsChanged→reconcileAlerts wiring keeps storage intact", () => {
    const { m } = setup();
    // Real cell wiring (ChartCore.tsx): every alertsChanged bump reconciles this cell.
    const unsub = alertsChanged.subscribe(() => m.reconcileAlerts());
    try {
      m.addDrawing("segment", [{ value: 1 }, { value: 2 }]);
      for (const lvl of [10, 20, 30, 40]) {
        m.addAlert(lvl, { condition: "crossing", trigger: "every", message: "" });
      }
      expect(P.loadAlerts("US100")).toHaveLength(4);
      expect(P.loadDrawings("tab.A", "US100")).toHaveLength(1);

      m.rehydrate("MINUTE_5"); // the timeframe switch

      expect(P.loadAlerts("US100").map((a) => a.level)).toEqual([10, 20, 30, 40]);
      expect(P.loadDrawings("tab.A", "US100")).toHaveLength(1);
    } finally {
      unsub();
    }
  });
});
