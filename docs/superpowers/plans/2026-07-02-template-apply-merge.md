# Template Apply = Additive Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make chart-template Apply purely additive — it only adds indicators/drawings missing from the chart (matched by computed content signatures), never modifies or removes existing ones — fixing the drawing-wipe data-loss bug.

**Architecture:** A new node-safe module `templateSignatures.ts` computes identity signatures at apply-time (nothing new is persisted). `applySymbolTemplate` in `templates.ts` is rewritten from replace-and-clear to signature-diffed union; `clearFirst` is deleted everywhere. Spec: `docs/superpowers/specs/2026-07-02-template-apply-merge-design.md`.

**Tech Stack:** TypeScript, React, klinecharts, vitest (unit, node env — klinecharts must NOT be imported by unit-tested modules), Playwright (e2e).

## Global Constraints

- All frontend work in `/Users/mahmoudparham/auto_trader/frontend`. Unit tests: `npm run test:unit`. Typecheck+build: `npm run build`.
- Commit directly to `main` (1-person team; never create a branch).
- No backward-compat/migration code — there is no old data to support. `clearFirst` is deleted, not deprecated.
- `frontend/src/lib/templates.test.ts` mocks `./indicators` (it transitively imports klinecharts, unavailable in the node test env). Any new export of `indicators.ts` used by `templates.ts` MUST be added to that mock.
- e2e specs MUST stub `**/api/state` and `**/api/state/**` to `{}` (the live backend at :8000 otherwise overwrites localStorage and pollutes the shared workspace). Do NOT run the full e2e suite — only the spec file this plan touches.
- Indicator identity = type + effective calcParams + extendData minus denylist (`userVisible`, `visibility`, `indType`) + AVWAP anchor. Styling (`styles`, `visible`) is NEVER identity.
- Drawing identity = `name` + points (numbers rounded to 8 decimals). Styles/lock/zLevel/visible are NEVER identity.
- Existing wins on match: a matched template item is skipped entirely — no config/style update of the existing item.

---

### Task 1: Signature module (`templateSignatures.ts`)

**Files:**
- Create: `frontend/src/lib/templateSignatures.ts`
- Test: `frontend/src/lib/templateSignatures.test.ts`

**Interfaces:**
- Consumes: `SavedOverlay` type from `./persist` (type-only import; node-safe).
- Produces (used by Task 2):
  - `interface IndicatorIdentity { type: string; calcParams?: number[]; extendData?: Record<string, unknown>; anchor?: number }`
  - `indicatorSignature(x: IndicatorIdentity): string`
  - `drawingSignature(d: SavedOverlay): string`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/templateSignatures.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { indicatorSignature, drawingSignature } from "./templateSignatures";
import type { SavedOverlay } from "./persist";

describe("indicatorSignature", () => {
  it("matches same type + same calcParams", () => {
    expect(indicatorSignature({ type: "EMA", calcParams: [20] })).toBe(
      indicatorSignature({ type: "EMA", calcParams: [20] }),
    );
  });

  it("differs on type and on calcParams", () => {
    expect(indicatorSignature({ type: "EMA", calcParams: [20] })).not.toBe(
      indicatorSignature({ type: "MA", calcParams: [20] }),
    );
    expect(indicatorSignature({ type: "EMA", calcParams: [20] })).not.toBe(
      indicatorSignature({ type: "EMA", calcParams: [9] }),
    );
  });

  it("ignores the non-identifying extendData keys (userVisible/visibility/indType)", () => {
    const a = indicatorSignature({
      type: "EMA",
      calcParams: [20],
      extendData: { userVisible: false, indType: "EMA", visibility: { mode: "all" } },
    });
    const b = indicatorSignature({ type: "EMA", calcParams: [20], extendData: {} });
    expect(a).toBe(b);
  });

  it("treats identifying extendData (e.g. MTF timeframe, source) as identity", () => {
    const a = indicatorSignature({ type: "EMA", calcParams: [20], extendData: { timeframe: "1h" } });
    const b = indicatorSignature({ type: "EMA", calcParams: [20], extendData: { timeframe: "4h" } });
    expect(a).not.toBe(b);
  });

  it("extendData key order does not matter", () => {
    const a = indicatorSignature({ type: "LR", extendData: { source: "close", mult: 2 } });
    const b = indicatorSignature({ type: "LR", extendData: { mult: 2, source: "close" } });
    expect(a).toBe(b);
  });

  it("AVWAP anchor is identity", () => {
    const a = indicatorSignature({ type: "AVWAP", anchor: 1700000000000 });
    const b = indicatorSignature({ type: "AVWAP", anchor: 1800000000000 });
    const c = indicatorSignature({ type: "AVWAP", anchor: 1700000000000 });
    expect(a).not.toBe(b);
    expect(a).toBe(c);
  });

  it("two unplaced AVWAPs (no anchor) match", () => {
    expect(indicatorSignature({ type: "AVWAP" })).toBe(indicatorSignature({ type: "AVWAP" }));
  });
});

