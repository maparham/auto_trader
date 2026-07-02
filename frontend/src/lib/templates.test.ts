import { describe, it, expect, beforeEach, vi } from "vitest";

// templates.ts statically imports ./indicators, which transitively loads
// klinecharts enums that aren't available in the node test env. Stub the module:
// applyIndicator returns a truthy paneId so applied instances count as restored;
// mintInstanceId mints deterministic unique ids ("EMA#m1", "RSI#m2", …);
// defaultCalcParams returns undefined (both sides of a signature comparison
// normalize identically, which is all the merge logic needs here — the real
// normalization is covered by templateSignatures.test.ts + e2e).
vi.mock("./indicators", () => {
  let seq = 0;
  return {
    applyIndicator: vi.fn(() => "pane_x"),
    mintInstanceId: vi.fn((_chart: unknown, type: string) => `${type}#m${++seq}`),
    defaultCalcParams: vi.fn(() => undefined),
  };
});

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
  let applied: { id: string; type: string }[] = [];
  const stubController = {
    indicators: { value: [] as unknown[], set: (v: { id: string; type: string }[]) => (applied = v) },
    indicatorsHidden: { value: false },
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
    expect(applied.map((i) => (i as { type: string }).type)).toEqual(["VOL"]);
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
    expect(applied.map((i) => (i as { type: string }).type)).toEqual(["RSI"]);
  });
});

