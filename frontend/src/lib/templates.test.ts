import { describe, it, expect, beforeEach, vi } from "vitest";

// templates.ts statically imports ./indicators, which transitively loads
// klinecharts enums that aren't available in the node test env. We only exercise
// capture + the gate's early-return branches (none of which call into indicators),
// so stub the module to keep the import graph node-safe.
// applyIndicator returns truthy here so the apply path's `restored` filter keeps
// the instances and controller.indicators.set receives them (lets the precedence
// tests below assert WHICH template was applied).
vi.mock("./indicators", () => ({
  applyIndicator: vi.fn(() => true),
  removeIndicatorById: vi.fn(),
}));

// Same in-memory localStorage shim as persist.test.ts (node env, no DOM).
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
const T = await import("./templates");

const SCOPE = "tab.A";
const EPIC = "US100";

beforeEach(() => localStorage.clear());

describe("captureSymbolTemplate", () => {
  it("snapshots a cell's indicators, configs, drawings and AVWAP anchors", () => {
    P.saveIndicators(SCOPE, [
      { id: "EMA", type: "EMA" },
      { id: "AVWAP", type: "AVWAP" },
    ]);
    P.saveIndicatorConfig(SCOPE, "EMA", { calcParams: [9] });
    P.saveDrawings(SCOPE, EPIC, [{ name: "trend", points: [{ value: 1 }] }]);
    P.saveAvwapAnchor(SCOPE, EPIC, "AVWAP", 1700000000000);

    const t = T.captureSymbolTemplate(SCOPE, EPIC);
    expect(t.epic).toBe(EPIC);
    expect(t.indicators).toHaveLength(2);
    expect(t.indicatorConfigs.EMA).toEqual({ calcParams: [9] });
    expect(t.drawings).toHaveLength(1);
    // Only AVWAP instances contribute anchors, and only when actually placed.
    expect(t.avwapAnchors).toEqual({ AVWAP: 1700000000000 });
  });

  it("omits anchors for unplaced AVWAPs (anchor 0)", () => {
    P.saveIndicators(SCOPE, [{ id: "AVWAP", type: "AVWAP" }]);
    const t = T.captureSymbolTemplate(SCOPE, EPIC);
    expect(t.avwapAnchors).toEqual({});
  });
});

describe("captureDefaultTemplate", () => {
  it("keeps indicators + their configs but excludes AVWAP, drawings and anchors", () => {
    P.saveIndicators(SCOPE, [
      { id: "VOL", type: "VOL" },
      { id: "EMA", type: "EMA" },
      { id: "AVWAP", type: "AVWAP" }, // symbol-specific → dropped
    ]);
    P.saveIndicatorConfig(SCOPE, "EMA", { calcParams: [21] });
    P.saveIndicatorConfig(SCOPE, "AVWAP", { calcParams: [0] });
    P.saveDrawings(SCOPE, EPIC, [{ name: "trend", points: [{ value: 1 }] }]);

    const d = T.captureDefaultTemplate(SCOPE);
    expect(d.indicators.map((i) => i.id)).toEqual(["VOL", "EMA"]);
    expect(d.indicatorConfigs).toEqual({ EMA: { calcParams: [21] } });
    // DefaultTemplate has no drawings/avwapAnchors/epic fields at all.
    expect(d).not.toHaveProperty("drawings");
    expect(d).not.toHaveProperty("epic");
  });
});

describe("maybeAutoApplyTemplate gate", () => {
  // A stub chart/controller is enough to exercise the EARLY-RETURN branches; the
  // apply path itself needs a real klinecharts instance and is covered by e2e.
  const stubChart = {} as unknown as import("klinecharts").Chart;
  // Captures what the apply path set, so precedence tests can read it back.
  let applied: { id: string }[] = [];
  const stubController = {
    indicators: { value: [] as unknown[], set: (v: { id: string }[]) => (applied = v) },
    overlays: { rehydrate: () => {} },
  } as unknown as import("./chartController").ChartController;

  it("does not apply when there is no template for the symbol", () => {
    expect(T.maybeAutoApplyTemplate(stubChart, stubController, SCOPE, EPIC)).toBe(false);
  });

  it("does not apply when the cell already has saved indicators", () => {
    P.saveSymbolTemplate({
      epic: EPIC,
      indicators: [{ id: "EMA", type: "EMA" }],
      indicatorConfigs: {},
      drawings: [],
      avwapAnchors: {},
      savedAt: 1,
    });
    P.saveIndicators(SCOPE, [{ id: "RSI", type: "RSI" }]);
    expect(T.maybeAutoApplyTemplate(stubChart, stubController, SCOPE, EPIC)).toBe(false);
  });

  it("does not apply when the cell already has saved drawings", () => {
    P.saveSymbolTemplate({
      epic: EPIC,
      indicators: [],
      indicatorConfigs: {},
      drawings: [{ name: "trend", points: [{ value: 1 }] }],
      avwapAnchors: {},
      savedAt: 1,
    });
    P.saveDrawings(SCOPE, EPIC, [{ name: "existing", points: [{ value: 2 }] }]);
    expect(T.maybeAutoApplyTemplate(stubChart, stubController, SCOPE, EPIC)).toBe(false);
  });

  it("applies the global default onto a fresh cell when no per-symbol template exists", () => {
    applied = [];
    P.saveDefaultTemplate({
      indicators: [{ id: "VOL", type: "VOL" }],
      indicatorConfigs: {},
      savedAt: 1,
    });
    expect(T.maybeAutoApplyTemplate(stubChart, stubController, SCOPE, EPIC)).toBe(true);
    expect(applied.map((i) => i.id)).toEqual(["VOL"]);
  });

  it("prefers the per-symbol template over the global default (specific beats general)", () => {
    applied = [];
    P.saveSymbolTemplate({
      epic: EPIC,
      indicators: [{ id: "RSI", type: "RSI" }],
      indicatorConfigs: {},
      drawings: [],
      avwapAnchors: {},
      savedAt: 1,
    });
    P.saveDefaultTemplate({
      indicators: [{ id: "VOL", type: "VOL" }],
      indicatorConfigs: {},
      savedAt: 1,
    });
    expect(T.maybeAutoApplyTemplate(stubChart, stubController, SCOPE, EPIC)).toBe(true);
    expect(applied.map((i) => i.id)).toEqual(["RSI"]);
  });
});