describe("drawingSignature", () => {
  const line = (over?: Partial<SavedOverlay>): SavedOverlay => ({
    name: "horizontalStraightLine",
    points: [{ timestamp: 1700000000000, value: 18000 }],
    ...over,
  });

  it("matches same type + same points regardless of style/lock/zLevel/visible", () => {
    const plain = drawingSignature(line());
    const styled = drawingSignature(
      line({ styles: { line: { color: "#f00" } }, lock: true, zLevel: 5, visible: false }),
    );
    expect(styled).toBe(plain);
  });

  it("differs on tool type and on points", () => {
    expect(drawingSignature(line({ name: "priceLine" }))).not.toBe(drawingSignature(line()));
    expect(
      drawingSignature(line({ points: [{ timestamp: 1700000000000, value: 18001 }] })),
    ).not.toBe(drawingSignature(line()));
  });

  it("absorbs float noise in point values", () => {
    const noisy = drawingSignature(line({ points: [{ timestamp: 1700000000000, value: 18000.000000000004 }] }));
    expect(noisy).toBe(drawingSignature(line()));
  });

  it("distinguishes point count and dataIndex-anchored points", () => {
    const twoPoint = drawingSignature(
      line({
        name: "straightLine",
        points: [
          { timestamp: 1700000000000, value: 18000 },
          { timestamp: 1700003600000, value: 18100 },
        ],
      }),
    );
    const oneMoved = drawingSignature(
      line({
        name: "straightLine",
        points: [
          { timestamp: 1700000000000, value: 18000 },
          { timestamp: 1700003600000, value: 18200 },
        ],
      }),
    );
    expect(twoPoint).not.toBe(oneMoved);
    expect(drawingSignature(line({ points: [{ dataIndex: 250, value: 18000 }] }))).not.toBe(
      drawingSignature(line()),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/mahmoudparham/auto_trader/frontend && npx vitest run src/lib/templateSignatures.test.ts`
Expected: FAIL — `Cannot find module './templateSignatures'` (or equivalent resolve error).

- [ ] **Step 3: Write the implementation**

Create `frontend/src/lib/templateSignatures.ts`:

```ts
// Apply-time identity signatures for the template MERGE (see
// docs/superpowers/specs/2026-07-02-template-apply-merge-design.md).
//
// "Is this template item already on the chart?" is answered by comparing
// signatures computed on the fly from the persisted shapes — nothing new is
// stored, so there's no schema change and no id to keep in sync. Signatures
// deliberately EXCLUDE styling (color/width/visible): an existing EMA(20) in red
// and the template's EMA(20) in blue are the SAME indicator, and Apply must skip
// it (existing wins), not duplicate or restyle it.
//
// Node-safe on purpose: no klinecharts imports (type-only import from persist),
// so templates.test.ts / this module's own tests run in the node env unmocked.

import type { SavedOverlay } from "./persist";

// extendData keys that do NOT identify an indicator — display/bookkeeping state,
// not inputs. A DENYLIST (not an allowlist) so a future input field (a new source
// mode, band setting, …) is identity-relevant by default instead of silently
// ignored. Keep in step with the fields applyIndicator/settings write:
//  - userVisible : the eye-toggle intent
//  - visibility  : the per-interval visibility model
//  - indType     : bookkeeping (mirrors the instance's type, already in the sig)
const NON_IDENTIFYING_EXTEND_KEYS = new Set(["userVisible", "visibility", "indType"]);

// The identity-relevant slice of extendData with deterministically-ordered keys.
// (Values are compared structurally via JSON; nested objects come from the same
// stored round-trip on both sides, so their key order is stable in practice.)
function identifyingExtend(
  extendData: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(extendData ?? {}).sort()) {
    if (!NON_IDENTIFYING_EXTEND_KEYS.has(k)) out[k] = extendData![k];
  }
  return out;
}

// Identity of one indicator instance. `calcParams` must be the EFFECTIVE params —
// the caller normalizes an absent saved value to the type's defaults (see
// savedIndicatorSignature in templates.ts) so a default-length EMA matches a
// default-length EMA. `anchor` is AVWAP's placed anchor (ms); undefined when
// unplaced or not an AVWAP.
export interface IndicatorIdentity {
  type: string;
  calcParams?: number[];
  extendData?: Record<string, unknown>;
  anchor?: number;
}

export function indicatorSignature(x: IndicatorIdentity): string {
  return JSON.stringify([
    x.type,
    x.calcParams ?? null,
    identifyingExtend(x.extendData),
    x.anchor ?? null,
  ]);
}

// Round to absorb float noise (a pixel→price conversion can yield
// 18000.000000000004 for a stored 18000) while never colliding two prices a
// real tick apart — display precisions are ≤ ~5 decimals.
const round = (n: number) => Number(n.toFixed(8));

// Drawing identity: tool type + geometry. A trendline at the same coordinates is
// the same line whatever its color; styles/lock/zLevel/visible are NOT identity.
export function drawingSignature(d: SavedOverlay): string {
  return JSON.stringify([
    d.name,
    d.points.map((p) => [
      p.timestamp != null ? round(p.timestamp) : null,
      p.dataIndex != null ? round(p.dataIndex) : null,
      p.value != null ? round(p.value) : null,
    ]),
  ]);
}
```

Note: `SavedOverlay.styles` is typed `DeepPartial<OverlayStyle> | null` — the test's `styles: { line: { color: "#f00" } }` literal satisfies it. If tsc complains about the literal, cast it with `as SavedOverlay["styles"]`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/templateSignatures.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/mahmoudparham/auto_trader
git add frontend/src/lib/templateSignatures.ts frontend/src/lib/templateSignatures.test.ts
git commit -m "feat(templates): apply-time identity signatures for template merge"
```

---

### Task 2: Merge rewrite of `applySymbolTemplate` (+ indicator helper exports)

**Files:**
- Modify: `frontend/src/lib/indicators.ts` (export `mintInstanceId`; add `defaultCalcParams`)
- Modify: `frontend/src/lib/templates.ts` (rewrite `applySymbolTemplate`; drop `clearFirst` everywhere)
- Test: `frontend/src/lib/templates.test.ts`

**Interfaces:**
- Consumes: `indicatorSignature`, `drawingSignature`, `IndicatorIdentity` from `./templateSignatures` (Task 1).
- Produces (used by Task 3):
  - `applySymbolTemplate(chart: Chart, controller: ChartController, scope: string, epic: string, t: SymbolTemplate): void` — NO `opts` parameter anymore.
  - `applyDefaultTemplate(chart: Chart, controller: ChartController, scope: string, epic: string, t: DefaultTemplate): void` — NO `opts` parameter anymore.
  - `maybeAutoApplyTemplate` — signature unchanged.
  - From `indicators.ts`: `export function mintInstanceId(chart: Chart, type: string): string` (existing function, now exported) and `export function defaultCalcParams(type: string): number[] | undefined` (new).

- [ ] **Step 1: Update the `./indicators` mock and existing assertions in `templates.test.ts`**

In `frontend/src/lib/templates.test.ts`, replace the existing `vi.mock("./indicators", ...)` block with (the factory closure keeps its own counter; `vi.mock` factories cannot reference outer `let` bindings because of hoisting):

```ts
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
```

Then update the two auto-apply assertions in the `maybeAutoApplyTemplate gate` describe — the merge path mints fresh ids, so assert TYPE not id:

- In `"applies the global default onto a fresh cell when no per-symbol template exists"` change
  `expect(applied.map((i) => i.id)).toEqual(["VOL"]);` to
  `expect(applied.map((i) => (i as { type: string }).type)).toEqual(["VOL"]);`
- In `"prefers the per-symbol template over the global default (specific beats general)"` change
  `expect(applied.map((i) => i.id)).toEqual(["RSI"]);` to
  `expect(applied.map((i) => (i as { type: string }).type)).toEqual(["RSI"]);`

Also widen the `applied` capture type so `.type` reads cleanly:
change `let applied: { id: string }[] = [];` to `let applied: { id: string; type: string }[] = [];`
and the setter cast accordingly (`set: (v: { id: string; type: string }[]) => (applied = v)`).

- [ ] **Step 2: Add the failing merge tests**

Append to `frontend/src/lib/templates.test.ts` (top-level, after the existing describes):

```ts
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
```

- [ ] **Step 3: Run tests to verify the new ones fail**

Run: `npx vitest run src/lib/templates.test.ts`
Expected: FAIL — the new merge describe fails against the old replace semantics (e.g. the union tests see the template REPLACE the drawings/indicator list, the "existing wins" test sees the existing EMA config clobbered). The pre-existing capture/gate tests still pass (their updated assertions check `type`, which old and new code both satisfy).

- [ ] **Step 4: Export `mintInstanceId` and add `defaultCalcParams` in `indicators.ts`**

In `frontend/src/lib/indicators.ts`:

1. Change the `mintInstanceId` declaration (around line 161) from
   `function mintInstanceId(chart: Chart, type: string): string {` to
   `export function mintInstanceId(chart: Chart, type: string): string {`

2. Directly below the `DEFAULT_CALC_PARAMS` const (after line ~60), add:

```ts
// The EFFECTIVE default calcParams for a type when an instance carries no saved
// config: our TradingView-shape overrides first (RSI → [14]), then the custom
// template's own defaults (EMA → [9], MA → [20], LR → [100,2], …). Built-in
// klinecharts types without an override (MACD/BOLL/…) return undefined —
// klinecharts applies its own defaults, and BOTH sides of a template-merge
// signature comparison normalize through this same function, so undefined
// matches undefined. Used by templates.ts's savedIndicatorSignature.
export function defaultCalcParams(type: string): number[] | undefined {
  return (
    DEFAULT_CALC_PARAMS[type] ??
    (isCustomType(type) ? (BASE_TEMPLATES[type].calcParams as number[] | undefined) : undefined)
  );
}
```

- [ ] **Step 5: Rewrite `applySymbolTemplate` in `templates.ts`**

Replace the whole of `applySymbolTemplate` (including its doc comment) and update the module around it:

1. Update imports: drop `removeIndicatorById`; add `mintInstanceId`, `defaultCalcParams` and the signature module:

```ts
import { applyIndicator, mintInstanceId, defaultCalcParams } from "./indicators";
import {
  indicatorSignature,
  drawingSignature,
  type IndicatorIdentity,
} from "./templateSignatures";
```

Also add `IndicatorInstance` to the type imports from `./persist` (it's referenced by the new helper):

```ts
  type IndicatorInstance,
```

2. Add the signature helper + new apply (replacing the old `applySymbolTemplate`):

```ts
// The identity signature of one saved instance, from its stored config and (for
// AVWAP) its separately-stored anchor. calcParams are normalized to the type's
// effective defaults when the config carries none, so a default-length EMA
// matches a default-length EMA. AVWAP is special: its calcParams[0] IS the anchor
// (never meaningfully stored in config), so identity uses the anchor field
// instead — 0/absent normalizes to undefined so two unplaced AVWAPs match.
function savedIndicatorSignature(
  inst: IndicatorInstance,
  cfg: SavedIndicatorConfig | undefined,
  anchor: number | undefined,
): string {
  const identity: IndicatorIdentity = {
    type: inst.type,
    calcParams:
      inst.type === "AVWAP" ? undefined : cfg?.calcParams ?? defaultCalcParams(inst.type),
    extendData: cfg?.extendData,
    anchor: inst.type === "AVWAP" && anchor ? anchor : undefined,
  };
  return indicatorSignature(identity);
}

// Apply a template onto a cell — ADDITIVE MERGE, existing wins (see
// docs/superpowers/specs/2026-07-02-template-apply-merge-design.md). For each
// template indicator/drawing we compute its identity signature and add it only
// if no equivalent is already on the chart; matched items are skipped entirely
// (the existing instance keeps its id, config and styling). Nothing is ever
// modified or removed, so Apply is idempotent and can never destroy user work
// (the old replace-and-clear semantics silently wiped drawings when the
// template held none).
//
// Order per added indicator is load-bearing: its AVWAP anchor is written BEFORE
// applyIndicator (rehydrate:true reads the anchor from storage); its config is
// written after success (applyIndicator gets it explicitly via opts.config, and
// a failed add must not leave an orphaned config behind).
export function applySymbolTemplate(
  chart: Chart,
  controller: ChartController,
  scope: string,
  epic: string,
  t: SymbolTemplate,
): void {
  // --- indicators: add what's missing, never touch what exists ---------------
  const existing = loadIndicators(scope);
  const existingCfgs = loadIndicatorConfigs(scope);
  const have = new Set(
    existing.map((inst) =>
      savedIndicatorSignature(inst, existingCfgs[inst.id], loadAvwapAnchor(scope, epic, inst.id)),
    ),
  );

  const added: IndicatorInstance[] = [];
  for (const inst of t.indicators) {
    const sig = savedIndicatorSignature(inst, t.indicatorConfigs[inst.id], t.avwapAnchors[inst.id]);
    if (have.has(sig)) continue; // an equivalent indicator is already on the chart
    have.add(sig); // two identical template rows still add only once
    // Fresh id in the target cell — the template's id may collide with an
    // existing instance (ids are the bare type name or a random suffix).
    const id = mintInstanceId(chart, inst.type);
    const anchor = t.avwapAnchors[inst.id];
    if (anchor) saveAvwapAnchor(scope, epic, id, anchor);
    const cfg = t.indicatorConfigs[inst.id];
    const ok = applyIndicator(chart, scope, epic, { id, type: inst.type }, {
      rehydrate: true,
      config: cfg,
      // Honor the cell's master "Hide indicators" switch — a template applied
      // while it's on must not repaint indicators the sidebar eye says are hidden.
      forceHidden: controller.indicatorsHidden.value,
    });
    if (!ok) continue;
    if (cfg) saveIndicatorConfig(scope, id, cfg);
    added.push({ id, type: inst.type });
  }
  if (added.length > 0) {
    const full = [...existing, ...added];
    saveIndicators(scope, full);
    controller.indicators.set(full);
  }

  // --- drawings: union by geometry, never remove ------------------------------
  const existingDrawings = loadDrawings(scope, epic);
  const haveDrawings = new Set(existingDrawings.map(drawingSignature));
  const newDrawings = t.drawings.filter((d) => {
    const sig = drawingSignature(d);
    if (haveDrawings.has(sig)) return false;
    haveDrawings.add(sig);
    return true;
  });
  if (newDrawings.length > 0) {
    saveDrawings(scope, epic, [...existingDrawings, ...newDrawings]);
    // Rebuild the live overlays from the union we just wrote. Skipped when
    // nothing was added — a rehydrate re-mints overlay ids and drops selection,
    // so a no-op Apply must not churn the chart.
    controller.overlays.rehydrate();
  }
}
```

3. Update the module header comment (lines 1–13): replace the sentence about apply writing blobs into the target scope with a note that apply is an additive merge (signatures decide duplicates; existing wins) — keep the AVWAP-anchor-order note.

4. `applyDefaultTemplate`: remove the `opts?: { clearFirst?: boolean }` parameter and the `opts` argument in its delegation; update its doc comment ("the shared path merges the indicators in and, with an empty drawings list, touches no drawings — so applying the default can never affect existing drawings").

5. `maybeAutoApplyTemplate`: drop the `{ clearFirst: false }` / `opts` arguments from both apply calls. Keep the gate and precedence exactly as they are.

- [ ] **Step 6: Run the unit tests**

Run: `npx vitest run src/lib/templates.test.ts src/lib/templateSignatures.test.ts`
Expected: PASS (all — including the pre-existing capture/gate tests with the two updated assertions).

- [ ] **Step 7: Commit**

```bash
cd /Users/mahmoudparham/auto_trader
git add frontend/src/lib/templates.ts frontend/src/lib/indicators.ts frontend/src/lib/templates.test.ts
git commit -m "feat(templates): Apply merges additively — never wipes drawings, dedups by signature"
```

---

### Task 3: Toolbar call sites (drop `clearFirst`) + full verification

**Files:**
- Modify: `frontend/src/Toolbar.tsx` (~lines 259–308)

**Interfaces:**
- Consumes: the new 5-arg `applySymbolTemplate` / `applyDefaultTemplate` from Task 2.
- Produces: nothing new — UI wiring only.

- [ ] **Step 1: Update the two apply call sites**

In `frontend/src/Toolbar.tsx`:

1. `applyTemplate()` (~line 271): remove the options object —

```ts
  function applyTemplate() {
    if (!chart || !controller || !symbol) return;
    const t = loadSymbolTemplate(symbol.epic);
    if (!t) return;
    applySymbolTemplate(chart, controller, controller.scope, symbol.epic, t);
    setTmplOpen(false);
    toast(`Applied ${symbol.epic} template`);
  }
```

2. `applyDefault()` (~line 299): same —

```ts
  function applyDefault() {
    if (!chart || !controller || !symbol) return;
    const d = loadDefaultTemplate();
    if (!d) return;
    applyDefaultTemplate(chart, controller, controller.scope, symbol.epic, d);
    setTmplOpen(false);
    toast("Applied default template");
  }
```

3. Update the section comment above `saveTemplate()` (~lines 259–263): replace
   "Apply replaces the cell's layout with it (clearFirst, since the cell may be populated);"
   with
   "Apply MERGES it into the cell — adds what's missing, skips equivalents, never touches existing work;"

- [ ] **Step 2: Typecheck + build + full unit suite**

Run: `cd /Users/mahmoudparham/auto_trader/frontend && npm run build && npm run test:unit`
Expected: build passes with no TS errors (`clearFirst` no longer referenced anywhere — if tsc reports an unused import or leftover reference, fix it); all unit tests pass.

- [ ] **Step 3: Commit**

```bash
cd /Users/mahmoudparham/auto_trader
git add frontend/src/Toolbar.tsx
git commit -m "feat(toolbar): template Apply is additive — clearFirst removed"
```

---

### Task 4: e2e — manual Apply merges instead of replacing

**Files:**
- Modify: `frontend/e2e/symbol-template.spec.ts` (append one test; reuse the file's existing helpers `activeTypes`, `indicatorMenu`, `waitForData`, `focusedDrawingCount`)

**Interfaces:**
- Consumes: the running dev stack (frontend :5173 via the user's HMR server, backend :8000 — do NOT restart them) and the merged Apply semantics from Tasks 2–3.

- [ ] **Step 1: Append the merge e2e test**

Add to `frontend/e2e/symbol-template.spec.ts` (after the existing test, using the same stubbing pattern — the `**/api/state` stub is REQUIRED per the file's isolation comment):

```ts
test("manual Apply merges into a populated chart — keeps drawings, no duplicate indicators", async ({
  page,
}) => {
  await page.route("**/api/state", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await page.route("**/api/state/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await seedSingleChartDefault(page);
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();
  await waitForData(page);

  // --- Save a template containing just EMA (no drawings). ---
  const m = indicatorMenu(page);
  await m.add("EMA");
  await expect.poll(() => activeTypes(page)).toContain("EMA");
  await page.locator(".menu button", { hasText: "Template" }).click();
  await page.locator(".menu .dropdown li", { hasText: /^Save US100 template$/ }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.keys(localStorage).some((k) => k.startsWith("auto-trader.template.")),
      ),
    )
    .toBe(true);

  // --- Change the chart: add RSI and draw a horizontal line. ---
  await m.add("RSI");
  await expect.poll(() => activeTypes(page)).toContain("RSI");
  const canvas = page.locator(".chart-cell").first().locator("canvas").first();
  const box = (await canvas.boundingBox())!;
  const lines = page.locator(".draw-sidebar .ds-family").first();
  await lines.hover();
  await lines.locator(".ds-caret").click();
  await page
    .locator(".draw-sidebar .ds-flyout .ds-row", { hasText: "Horizontal line" })
    .click();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(() => focusedDrawingCount(page)).toBe(1);

  // --- Apply the (drawing-free) template. OLD behavior wiped the drawing and
  // replaced the indicator set; merge must keep BOTH the line and RSI, and must
  // not duplicate the EMA the chart already has. ---
  await page.locator(".menu button", { hasText: "Template" }).click();
  await page.locator(".menu .dropdown li", { hasText: /^Apply US100 template$/ }).click();

  await expect.poll(() => focusedDrawingCount(page)).toBe(1); // drawing survived
  await expect
    .poll(async () => (await activeTypes(page)).filter((n) => n.startsWith("EMA")).length)
    .toBe(1); // no duplicate EMA
  await expect.poll(() => activeTypes(page)).toContain("RSI"); // untouched

  // --- Apply again: idempotent, still exactly one EMA and one drawing. ---
  await page.locator(".menu button", { hasText: "Template" }).click();
  await page.locator(".menu .dropdown li", { hasText: /^Apply US100 template$/ }).click();
  await expect
    .poll(async () => (await activeTypes(page)).filter((n) => n.startsWith("EMA")).length)
    .toBe(1);
  await expect.poll(() => focusedDrawingCount(page)).toBe(1);
});
```

Note: `activeTypes` returns klinecharts instance NAMES (ids). A duplicated EMA would appear as a second name with the `EMA#…` suffix, so counting names that start with `"EMA"` detects duplication. The dedup relies on the template's saved EMA config matching the live one — both come from the same add with no edits, so both sides have no saved calcParams and normalize identically.

- [ ] **Step 2: Run ONLY this spec**

Run: `cd /Users/mahmoudparham/auto_trader/frontend && npx playwright test e2e/symbol-template.spec.ts`
Expected: both tests in the file PASS (the pre-existing auto-apply test is unaffected by merge — its target cell is empty, so merge == full apply). Do NOT run the whole e2e suite (live-backend contention makes unrelated specs flaky and pollutes the shared workspace).

- [ ] **Step 3: Commit**

```bash
cd /Users/mahmoudparham/auto_trader
git add frontend/e2e/symbol-template.spec.ts
git commit -m "test(templates): e2e — manual Apply merges (drawings survive, no dupes, idempotent)"
```