describe("applySymbolTemplate merge (additive, existing wins)", () => {
  const stubChart = {} as unknown as import("klinecharts").Chart;
  let applied: { id: string; type: string }[] = [];
  let rehydrated = 0;
  const controller = {
    indicators: { value: [], set: (v: { id: string; type: string }[]) => (applied = v) },
    indicatorsHidden: { value: false },
    overlays: { rehydrate: () => rehydrated++ },
  } as unknown as import("./chartController").ChartController;

  const template = (over?: Partial<import("./persist").SymbolTemplate>): import("./persist").SymbolTemplate => ({
    epic: EPIC,
    indicators: [],
    indicatorConfigs: {},
    drawings: [],
    avwapAnchors: {},
    savedAt: 1,
    ...over,
  });

  beforeEach(() => {
    applied = [];
    rehydrated = 0;
  });

  it("skips an equivalent indicator (same type+params, different styling) and adds the missing one", () => {
    P.saveIndicators(SCOPE, [{ id: "EMA", type: "EMA" }]);
    P.saveIndicatorConfig(SCOPE, "EMA", { calcParams: [21] });

    T.applySymbolTemplate(stubChart, controller, SCOPE, EPIC, template({
      indicators: [
        { id: "EMA", type: "EMA" },
        { id: "RSI", type: "RSI" },
      ],
      indicatorConfigs: {
        // Same identity as the existing EMA (params [21]) but different styling —
        // must be treated as a duplicate and skipped, styling NOT applied.
        EMA: { calcParams: [21], styles: { lines: [{ color: "#00f" }] } },
        RSI: { calcParams: [14] },
      },
    }));

    const after = P.loadIndicators(SCOPE);
    expect(after.filter((i) => i.type === "EMA")).toHaveLength(1);
    expect(after.find((i) => i.type === "EMA")!.id).toBe("EMA"); // untouched
    expect(after.filter((i) => i.type === "RSI")).toHaveLength(1);
    // Existing EMA config untouched — template styling did NOT win.
    expect(P.loadIndicatorConfigs(SCOPE).EMA).toEqual({ calcParams: [21] });
    // The added RSI got the template's config under its freshly-minted id.
    const rsiId = after.find((i) => i.type === "RSI")!.id;
    expect(P.loadIndicatorConfigs(SCOPE)[rsiId]).toEqual({ calcParams: [14] });
    // controller.indicators.set received the FULL list (existing + added).
    expect(applied.map((i) => i.type).sort()).toEqual(["EMA", "RSI"]);
  });

  it("adds an indicator of the same type when params differ", () => {
    P.saveIndicators(SCOPE, [{ id: "EMA", type: "EMA" }]);
    P.saveIndicatorConfig(SCOPE, "EMA", { calcParams: [21] });

    T.applySymbolTemplate(stubChart, controller, SCOPE, EPIC, template({
      indicators: [{ id: "EMA", type: "EMA" }],
      indicatorConfigs: { EMA: { calcParams: [50] } },
    }));

    expect(P.loadIndicators(SCOPE).filter((i) => i.type === "EMA")).toHaveLength(2);
  });

  it("unions drawings by geometry and never removes existing ones", () => {
    P.saveDrawings(SCOPE, EPIC, [
      { name: "horizontalStraightLine", points: [{ timestamp: 1, value: 100 }] },
    ]);

    T.applySymbolTemplate(stubChart, controller, SCOPE, EPIC, template({
      drawings: [
        // duplicate of the existing line (different style) → skipped
        { name: "horizontalStraightLine", points: [{ timestamp: 1, value: 100 }], lock: true },
        // genuinely new → added
        { name: "priceLine", points: [{ timestamp: 2, value: 200 }] },
      ],
    }));

    const after = P.loadDrawings(SCOPE, EPIC);
    expect(after).toHaveLength(2);
    expect(after[0]).toEqual({ name: "horizontalStraightLine", points: [{ timestamp: 1, value: 100 }] });
    expect(after[1].name).toBe("priceLine");
    expect(rehydrated).toBe(1);
  });

  it("does not rewrite or rehydrate drawings when the template adds none", () => {
    P.saveDrawings(SCOPE, EPIC, [
      { name: "horizontalStraightLine", points: [{ timestamp: 1, value: 100 }] },
    ]);

    T.applySymbolTemplate(stubChart, controller, SCOPE, EPIC, template({
      drawings: [{ name: "horizontalStraightLine", points: [{ timestamp: 1, value: 100 }] }],
    }));

    expect(P.loadDrawings(SCOPE, EPIC)).toHaveLength(1);
    expect(rehydrated).toBe(0);
  });

  it("applyDefaultTemplate leaves existing drawings untouched (the old wipe bug)", () => {
    P.saveDrawings(SCOPE, EPIC, [
      { name: "horizontalStraightLine", points: [{ timestamp: 1, value: 100 }] },
    ]);

    T.applyDefaultTemplate(stubChart, controller, SCOPE, EPIC, {
      indicators: [{ id: "VOL", type: "VOL" }],
      indicatorConfigs: {},
      savedAt: 1,
    });

    expect(P.loadDrawings(SCOPE, EPIC)).toHaveLength(1); // survived
    expect(P.loadIndicators(SCOPE).map((i) => i.type)).toEqual(["VOL"]); // merged in
  });

  it("is idempotent — applying the same template twice adds nothing new", () => {
    const t = template({
      indicators: [{ id: "EMA", type: "EMA" }],
      indicatorConfigs: { EMA: { calcParams: [21] } },
      drawings: [{ name: "priceLine", points: [{ timestamp: 2, value: 200 }] }],
    });

    T.applySymbolTemplate(stubChart, controller, SCOPE, EPIC, t);
    const indicatorsAfterFirst = P.loadIndicators(SCOPE);
    const drawingsAfterFirst = P.loadDrawings(SCOPE, EPIC);

    T.applySymbolTemplate(stubChart, controller, SCOPE, EPIC, t);
    expect(P.loadIndicators(SCOPE)).toEqual(indicatorsAfterFirst);
    expect(P.loadDrawings(SCOPE, EPIC)).toEqual(drawingsAfterFirst);
  });

  it("AVWAP: same anchor is a duplicate, a different anchor adds a second instance", () => {
    P.saveIndicators(SCOPE, [{ id: "AVWAP", type: "AVWAP" }]);
    P.saveAvwapAnchor(SCOPE, EPIC, "AVWAP", 1700000000000);

    // Same anchor → skip.
    T.applySymbolTemplate(stubChart, controller, SCOPE, EPIC, template({
      indicators: [{ id: "AVWAP", type: "AVWAP" }],
      avwapAnchors: { AVWAP: 1700000000000 },
    }));
    expect(P.loadIndicators(SCOPE).filter((i) => i.type === "AVWAP")).toHaveLength(1);

    // Different anchor → add, and the anchor lands under the NEW instance's id.
    T.applySymbolTemplate(stubChart, controller, SCOPE, EPIC, template({
      indicators: [{ id: "AVWAP", type: "AVWAP" }],
      avwapAnchors: { AVWAP: 1800000000000 },
    }));
    const avwaps = P.loadIndicators(SCOPE).filter((i) => i.type === "AVWAP");
    expect(avwaps).toHaveLength(2);
    const newId = avwaps.find((i) => i.id !== "AVWAP")!.id;
    expect(P.loadAvwapAnchor(SCOPE, EPIC, newId)).toBe(1800000000000);
  });

  it("two identical rows inside one template add only once", () => {
    T.applySymbolTemplate(stubChart, controller, SCOPE, EPIC, template({
      indicators: [
        { id: "a", type: "RSI" },
        { id: "b", type: "RSI" },
      ],
      indicatorConfigs: { a: { calcParams: [14] }, b: { calcParams: [14] } },
    }));
    expect(P.loadIndicators(SCOPE).filter((i) => i.type === "RSI")).toHaveLength(1);
  });
});
