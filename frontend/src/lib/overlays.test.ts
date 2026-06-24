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
  removeOverlay(id: string) { this.overlays.delete(id); }
}

function setup() {
  const chart = new FakeChart();
  const m = new OverlayManager();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  m.attach(chart as any);
  m.setEpic("US100");
  m.setScope("tab.A");
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

    m.hoverAlert(null);
    expect(lineSize(chart, id)).toBe(1); // back to resting
    expect(m.getAlerts().find((a) => a.id === id)!.hovered).toBe(false);
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
    const id1 = P.loadAlerts("tab.A", "US100")[0].id;
    expect(id1).toBeTruthy();

    m.updateAlert(ovId, 104, { ...cfg, trigger: "once" }); // move + reconfigure
    const saved = P.loadAlerts("tab.A", "US100");
    expect(saved).toHaveLength(1);
    expect(saved[0].id).toBe(id1); // identity survives the edit
    expect(saved[0].level).toBe(104);
  });

  it("reconcileAlerts drops a line by id when the engine removed it from storage", () => {
    const { chart, m } = setup();
    const ovId = m.addAlert(100, cfg)!;
    expect(chart.getOverlayById(ovId)).not.toBeNull();

    // Engine fired a "once" and wrote survivors=[] (the id is gone from storage).
    P.saveAlerts("tab.A", "US100", []);
    m.reconcileAlerts();
    expect(chart.getOverlayById(ovId)).toBeNull(); // line removed off the id mismatch
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
