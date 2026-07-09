import { describe, it, expect, beforeEach, vi } from "vitest";

// templates.ts statically imports ./indicators, which transitively loads
// klinecharts enums that aren't available in the node test env. Stub the module:
// applyIndicator returns a truthy paneId so applied instances count as restored;
// mintInstanceId mints deterministic unique ids ("EMA#m1", "RSI#m2", …);
// effectiveCalcParams defaults to "no saved value → undefined" (both sides of a
// signature comparison normalize identically, which is all the generic merge
// tests below need) but per-test overrides make it return the type's REAL
// built-in/override default (e.g. MACD → [12,26,9], RSI → [14]) to exercise the
// actual wiring templates.ts depends on for Findings 1/2 below — the helper's
// REAL values (verified against the installed klinecharts dist) live in
// indicators.ts and are not node-testable here (klinecharts imports); see the
// verified-defaults table + source-line comments in indicators.ts.
vi.mock("./indicators", () => {
  let seq = 0;
  return {
    applyIndicator: vi.fn(() => "pane_x"),
    mintInstanceId: vi.fn((_chart: unknown, type: string) => `${type}#m${++seq}`),
    effectiveCalcParams: vi.fn((_type: string, saved?: number[]) => saved),
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
const I = await import("./indicators");

const SCOPE = "tab.A";
const EPIC = "US100";

beforeEach(() => {
  localStorage.clear();
  // Restore the passthrough default; individual tests below override this to
  // simulate indicators.ts's real normalization for the type(s) they exercise.
  vi.mocked(I.effectiveCalcParams).mockImplementation((_type, saved) => saved);
});

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
    subPanesHidden: { value: false },
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
    subPanesHidden: { value: false },
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

  // --- Finding 1 / Finding 2 regressions (adversarial review) -----------------
  // These exercise templates.ts's WIRING to effectiveCalcParams, not the helper's
  // real return values (those live in indicators.ts, which imports klinecharts and
  // isn't node-testable here — verified instead by reading the installed
  // klinecharts dist; see the verified-defaults table + source-line comments on
  // BUILTIN_CALC_PARAMS/defaultCalcParams in indicators.ts).

  it("Finding 1: a settings-opened MACD (explicit stored calcParams) matches a template MACD with no saved config — no duplicate", () => {
    // Simulates indicators.ts's real behavior: MACD's built-in default is
    // [12,26,9] (verified against klinecharts dist), so an absent saved value
    // normalizes to the SAME array a settings-modal-persisted default would.
    vi.mocked(I.effectiveCalcParams).mockImplementation((type, saved) =>
      type === "MACD" ? (saved ?? [12, 26, 9]) : saved,
    );
    P.saveIndicators(SCOPE, [{ id: "MACD", type: "MACD" }]);
    P.saveIndicatorConfig(SCOPE, "MACD", { calcParams: [12, 26, 9] });

    T.applySymbolTemplate(stubChart, controller, SCOPE, EPIC, template({
      indicators: [{ id: "MACD", type: "MACD" }],
      indicatorConfigs: {}, // template side never had its settings modal opened — no stored config
    }));

    expect(P.loadIndicators(SCOPE).filter((i) => i.type === "MACD")).toHaveLength(1);
  });

  it("Finding 2: a legacy 3-length RSI config signatures by its EFFECTIVE (sliced) length, not the raw stored array", () => {
    // Faithful mock of indicators.ts's effectiveCalcParams for RSI: mirrors
    // applyIndicator's migration (slice a longer-than-override saved array to
    // the override's length — DEFAULT_CALC_PARAMS.RSI = [14] has length 1), and
    // an absent saved value falls back to that [14] default. NOTE the contract:
    // the slice keeps the saved FIRST length ([14,12,24] → [14], [6,12,24] →
    // [6] — NOT → [14]); that's what actually renders on the chart, so identity
    // follows it.
    vi.mocked(I.effectiveCalcParams).mockImplementation((type, saved) => {
      if (type !== "RSI") return saved;
      if (!saved) return [14]; // template side: no config → RSI's TradingView-shape default
      return saved.length > 1 ? saved.slice(0, 1) : saved; // legacy 3-length migration
    });

    // Legacy [14,12,24] (user had set length 14 under the old 3-length shape)
    // → effective [14]; config-less template RSI → default [14] → MATCH, no dup.
    P.saveIndicators(SCOPE, [{ id: "RSI", type: "RSI" }]);
    P.saveIndicatorConfig(SCOPE, "RSI", { calcParams: [14, 12, 24] });

    T.applySymbolTemplate(stubChart, controller, SCOPE, EPIC, template({
      indicators: [{ id: "RSI", type: "RSI" }],
      indicatorConfigs: {}, // template's RSI is a fresh default, no stored config
    }));

    expect(P.loadIndicators(SCOPE).filter((i) => i.type === "RSI")).toHaveLength(1);
  });

  it("Finding 2 companion: a legacy RSI whose effective length differs from the default genuinely adds a second RSI", () => {
    vi.mocked(I.effectiveCalcParams).mockImplementation((type, saved) => {
      if (type !== "RSI") return saved;
      if (!saved) return [14];
      return saved.length > 1 ? saved.slice(0, 1) : saved;
    });

    // Legacy [6,12,24] → effective [6]: the chart really renders RSI(6). The
    // config-less template RSI is RSI(14). Different lengths ARE different
    // indicators — adding a second one is intended behavior, not a missed dedup.
    P.saveIndicators(SCOPE, [{ id: "RSI", type: "RSI" }]);
    P.saveIndicatorConfig(SCOPE, "RSI", { calcParams: [6, 12, 24] });

    T.applySymbolTemplate(stubChart, controller, SCOPE, EPIC, template({
      indicators: [{ id: "RSI", type: "RSI" }],
      indicatorConfigs: {},
    }));

    expect(P.loadIndicators(SCOPE).filter((i) => i.type === "RSI")).toHaveLength(2);
  });
});

describe("captureDefaultTemplate includeIds", () => {
  it("captures only the selected instance ids", () => {
    P.saveIndicators(SCOPE, [
      { id: "EMA#1", type: "EMA" },
      { id: "RSI#1", type: "RSI" },
    ]);
    const only = T.captureDefaultTemplate(SCOPE, new Set(["EMA#1"]));
    expect(only.indicators.map((i) => i.id)).toEqual(["EMA#1"]);
  });
  it("captures all symbol-agnostic indicators when includeIds omitted", () => {
    P.saveIndicators(SCOPE, [
      { id: "EMA#1", type: "EMA" },
      { id: "AVWAP#1", type: "AVWAP" },
    ]);
    const all = T.captureDefaultTemplate(SCOPE);
    expect(all.indicators.map((i) => i.id)).toEqual(["EMA#1"]); // AVWAP filtered
  });
});
