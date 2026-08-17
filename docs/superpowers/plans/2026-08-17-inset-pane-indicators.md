# Inset Pane Indicators Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let RSI, ATR and SLOPE be displayed inside the candle pane, in a shared translucent band across its bottom, instead of opening their own sub-pane and eating the chart's vertical space.

**Architecture:** An inset instance is created on `candle_pane` (the way EMA already is) from a per-instance template clone whose `figures` are emptied and whose `draw` is a generic wrapper. The wrapper translates the canvas to a band rect, clips to it, and calls the base template's own `draw` with a substitute `yAxis` whose `convertToPixel` maps the indicator's value domain into the band. Because every value-to-pixel conversion in our pane-indicator draws goes through that one method, RSI's overbought/oversold zones, smoothing line and divergence segments (and SLOPE's zero and threshold lines) render inside the band with no per-type code. Empty `figures` is what keeps the instance out of klinecharts' price-axis range and precision math.

**Tech Stack:** TypeScript, React 19, klinecharts 10.0.0, vitest 4 (node env, tests colocated in `src/`).

**Spec:** `docs/superpowers/specs/2026-08-17-inset-pane-indicators-design.md`

## Global Constraints

- All paths below are relative to the repo root. The frontend package root is `frontend/`; run every command from `frontend/`.
- Test command: `npx vitest run <path>` for one file, `npm run test:unit` for all. Typecheck: `npx tsc -b --noEmit`. Lint: `npm run lint`.
- **The test baseline is NOT green on `main`** (5 to 7 known failures, several order-sensitive). Never "fix" a failure you did not cause. Before claiming a suite passes, compare against `git stash`-ed baseline output if unsure.
- vitest runs in the `node` env. A test importing a module that touches `localStorage` at module-eval time must call `installMemStorage()` from `src/lib/testMemStorage.ts` **before** the dynamic `await import(...)`. A test importing anything under `lib/indicators/` or `lib/customIndicators.ts` must `vi.mock("klinecharts", ...)` first, because those modules call `registerIndicator` at import time.
- **No em dashes in user-facing copy** (menu labels, tooltips, messages). Use parentheses or colons. Code comments and commit messages are exempt.
- Use the shared `Tooltip` / `InfoTip` components rather than native `title=` for any new tooltip (see `CLAUDE.md`). This plan adds no new tooltips.
- Inset-capable types are exactly `RSI`, `ATR`, `SLOPE`. `SLOPE_ACCEL` is derived state that inherits from its parent and is never independently inset. `PROXIMITY_HEATMAP` is already a candle-pane indicator and is explicitly NOT inset-capable.
- Commit after each task with the repo's conventional-commit style (`feat(inset): ...`, `fix(...)`, `test(...)`).

---

## File Structure

**Created:**
- `frontend/src/lib/indicators/inset.ts` — the whole feature's logic: capability set, band geometry, domain resolution, the draw wrapper, the inset template factory, and the legend/instance helpers. One module so the inset knowledge has exactly one home.
- `frontend/src/lib/indicators/inset.test.ts` — unit tests for everything in that module.

**Modified:**
- `frontend/src/lib/persist/artifacts.ts` — `IndicatorInstance` gains `inset?: boolean`; `loadIndicators` preserves it.
- `frontend/src/lib/persist.test.ts` — round-trip tests for the flag.
- `frontend/src/lib/indicators.ts` — `registerInstanceTemplate` registers the inset template; `applyIndicator` routes inset instances to `candle_pane` and owns the `extendData.inset` marker; new `isSubPaneInstance`.
- `frontend/src/lib/indicators.test.ts` — routing tests.
- `frontend/src/ChartLegend.tsx` — two figure lookups go through the inset helpers.
- `frontend/src/lib/templates.ts` — two sub-pane checks move to the instance-aware form.
- `frontend/src/chart/useIndicatorCommands.ts` — the `Show as inset` menu item, the `setIndicatorInset` command, and the visibility-persistence guard removal.
- `frontend/src/lib/menuIcons.tsx` — one new icon.

---

## Task 1: Persist the `inset` flag

**Files:**
- Modify: `frontend/src/lib/persist/artifacts.ts:164-181`
- Test: `frontend/src/lib/persist.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `IndicatorInstance` with optional `inset?: boolean`, preserved by `loadIndicators(scope)` and written by `saveIndicators(scope, list)`.

Why this is first: every later task reads or writes this field, and `loadIndicators` currently normalizes each entry to `{ id, type }`, which silently drops anything else. Without this task the feature would appear to work until the first reload.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/lib/persist.test.ts`:

```ts
describe("indicator instance list", () => {
  it("round-trips the inset flag", () => {
    P.saveIndicators("tab.A", [
      { id: "RSI", type: "RSI", inset: true },
      { id: "ATR", type: "ATR" },
    ]);
    expect(P.loadIndicators("tab.A")).toEqual([
      { id: "RSI", type: "RSI", inset: true },
      { id: "ATR", type: "ATR" },
    ]);
  });

  it("migrates the legacy string[] shape without an inset flag", () => {
    localStorage.setItem("auto-trader.tab.A.indicators", JSON.stringify(["EMA", "RSI"]));
    expect(P.loadIndicators("tab.A")).toEqual([
      { id: "EMA", type: "EMA" },
      { id: "RSI", type: "RSI" },
    ]);
  });

  it("keeps a non-inset instance's loaded shape free of the key, so saved payloads stay byte-identical", () => {
    P.saveIndicators("tab.A", [{ id: "MACD", type: "MACD" }]);
    const [only] = P.loadIndicators("tab.A");
    expect(Object.prototype.hasOwnProperty.call(only, "inset")).toBe(false);
    expect(localStorage.getItem("auto-trader.tab.A.indicators")).toBe(
      JSON.stringify([{ id: "MACD", type: "MACD" }]),
    );
  });

  it("drops a stale inset:false rather than carrying a dead key forward", () => {
    localStorage.setItem(
      "auto-trader.tab.A.indicators",
      JSON.stringify([{ id: "RSI", type: "RSI", inset: false }]),
    );
    expect(P.loadIndicators("tab.A")).toEqual([{ id: "RSI", type: "RSI" }]);
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

```bash
cd frontend && npx vitest run src/lib/persist.test.ts -t "indicator instance list"
```

Expected: the round-trip test FAILS (`inset: true` is stripped, received `{ id: "RSI", type: "RSI" }`). The other three may already pass; that is fine, they are regression guards.

- [ ] **Step 3: Add the field and preserve it on load**

In `frontend/src/lib/persist/artifacts.ts`, extend the interface:

```ts
export interface IndicatorInstance {
  id: string;
  type: string;
  // Inset display: this instance draws inside the candle pane's bottom band
  // instead of opening its own sub-pane. Written only when true so existing
  // saved payloads stay byte-identical (templateSignatures compares them).
  inset?: boolean;
}
```

and the loader's normalizer:

```ts
  return raw.map((e) =>
    typeof e === "string"
      ? { id: e, type: e }
      : { id: e.id, type: e.type, ...(e.inset ? { inset: true } : {}) },
  );
```

- [ ] **Step 4: Run the tests and verify they pass**

```bash
cd frontend && npx vitest run src/lib/persist.test.ts
```

Expected: PASS, whole file.

- [ ] **Step 5: Check nothing else broke on the saved-shape comparison**

```bash
cd frontend && npx vitest run src/lib/templateSignatures.test.ts src/lib/templates.test.ts src/lib/snapshots.test.ts
```

Expected: PASS (or the same failures as the pre-change baseline). If a signature test now fails, the `...(e.inset ? ...)` guard is not doing its job: re-read Step 3.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/persist/artifacts.ts frontend/src/lib/persist.test.ts
git commit -m "feat(inset): persist the per-instance inset flag"
```

---

## Task 2: Band geometry and domain math

**Files:**
- Create: `frontend/src/lib/indicators/inset.ts`
- Test: `frontend/src/lib/indicators/inset.test.ts`

**Interfaces:**
- Consumes: `IndicatorInstance` from Task 1 (type only, for `withInset` in Task 3).
- Produces:
  - `INSET_CAPABLE: ReadonlySet<string>`
  - `INSET_PRECISION: 8`, `INSET_BAND_FRACTION: 0.28`, `INSET_BAND_MIN_PX: 56`, `INSET_BAND_MAX_FRACTION: 0.4`
  - `interface InsetRect { top: number; height: number }`
  - `insetBandRect(bounding: { height: number }): InsetRect`
  - `interface InsetSpec { domain: [number, number] | "auto"; pad: number }`
  - `INSET_SPECS: Record<string, InsetSpec>`, `insetSpecOf(type: string): InsetSpec`
  - `resolveDomain(spec: InsetSpec, values: Array<number | undefined | null>): [number, number]`
  - `valueToBandY(value: number, domain: [number, number], height: number): number`

This task is pure math with no klinecharts imports, so its tests need no mocking.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/lib/indicators/inset.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  insetBandRect,
  resolveDomain,
  valueToBandY,
  insetSpecOf,
  INSET_BAND_MIN_PX,
} from "./inset";

describe("insetBandRect", () => {
  it("takes the designed fraction of a roomy pane", () => {
    // 400 * 0.28 = 112, above the 56px floor and below the 160px cap.
    expect(insetBandRect({ height: 400 })).toEqual({ top: 288, height: 112 });
  });

  it("floors at the minimum on a pane where the fraction would be thinner", () => {
    // 150 * 0.28 = 42 -> floored to 56, still under the 60px cap.
    expect(insetBandRect({ height: 150 })).toEqual({ top: 94, height: 56 });
  });

  it("caps at the max fraction, so the band never dwarfs a short pane", () => {
    // 100 * 0.28 = 28 -> floored to 56 -> capped at 40.
    expect(insetBandRect({ height: 100 })).toEqual({ top: 60, height: 40 });
  });

  it("returns a zero band for a zero-height pane instead of a negative rect", () => {
    expect(insetBandRect({ height: 0 })).toEqual({ top: 0, height: 0 });
  });
});

describe("resolveDomain", () => {
  it("returns a fixed domain untouched, ignoring the data", () => {
    expect(resolveDomain({ domain: [0, 100], pad: 0.08 }, [42, 43])).toEqual([0, 100]);
  });

  it("fits an auto domain to the values with symmetric padding", () => {
    // span 10, pad 0.08 -> 0.8 each side
    expect(resolveDomain({ domain: "auto", pad: 0.08 }, [10, 20])).toEqual([9.2, 20.8]);
  });

  it("ignores nulls, undefined and non-finite values", () => {
    expect(resolveDomain({ domain: "auto", pad: 0 }, [null, 5, undefined, NaN, 7])).toEqual([5, 7]);
  });

  it("falls back to a unit domain when nothing is finite", () => {
    expect(resolveDomain({ domain: "auto", pad: 0.08 }, [null, undefined])).toEqual([0, 1]);
  });

  it("keeps a flat series flat rather than inventing a span", () => {
    expect(resolveDomain({ domain: "auto", pad: 0.08 }, [3, 3, 3])).toEqual([3, 3]);
  });
});

describe("valueToBandY", () => {
  it("puts the domain max at the band top and the min at the bottom", () => {
    expect(valueToBandY(100, [0, 100], 80)).toBe(0);
    expect(valueToBandY(0, [0, 100], 80)).toBe(80);
    expect(valueToBandY(50, [0, 100], 80)).toBe(40);
  });

  it("clamps out-of-domain values to the band edges", () => {
    expect(valueToBandY(150, [0, 100], 80)).toBe(0);
    expect(valueToBandY(-20, [0, 100], 80)).toBe(80);
  });

  it("centres a degenerate domain instead of dividing by zero", () => {
    expect(valueToBandY(3, [3, 3], 80)).toBe(40);
  });
});

describe("insetSpecOf", () => {
  it("pins RSI to a fixed 0-100 domain so its levels sit still", () => {
    expect(insetSpecOf("RSI").domain).toEqual([0, 100]);
  });

  it("auto-scales ATR and SLOPE", () => {
    expect(insetSpecOf("ATR").domain).toBe("auto");
    expect(insetSpecOf("SLOPE").domain).toBe("auto");
  });

  it("auto-scales an unknown type rather than throwing", () => {
    expect(insetSpecOf("NOPE").domain).toBe("auto");
  });
});

describe("constants", () => {
  it("keeps the band floor above a legible minimum", () => {
    expect(INSET_BAND_MIN_PX).toBeGreaterThanOrEqual(40);
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

```bash
cd frontend && npx vitest run src/lib/indicators/inset.test.ts
```

Expected: FAIL, "Failed to resolve import ./inset".

- [ ] **Step 3: Write the module**

Create `frontend/src/lib/indicators/inset.ts`:

```ts
// Inset display for the pane indicators whose templates we own (RSI/ATR/SLOPE):
// the instance is created on candle_pane and paints into a shared band across the
// pane's bottom instead of opening its own sub-pane, so the candles keep the full
// height and the price axis keeps every tick.
//
// This file is pure geometry + domain math up top; the klinecharts-facing parts
// (template factory, draw wrapper, legend helpers) live below it.

/** Pane indicator TYPES that can be inset. Only types whose templates we author:
 *  a klinecharts built-in (MACD/VOL/KDJ) renders through figures bound to the
 *  pane's y-axis, and its template is not readable (no getIndicatorClass). */
export const INSET_CAPABLE: ReadonlySet<string> = new Set(["RSI", "ATR", "SLOPE"]);

/** Precision an inset instance reports. The pane's tick precision is the MIN over
 *  its indicators (klinecharts createRangeImp), so a high value here means the
 *  price axis keeps its own precision. The real precision is read back off the
 *  base template for the legend and the in-band label. */
export const INSET_PRECISION = 8;

export const INSET_BAND_FRACTION = 0.28;
export const INSET_BAND_MIN_PX = 56;
export const INSET_BAND_MAX_FRACTION = 0.4;

export interface InsetRect {
  top: number; // pane-local y of the band's top edge
  height: number;
}

/** The shared band, anchored to the pane's bottom edge. The max-fraction cap is
 *  applied last and always, so a short pane gets a proportionally short band
 *  rather than one taller than its pane. */
export function insetBandRect(bounding: { height: number }): InsetRect {
  const paneH = Math.max(0, bounding.height);
  const height = Math.max(
    0,
    Math.min(
      Math.max(paneH * INSET_BAND_FRACTION, INSET_BAND_MIN_PX),
      paneH * INSET_BAND_MAX_FRACTION,
    ),
  );
  return { top: paneH - height, height };
}

export interface InsetSpec {
  /** Fixed value range, or "auto" to fit the visible data. */
  domain: [number, number] | "auto";
  /** Padding as a fraction of the fitted span. Ignored for a fixed domain. */
  pad: number;
}

// Mirrors the { top: 0.08, bottom: 0.08 } y-axis gap the sub-pane path applies,
// so an auto-scaled inset breathes like its pane version does.
const AUTO: InsetSpec = { domain: "auto", pad: 0.08 };

export const INSET_SPECS: Record<string, InsetSpec> = {
  // Fixed, so the overbought/oversold levels sit at a stable height instead of
  // drifting with the data.
  RSI: { domain: [0, 100], pad: 0 },
  ATR: AUTO,
  SLOPE: AUTO,
};

export function insetSpecOf(type: string): InsetSpec {
  return INSET_SPECS[type] ?? AUTO;
}

/** Concrete [lo, hi] for a spec over the values actually on screen. */
export function resolveDomain(
  spec: InsetSpec,
  values: Array<number | undefined | null>,
): [number, number] {
  if (spec.domain !== "auto") return spec.domain;
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const v of values) {
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  // Nothing finite on screen (warmup bars only): a unit domain keeps the band
  // drawable and every value clamps to its centre.
  if (lo > hi) return [0, 1];
  const pad = (hi - lo) * spec.pad;
  return [lo - pad, hi + pad];
}

/** Band-LOCAL y (0 = band top) for a value. The caller translates the canvas to
 *  the band, so this never needs to know where the band sits in the pane. */
export function valueToBandY(
  value: number,
  domain: [number, number],
  height: number,
): number {
  const [lo, hi] = domain;
  if (!(hi > lo)) return height / 2;
  const t = Math.min(1, Math.max(0, (value - lo) / (hi - lo)));
  return height - t * height;
}
```

- [ ] **Step 4: Run the tests and verify they pass**

```bash
cd frontend && npx vitest run src/lib/indicators/inset.test.ts
```

Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/indicators/inset.ts frontend/src/lib/indicators/inset.test.ts
git commit -m "feat(inset): band geometry and value-domain math"
```

---

## Task 3: Instance and legend helpers

**Files:**
- Modify: `frontend/src/lib/indicators/inset.ts`
- Test: `frontend/src/lib/indicators/inset.test.ts`

**Interfaces:**
- Consumes: Task 2's module; `BASE_TEMPLATES` and `indTypeOf` from `../customIndicators`.
- Produces:
  - `isInsetInstance(ind: { extendData?: unknown }): boolean`
  - `insetBaseTemplate(ind): Omit<IndicatorTemplate, "name"> | null`
  - `insetFiguresOf(ind): IndicatorFigure[]` — the base template's live figure list (regenerated from `calcParams` when the base has `regenerateFigures`)
  - `legendFiguresOf(ind): IndicatorFigure[]`
  - `legendPrecisionOf(ind): number | undefined`
  - `insetOrder(chart: Chart): string[]`
  - `withInset(list: IndicatorInstance[], id: string, on: boolean): IndicatorInstance[]`

The figure list is **derived, never stored**: SLOPE's figures are a function of `calcParams` via `regenerateFigures`, and a settings-modal edit calls `overrideIndicator` without re-registering the template, so a stored copy would go stale.

- [ ] **Step 1: Write the failing tests**

Add to `frontend/src/lib/indicators/inset.test.ts`. Note the klinecharts mock at the top of the file (these helpers import `../customIndicators`, which registers indicators at module load), so the whole test file switches to a dynamic import. Replace the existing static import line with:

```ts
import { describe, it, expect, vi } from "vitest";
import type { Chart } from "klinecharts";

vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));

const {
  insetBandRect,
  resolveDomain,
  valueToBandY,
  insetSpecOf,
  INSET_BAND_MIN_PX,
  isInsetInstance,
  insetFiguresOf,
  legendFiguresOf,
  legendPrecisionOf,
  insetOrder,
  withInset,
} = await import("./inset");
```

then append:

```ts
const insetInd = (over: Record<string, unknown> = {}) => ({
  name: "RSI",
  calcParams: [14],
  precision: 8,
  figures: [] as unknown[],
  visible: true,
  paneId: "candle_pane",
  extendData: { indType: "RSI", inset: true },
  ...over,
});

describe("isInsetInstance", () => {
  it("reads the explicit marker", () => {
    expect(isInsetInstance(insetInd())).toBe(true);
  });

  it("is false for a figure-less candle-pane indicator that is not inset", () => {
    // ProximityHeatmap ships figures: [] on candle_pane; an emptiness check would
    // wrongly drag it into the inset path.
    expect(isInsetInstance({ name: "ProximityHeatmap", extendData: {} })).toBe(false);
  });

  it("does not throw on a missing extendData", () => {
    expect(isInsetInstance({ name: "RSI" })).toBe(false);
  });
});

describe("insetFiguresOf", () => {
  it("derives RSI's static figure list from the base template", () => {
    expect(insetFiguresOf(insetInd()).map((f) => f.key)).toEqual(["rsi"]);
  });

  it("regenerates SLOPE's figures from the LIVE calcParams, never a stored copy", () => {
    const two = insetFiguresOf(
      insetInd({ name: "SLOPE", calcParams: [9, 21], extendData: { indType: "SLOPE", inset: true } }),
    );
    // one line per length, plus the title-less thHi/thLo auto-scale figures
    expect(two.filter((f) => f.title).length).toBe(2);
    expect(two.map((f) => f.key)).toContain("thHi");
  });

  it("returns [] for a type with no base template", () => {
    expect(insetFiguresOf(insetInd({ extendData: { indType: "MACD", inset: true } }))).toEqual([]);
  });
});

describe("legend helpers", () => {
  it("gives an inset instance the base template's figures and precision", () => {
    expect(legendFiguresOf(insetInd()).map((f) => f.key)).toEqual(["rsi"]);
    expect(legendPrecisionOf(insetInd())).toBe(2); // RSI_TEMPLATE.precision, not INSET_PRECISION
  });

  it("leaves a normal instance reading its own fields", () => {
    const normal = { name: "RSI", precision: 2, figures: [{ key: "rsi", title: "RSI: ", type: "line" }], extendData: { indType: "RSI" } };
    expect(legendFiguresOf(normal)).toBe(normal.figures);
    expect(legendPrecisionOf(normal)).toBe(2);
  });

  it("leaves a figure-less non-inset instance empty", () => {
    const heatmap = { name: "ProximityHeatmap", precision: 0, figures: [], extendData: {} };
    expect(legendFiguresOf(heatmap)).toEqual([]);
  });
});

describe("insetOrder", () => {
  const chartWith = (inds: Array<Record<string, unknown>>) =>
    ({ getIndicators: () => inds }) as unknown as Chart;

  it("lists inset instances in pane order", () => {
    const chart = chartWith([
      { name: "EMA", paneId: "candle_pane", visible: true, extendData: { indType: "EMA" } },
      insetInd({ name: "RSI" }),
      insetInd({ name: "ATR", extendData: { indType: "ATR", inset: true } }),
    ]);
    expect(insetOrder(chart)).toEqual(["RSI", "ATR"]);
  });

  it("excludes hidden instances, so hiding the first does not orphan the band chrome", () => {
    const chart = chartWith([
      insetInd({ name: "RSI", visible: false }),
      insetInd({ name: "ATR", extendData: { indType: "ATR", inset: true } }),
    ]);
    expect(insetOrder(chart)).toEqual(["ATR"]);
  });

  it("is empty when nothing is inset", () => {
    expect(insetOrder(chartWith([{ name: "EMA", paneId: "candle_pane", visible: true }]))).toEqual([]);
  });
});

describe("withInset", () => {
  it("sets the flag on the named instance only", () => {
    expect(withInset([{ id: "RSI", type: "RSI" }, { id: "ATR", type: "ATR" }], "RSI", true)).toEqual([
      { id: "RSI", type: "RSI", inset: true },
      { id: "ATR", type: "ATR" },
    ]);
  });

  it("removes the key rather than writing false", () => {
    const [only] = withInset([{ id: "RSI", type: "RSI", inset: true }], "RSI", false);
    expect(Object.prototype.hasOwnProperty.call(only, "inset")).toBe(false);
  });

  it("returns a new array and leaves unknown ids alone", () => {
    const list = [{ id: "RSI", type: "RSI" }];
    const next = withInset(list, "NOPE", true);
    expect(next).not.toBe(list);
    expect(next).toEqual(list);
  });

  it("keeps key ORDER stable, because saveIndicators serializes with JSON.stringify", () => {
    // templateSignatures compares saved payloads; a reordered key changes the bytes.
    expect(JSON.stringify(withInset([{ id: "RSI", type: "RSI" }], "RSI", true))).toBe(
      '[{"id":"RSI","type":"RSI","inset":true}]',
    );
    expect(JSON.stringify(withInset([{ id: "RSI", type: "RSI", inset: true }], "RSI", false))).toBe(
      '[{"id":"RSI","type":"RSI"}]',
    );
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

```bash
cd frontend && npx vitest run src/lib/indicators/inset.test.ts
```

Expected: FAIL, `isInsetInstance is not a function` (and siblings).

- [ ] **Step 3: Implement the helpers**

First add these three lines to the **top** of `frontend/src/lib/indicators/inset.ts`, forming its import block (the file has none yet):

```ts
import type { Chart, Indicator, IndicatorFigure, IndicatorTemplate } from "klinecharts";
import { BASE_TEMPLATES, indTypeOf, type CustomIndicatorType } from "../customIndicators";
import type { IndicatorInstance } from "../persist";
```

Then append the functions below to the end of the file:

```ts
type IndLike = { name: string; calcParams?: unknown[]; figures?: unknown[]; precision?: number; visible?: boolean; extendData?: unknown };

/** True when this live indicator was created in inset mode. Gates on the explicit
 *  marker applyIndicator writes, NOT on an empty figure list: ProximityHeatmap is
 *  a figure-less candle-pane indicator that is not inset. */
export function isInsetInstance(ind: IndLike | Indicator): boolean {
  return (ind.extendData as { inset?: boolean } | undefined)?.inset === true;
}

/** The authored template an inset instance was cloned from, or null for a type we
 *  do not own. */
export function insetBaseTemplate(ind: IndLike | Indicator): Omit<IndicatorTemplate, "name"> | null {
  return BASE_TEMPLATES[indTypeOf(ind) as CustomIndicatorType] ?? null;
}

/** A template's figure list for the given calcParams. Regenerated rather than read
 *  when the template defines regenerateFigures (SLOPE emits one line per length). */
export function figuresOfTemplate(
  base: Omit<IndicatorTemplate, "name"> | null,
  calcParams: unknown[] = [],
): IndicatorFigure[] {
  if (!base) return [];
  const regen = base.regenerateFigures;
  return ((regen ? regen(calcParams) : base.figures) ?? []) as IndicatorFigure[];
}

/** The figure list an inset instance WOULD have. Derived every call from the base
 *  template and the instance's live calcParams: SLOPE regenerates its figures per
 *  length, and a settings-modal edit goes through overrideIndicator without
 *  re-registering the template, so a stored copy would go stale. */
export function insetFiguresOf(ind: IndLike | Indicator): IndicatorFigure[] {
  return figuresOfTemplate(insetBaseTemplate(ind), ind.calcParams ?? []);
}

/** Figure list for legend purposes: an inset instance's own list is empty by
 *  construction, so fall back to what the base template defines. */
export function legendFiguresOf(ind: IndLike | Indicator): IndicatorFigure[] {
  return isInsetInstance(ind) ? insetFiguresOf(ind) : ((ind.figures ?? []) as IndicatorFigure[]);
}

/** Value precision for legend purposes: an inset instance reports INSET_PRECISION
 *  to keep the price axis honest, so read the real one off the base template. */
export function legendPrecisionOf(ind: IndLike | Indicator): number | undefined {
  return isInsetInstance(ind) ? insetBaseTemplate(ind)?.precision : ind.precision;
}

/** Visible inset instance names, in pane order. Derived per frame rather than
 *  stored, so it cannot drift from what is actually on the pane. Used to pick the
 *  one instance that paints the band chrome and to stack the in-band labels. */
export function insetOrder(chart: Chart): string[] {
  return chart
    .getIndicators({ paneId: "candle_pane" })
    .filter((ind) => isInsetInstance(ind) && ind.visible !== false)
    .map((ind) => ind.name);
}

/** Persisted-list edit for the toggle. Writes `inset: true` or removes the key,
 *  never `false`, so a non-inset payload stays byte-identical to what earlier
 *  builds saved. Rebuilt field-by-field in declared order rather than by spreading
 *  a rest object: saveIndicators serializes with JSON.stringify, so key ORDER is
 *  part of the bytes that templateSignatures compares. */
export function withInset(
  list: IndicatorInstance[],
  id: string,
  on: boolean,
): IndicatorInstance[] {
  return list.map((inst) =>
    inst.id === id
      ? { id: inst.id, type: inst.type, ...(on ? { inset: true as const } : {}) }
      : inst,
  );
}
```


- [ ] **Step 4: Run the tests and verify they pass**

```bash
cd frontend && npx vitest run src/lib/indicators/inset.test.ts
```

Expected: PASS. If `insetOrder`'s test fails with "getIndicators is not a function", the fake chart in the test needs the exact `getIndicators()` shape shown above (it ignores the filter argument on purpose).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/indicators/inset.ts frontend/src/lib/indicators/inset.test.ts
git commit -m "feat(inset): instance markers, derived figure lists, legend helpers"
```

---

## Task 4: The draw wrapper

**Files:**
- Modify: `frontend/src/lib/indicators/inset.ts`
- Test: `frontend/src/lib/indicators/inset.test.ts`

**Interfaces:**
- Consumes: Tasks 2 and 3.
- Produces: `drawInset(type: string, base?: Omit<IndicatorTemplate, "name"> | null): (params: IndicatorDrawParams) => boolean` — `base` defaults to `BASE_TEMPLATES[type]` and exists so a test can inject a recording stub and assert on the substituted `yAxis` directly.

This is the heart of the feature. The wrapper relocates the sub-pane's coordinate frame into the band and hands the base template's own `draw` a substitute `yAxis`, so per-type chrome (RSI's zones and divergences, SLOPE's zero line) renders with no per-type code here.

- [ ] **Step 1: Write the failing tests**

Add `drawInset` to the dynamic-import destructuring at the top of `inset.test.ts`, then append:

```ts
// Recording 2D context: enough surface for the wrapper and for the base draws it
// delegates to, capturing the calls the assertions care about.
function fakeCtx() {
  const calls: string[] = [];
  const ctx = {
    calls,
    save: () => calls.push("save"),
    restore: () => calls.push("restore"),
    translate: (x: number, y: number) => calls.push(`translate:${x},${y}`),
    rect: (x: number, y: number, w: number, h: number) => calls.push(`rect:${x},${y},${w},${h}`),
    clip: () => calls.push("clip"),
    beginPath: () => {}, closePath: () => {}, moveTo: () => {}, lineTo: () => {},
    stroke: () => calls.push("stroke"), fill: () => {}, fillRect: () => {},
    fillText: (t: string) => calls.push(`text:${t}`), measureText: () => ({ width: 10 }),
    setLineDash: () => {}, arc: () => {},
    globalAlpha: 1, strokeStyle: "", fillStyle: "", lineWidth: 1, font: "",
    textAlign: "", textBaseline: "",
  };
  return ctx;
}

function drawParams(over: Record<string, unknown> = {}) {
  const result = Array.from({ length: 10 }, (_, i) => ({ rsi: i * 10 }));
  return {
    ctx: fakeCtx(),
    chart: {
      getVisibleRange: () => ({ from: 0, to: 10 }),
      getBarSpace: () => ({ bar: 6, halfBar: 3, gapBar: 5, halfGapBar: 2.5 }),
      getIndicators: () => [
        { name: "RSI", paneId: "candle_pane", visible: true, extendData: { indType: "RSI", inset: true } },
      ],
      getDataList: () => result.map(() => ({ open: 1, high: 2, low: 0, close: 1, timestamp: 0 })),
    },
    indicator: {
      name: "RSI", calcParams: [14], precision: 8, figures: [], visible: true,
      shortName: "RSI", styles: { lines: [{ color: "#7E57C2" }] },
      extendData: { indType: "RSI", inset: true },
      result,
    },
    xAxis: { convertToPixel: (i: number) => i * 10 },
    yAxis: { convertToPixel: (v: number) => 1000 - v },
    bounding: { width: 500, height: 400, left: 0, right: 500, top: 0, bottom: 0 },
    ...over,
  };
}

describe("drawInset", () => {
  it("returns true so klinecharts draws no figures of its own", () => {
    expect(drawInset("RSI")(drawParams() as never)).toBe(true);
  });

  it("translates to the band and clips to it", () => {
    const p = drawParams();
    drawInset("RSI")(p as never);
    // 400px pane -> 112px band at top 288
    expect(p.ctx.calls).toContain("translate:0,288");
    expect(p.ctx.calls).toContain("rect:0,0,500,112");
    expect(p.ctx.calls).toContain("clip");
  });

  it("balances save and restore even when the base draw throws", () => {
    // A base draw that throws must not leave the canvas translated for the next
    // indicator on this pane, so the wrapper restores in a finally.
    const exploding = { figures: [], draw: () => { throw new Error("boom"); } };
    const p = drawParams();
    expect(() => drawInset("RSI", exploding as never)(p as never)).not.toThrow();
    expect(p.ctx.calls.filter((c) => c === "save").length)
      .toBe(p.ctx.calls.filter((c) => c === "restore").length);
    expect(p.ctx.calls.at(-1)).toBe("restore");
  });

  it("hands the base draw a yAxis shim that maps the domain onto the band", () => {
    // Inject a recording base so the substitution is asserted directly rather than
    // inferred from canvas calls.
    let got: { toY: (v: number) => number; height: number } | null = null;
    const stub = {
      figures: [{ key: "rsi", title: "RSI: ", type: "line" }],
      draw: (dp: { yAxis: { convertToPixel: (v: number) => number }; bounding: { height: number } }) => {
        got = { toY: dp.yAxis.convertToPixel, height: dp.bounding.height };
        return false;
      },
    };
    drawInset("RSI", stub as never)(drawParams() as never);
    expect(got).not.toBeNull();
    // RSI's fixed 0-100 domain over a 112px band, y measured from the band's top.
    expect(got!.height).toBe(112);
    expect(got!.toY(100)).toBe(0);
    expect(got!.toY(0)).toBe(112);
    expect(got!.toY(50)).toBe(56);
  });

  it("uses the injected base's figures, so SLOPE's regenerated list flows through", () => {
    const stub = {
      figures: [{ key: "a", title: "A: ", type: "line" }],
      draw: () => false,
    };
    const p = drawParams();
    p.indicator.result = [{ a: 1 }, { a: 2 }] as never;
    drawInset("ATR", stub as never)(p as never);
    expect(p.ctx.calls).toContain("stroke");
  });

  it("paints nothing on a zero-height pane", () => {
    const p = drawParams({ bounding: { width: 500, height: 0, left: 0, right: 500, top: 0, bottom: 0 } });
    expect(drawInset("RSI")(p as never)).toBe(true);
    expect(p.ctx.calls).not.toContain("stroke");
  });

  it("labels the band with the last visible value at the base template's precision", () => {
    const p = drawParams();
    drawInset("RSI")(p as never);
    // last bar's rsi is 90, RSI_TEMPLATE.precision is 2
    expect(p.ctx.calls.some((c) => c.startsWith("text:") && c.includes("90.00"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

```bash
cd frontend && npx vitest run src/lib/indicators/inset.test.ts -t drawInset
```

Expected: FAIL, `drawInset is not a function`.

- [ ] **Step 3: Implement the wrapper**

Add one line to the import block at the **top** of `frontend/src/lib/indicators/inset.ts`:

```ts
import { hexToRgba } from "../lineStyle";
```

Then append the rest to the end of the file:

```ts
// Band chrome: a faint ground plus a hairline lid, so the region reads as a band
// rather than as curves floating over the candles.
const BAND_FILL_ALPHA = 0.06;
const BAND_EDGE_ALPHA = 0.22;
const LINE_ALPHA = 0.9;
const LABEL_PAD = 4;
const LABEL_LINE_H = 12;

function paintBandChrome(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  ctx.save();
  ctx.fillStyle = `rgba(128,128,128,${BAND_FILL_ALPHA})`;
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = `rgba(128,128,128,${BAND_EDGE_ALPHA})`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, 0.5);
  ctx.lineTo(width, 0.5);
  ctx.stroke();
  ctx.restore();
}

/** Every value on screen for the base template's line figures — what an "auto"
 *  domain fits to. SLOPE's title-less thHi/thLo figures are ordinary line figures,
 *  so the threshold widens the domain here exactly as it widens the sub-pane's
 *  y-axis. */
function visibleValues(
  result: Array<Record<string, unknown>>,
  figures: IndicatorFigure[],
  from: number,
  to: number,
): Array<number | undefined | null> {
  const keys = figures.filter((f) => f.type === "line").map((f) => f.key);
  const out: Array<number | undefined | null> = [];
  for (let i = Math.max(0, from); i < Math.min(to, result.length); i++) {
    const row = result[i];
    if (!row) continue;
    for (const k of keys) out.push(row[k] as number | undefined);
  }
  return out;
}

/** The inset draw for `type`: relocate the sub-pane's frame into the band, let the
 *  base template's own draw paint through a substituted y-conversion, then stroke
 *  the figure lines klinecharts is no longer drawing. Returns true (isCover). */
export function drawInset(
  type: string,
  base: Omit<IndicatorTemplate, "name"> | null = BASE_TEMPLATES[type as CustomIndicatorType] ?? null,
): NonNullable<IndicatorTemplate["draw"]> {
  const spec = insetSpecOf(type);
  return (params) => {
    const p = params as unknown as {
      ctx: CanvasRenderingContext2D;
      chart: Chart;
      indicator: Indicator & { result?: Array<Record<string, unknown>> };
      xAxis: { convertToPixel: (v: number) => number };
      yAxis: unknown;
      bounding: { width: number; height: number; left: number; right: number; top: number; bottom: number };
    };
    const { ctx, chart, indicator, xAxis, bounding } = p;
    const rect = insetBandRect(bounding);
    if (rect.height <= 0) return true;

    const result = indicator.result ?? [];
    // From the base this wrapper was built with, so an injected test base and the
    // real template take the same path.
    const figures = figuresOfTemplate(base, indicator.calcParams ?? []);
    const { from, to } = chart.getVisibleRange();
    const domain = resolveDomain(spec, visibleValues(result, figures, from, to));
    const toY = (v: number) => valueToBandY(v, domain, rect.height);

    ctx.save();
    try {
      ctx.translate(0, rect.top);
      ctx.beginPath();
      ctx.rect(0, 0, bounding.width, rect.height);
      ctx.clip();

      const order = insetOrder(chart);
      if (order[0] === indicator.name) paintBandChrome(ctx, bounding.width, rect.height);

      // The base draw was written against yAxis.convertToPixel and bounding.height
      // in its own pane. Both are substituted here, and the canvas is already
      // translated, so it paints inside the band without knowing it moved.
      base?.draw?.({
        ...p,
        yAxis: { ...(p.yAxis as object), convertToPixel: toY },
        bounding: { ...bounding, height: rect.height, top: 0, bottom: rect.height },
      } as never);

      paintInsetLines(ctx, indicator, figures, result, from, to, xAxis, toY);
      paintInsetLabel(ctx, indicator, figures, result, to, order.indexOf(indicator.name));
    } catch (e) {
      // A base draw that throws must not leave the canvas translated for the next
      // indicator on this pane; the finally below restores it either way.
      console.error("drawInset", indicator.name, e);
    } finally {
      ctx.restore();
    }
    return true;
  };
}

function paintInsetLines(
  ctx: CanvasRenderingContext2D,
  indicator: Indicator,
  figures: IndicatorFigure[],
  result: Array<Record<string, unknown>>,
  from: number,
  to: number,
  xAxis: { convertToPixel: (v: number) => number },
  toY: (v: number) => number,
): void {
  let lineIdx = 0;
  ctx.save();
  ctx.lineWidth = 1;
  for (const fig of figures) {
    if (fig.type !== "line") continue;
    const color = indicator.styles?.lines?.[lineIdx]?.color ?? "#888888";
    lineIdx++;
    ctx.strokeStyle = hexToRgba(color, LINE_ALPHA);
    ctx.beginPath();
    let open = false;
    for (let i = Math.max(0, from); i < Math.min(to, result.length); i++) {
      const v = result[i]?.[fig.key];
      if (typeof v !== "number" || !Number.isFinite(v)) {
        open = false;
        continue;
      }
      const x = xAxis.convertToPixel(i);
      const y = toY(v);
      if (open) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
      open = true;
    }
    ctx.stroke();
  }
  ctx.restore();
}

/** "RSI 14  57.20" at the band's left edge, one line per inset instance. Reads the
 *  LAST visible bar: hover readout is the legend row's job (it already fills
 *  per-figure values on the crosshair path), so no crosshair state is plumbed in. */
function paintInsetLabel(
  ctx: CanvasRenderingContext2D,
  indicator: Indicator,
  figures: IndicatorFigure[],
  result: Array<Record<string, unknown>>,
  to: number,
  slot: number,
): void {
  const titled = figures.filter((f) => f.type === "line" && f.title);
  if (!titled.length || slot < 0) return;
  const precision = legendPrecisionOf(indicator) ?? 2;
  const row = result[Math.min(to, result.length) - 1];
  const params = indicator.calcParams?.length ? ` ${indicator.calcParams.join(",")}` : "";
  const values = titled
    .map((f) => {
      const v = row?.[f.key];
      return typeof v === "number" && Number.isFinite(v) ? v.toFixed(precision) : "n/a";
    })
    .join("  ");
  ctx.save();
  ctx.font = "10px Helvetica Neue, Arial, sans-serif";
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  ctx.fillStyle = hexToRgba(indicator.styles?.lines?.[0]?.color ?? "#888888", 1);
  ctx.fillText(
    `${indicator.shortName ?? indicator.name}${params}  ${values}`,
    LABEL_PAD,
    LABEL_PAD + slot * LABEL_LINE_H,
  );
  ctx.restore();
}
```

- [ ] **Step 4: Run the tests and verify they pass**

```bash
cd frontend && npx vitest run src/lib/indicators/inset.test.ts
```

Expected: PASS. If the label test fails on the formatted number, check `legendPrecisionOf` is returning `RSI_TEMPLATE.precision` (2) and not the instance's `INSET_PRECISION` (8).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/indicators/inset.ts frontend/src/lib/indicators/inset.test.ts
git commit -m "feat(inset): draw wrapper that relocates the pane frame into the band"
```

---

## Task 5: Template factory and creation routing

**Files:**
- Modify: `frontend/src/lib/indicators/inset.ts` (add `insetTemplate`)
- Modify: `frontend/src/lib/indicators.ts:85-87` (add `isSubPaneInstance`), `:401-448` (`registerInstanceTemplate`), `:479-521` (`applyIndicator`)
- Test: `frontend/src/lib/indicators.test.ts`, `frontend/src/lib/indicators/inset.test.ts`

**Interfaces:**
- Consumes: Tasks 2 to 4.
- Produces:
  - `insetTemplate(type: string): Omit<IndicatorTemplate, "name"> | null`
  - `isSubPaneInstance(inst: IndicatorInstance): boolean` from `lib/indicators.ts`
  - `applyIndicator` honoring `inst.inset`

- [ ] **Step 1: Write the failing tests**

Add `insetTemplate` to the destructuring in `inset.test.ts` and append:

```ts
describe("insetTemplate", () => {
  it("empties the figure list so the price axis never sees the values", () => {
    expect(insetTemplate("RSI")!.figures).toEqual([]);
  });

  it("drops regenerateFigures, which would refill figures on a calcParams edit", () => {
    // SLOPE has one; leaving it would silently undo the empty figure list.
    expect(insetTemplate("SLOPE")!.regenerateFigures).toBeNull();
  });

  it("reports a high precision so the pane's MIN keeps the price precision", () => {
    expect(insetTemplate("RSI")!.precision).toBe(8);
  });

  it("keeps the base calc and swaps in the inset draw", () => {
    const t = insetTemplate("RSI")!;
    expect(typeof t.calc).toBe("function");
    expect(typeof t.draw).toBe("function");
  });

  it("returns null for a type we do not own", () => {
    expect(insetTemplate("MACD")).toBeNull();
  });
});
```

Add to `frontend/src/lib/indicators.test.ts` (inside the describe block that already defines `chartWith`, extending that helper to record what it was asked to create):

```ts
describe("inset placement", () => {
  function recordingChart() {
    const created: Array<Record<string, unknown>> = [];
    const paneOptions: Array<Record<string, unknown>> = [];
    let seq = 0;
    const chart = {
      getIndicators: () => [],
      createIndicator: (value: unknown) => {
        const v = value as Record<string, unknown>;
        created.push(v);
        return (v.paneId as string) ?? `pane_${++seq}`;
      },
      overrideIndicator: () => {},
      setPaneOptions: (o: unknown) => paneOptions.push(o as Record<string, unknown>),
      overrideYAxis: () => {},
    } as unknown as Chart;
    return { chart, created, paneOptions };
  }

  it("puts an inset instance on the candle pane and sizes no sub-pane", () => {
    const { chart, created, paneOptions } = recordingChart();
    const paneId = applyIndicator(chart, "tab.inset", "US100", { id: "RSI", type: "RSI", inset: true });
    expect(paneId).toBe("candle_pane");
    expect(created[0].paneId).toBe("candle_pane");
    expect(paneOptions).toEqual([]);
  });

  it("marks the live instance so the draw and the legend can recognise it", () => {
    const { chart, created } = recordingChart();
    applyIndicator(chart, "tab.inset", "US100", { id: "RSI", type: "RSI", inset: true });
    expect((created[0].extendData as { inset?: boolean }).inset).toBe(true);
  });

  it("opens a normal sub-pane without the flag, and leaves extendData clean", () => {
    const { chart, created, paneOptions } = recordingChart();
    applyIndicator(chart, "tab.inset2", "US100", { id: "RSI", type: "RSI" });
    expect(created[0].paneId).toBeUndefined();
    expect(paneOptions.length).toBe(1);
    expect(
      Object.prototype.hasOwnProperty.call(created[0].extendData as object, "inset"),
    ).toBe(false);
  });

  it("ignores a stale inset in a saved config, deriving the mode from the instance", () => {
    // A template or pasted payload can carry a stale extendData.inset; the
    // instance list is the source of truth.
    const { chart, created } = recordingChart();
    applyIndicator(chart, "tab.inset3", "US100", { id: "RSI", type: "RSI" }, {
      config: { extendData: { inset: true } } as never,
    });
    expect(
      Object.prototype.hasOwnProperty.call(created[0].extendData as object, "inset"),
    ).toBe(false);
  });

  it("refuses inset for a type that is not inset-capable, without blocking creation", () => {
    // SESSIONS is one of ours but is not in INSET_CAPABLE, so a stale flag on it
    // must be inert AND must not stop the indicator from opening its own pane.
    // (A klinecharts built-in like MACD cannot be used for this assertion: this
    // file mocks getSupportedIndicators to [], so a built-in never registers here.)
    const { chart, created, paneOptions } = recordingChart();
    applyIndicator(chart, "tab.inset4", "US100", { id: "SESSIONS", type: "SESSIONS", inset: true });
    expect(created).toHaveLength(1);
    expect(created[0].paneId).toBeUndefined();
    expect(paneOptions).toHaveLength(1);
    expect(
      Object.prototype.hasOwnProperty.call(created[0].extendData as object, "inset"),
    ).toBe(false);
  });
});

describe("isSubPaneInstance", () => {
  it("is true for a plain pane indicator", () => {
    expect(isSubPaneInstance({ id: "RSI", type: "RSI" })).toBe(true);
  });
  it("is false once that instance is inset", () => {
    expect(isSubPaneInstance({ id: "RSI", type: "RSI", inset: true })).toBe(false);
  });
  it("is false for a candle-pane overlay", () => {
    expect(isSubPaneInstance({ id: "EMA", type: "EMA" })).toBe(false);
  });
});
```

Add `isSubPaneInstance` to the destructured `await import("./indicators")` list at the top of that file.

- [ ] **Step 2: Run the tests and verify they fail**

```bash
cd frontend && npx vitest run src/lib/indicators/inset.test.ts src/lib/indicators.test.ts
```

Expected: FAIL on `insetTemplate is not a function` and on the placement assertions.

- [ ] **Step 3a: Add the template factory**

Append to `frontend/src/lib/indicators/inset.ts`:

```ts
/** The registerable template for an inset instance of `type`: the authored base
 *  with its figures emptied, its figure regeneration disabled, its precision
 *  neutralised and its draw replaced. Null for a type we do not own. */
export function insetTemplate(type: string): Omit<IndicatorTemplate, "name"> | null {
  const base = BASE_TEMPLATES[type as CustomIndicatorType];
  if (!base || !INSET_CAPABLE.has(type)) return null;
  return {
    ...base,
    figures: [],
    // klinecharts calls this on every calcParams change and would refill `figures`,
    // putting the values straight back into the price axis's range math.
    regenerateFigures: null,
    precision: INSET_PRECISION,
    draw: drawInset(type),
  };
}
```

- [ ] **Step 3b: Register it**

In `frontend/src/lib/indicators.ts`, take an `inset` argument in `registerInstanceTemplate` and pick the base from it:

```ts
function registerInstanceTemplate(
  chart: Chart,
  type: string,
  id: string,
  inset = false,
): boolean {
  if (id !== type) mintedInstanceIds.add(id);
  if (isCustomType(type)) {
    // Inset instances register the same template with an empty figure list and the
    // band draw (lib/indicators/inset.ts). Re-registering under the same name is
    // how a toggle swaps one for the other.
    const base = (inset ? insetTemplate(type) : null) ?? BASE_TEMPLATES[type];
    const lines = base.styles?.lines;
    // ... unchanged body from here down, reading `base`
```

- [ ] **Step 3c: Route creation**

In `applyIndicator`, just below `const { id, type } = inst;`:

```ts
  // Inset: draw inside the candle pane's bottom band instead of opening a sub-pane.
  // Gated on capability so a stale flag on a type we do not own is inert.
  const inset = inst.inset === true && INSET_CAPABLE.has(type);
  if (!registerInstanceTemplate(chart, type, id, inset)) return null;
  // Placement-wise an inset instance IS a candle-pane overlay: same stack, same
  // pane id, and no sub-pane sizing or y-axis gap.
  const isOverlay = OVERLAY_INDICATORS.has(type) || inset;
```

(delete the old `registerInstanceTemplate` and `isOverlay` lines), and after the `extendData` object is built:

```ts
  // Derived from the instance, never trusted from the saved snapshot: a stale
  // `inset` in a config, template or pasted payload must not resurrect the mode.
  // Deleted rather than set false so non-inset payloads stay byte-identical.
  if (inset) (extendData as { inset?: boolean }).inset = true;
  else delete (extendData as { inset?: boolean }).inset;
```

Add the import at the top of `lib/indicators.ts`:

```ts
import { INSET_CAPABLE, insetTemplate } from "./indicators/inset";
```

- [ ] **Step 3d: Add the instance-aware sub-pane predicate**

Next to `isSubPaneIndicator` in `lib/indicators.ts`:

```ts
// Instance-aware form of isSubPaneIndicator: an inset instance draws in the candle
// pane, so it must not trigger the "auto-expand collapsed sub-panes" behavior that
// exists to stop a freshly added pane indicator from landing invisible.
export function isSubPaneInstance(inst: IndicatorInstance): boolean {
  return isSubPaneIndicator(inst.type) && inst.inset !== true;
}
```

- [ ] **Step 4: Run the tests and verify they pass**

```bash
cd frontend && npx vitest run src/lib/indicators/inset.test.ts src/lib/indicators.test.ts
```

Expected: PASS both files.

- [ ] **Step 5: Typecheck**

```bash
cd frontend && npx tsc -b --noEmit
```

Expected: no errors. A complaint about `regenerateFigures: null` means the spread's type is narrower than `IndicatorTemplate`; cast the returned object `as Omit<IndicatorTemplate, "name">`.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/indicators/inset.ts frontend/src/lib/indicators.ts frontend/src/lib/indicators.test.ts frontend/src/lib/indicators/inset.test.ts
git commit -m "feat(inset): register the inset template and route creation to the candle pane"
```

---

## Task 6: Legend and template call sites

**Files:**
- Modify: `frontend/src/ChartLegend.tsx:253-268`, `:750-762`
- Modify: `frontend/src/lib/templates.ts:178`, `:259`
- Create: `frontend/src/ChartLegend.inset.test.tsx`

**Interfaces:**
- Consumes: `legendFiguresOf`, `legendPrecisionOf` (Task 3), `isSubPaneInstance` (Task 5).
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/ChartLegend.inset.test.tsx`. It must be a `.tsx` file with the
jsdom pragma: vitest's default environment here is `node` (see `vite.config.ts`),
and `ChartLegend.tsx` is a React module.

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";

vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));

const { buildLegendRows } = await import("./ChartLegend");

describe("legend rows for an inset instance", () => {
  const chart = {
    getIndicators: () => [
      {
        name: "RSI", paneId: "candle_pane", shortName: "RSI", calcParams: [14],
        precision: 8, figures: [], visible: true,
        styles: { lines: [{ color: "#7E57C2" }] },
        extendData: { indType: "RSI", inset: true },
        result: [],
      },
    ],
    getStyles: () => ({ indicator: { lines: [{ color: "#888" }], tooltip: { legend: { color: "#ccc" } } } }),
    getDataList: () => [],
  } as unknown as import("klinecharts").Chart;

  it("shows the base template's figure row rather than an empty one", () => {
    const { rows } = buildLegendRows(chart);
    expect(rows).toHaveLength(1);
    expect(rows[0].figures.map((f) => f.title)).toEqual(["RSI: "]);
  });
});
```

- [ ] **Step 2: Run it and verify it fails**

```bash
cd frontend && npx vitest run src/ChartLegend.inset.test.tsx
```

Expected: FAIL, `rows[0].figures` is `[]` because `rowsForPane` iterates the instance's own (empty) `figures`.

- [ ] **Step 3: Wire the two legend sites**

In `frontend/src/ChartLegend.tsx`, import the helpers:

```ts
import { legendFiguresOf, legendPrecisionOf } from "./lib/indicators/inset";
```

In `updateValues` (around line 258), replace `for (const fig of ind.figures) {` with:

```ts
        // An inset instance carries no figures of its own (that is what keeps it
        // out of the price axis), so the definitions come from its base template.
        for (const fig of legendFiguresOf(ind)) {
```

and the value formatting on the next lines:

```ts
              ? fmtNum(v, legendPrecisionOf(ind) ?? prec) + suffix
```

In `rowsForPane` (around line 752), replace `for (const fig of ind.figures) {` with:

```ts
    for (const fig of legendFiguresOf(ind)) {
```

- [ ] **Step 4: Wire the two template sites**

In `frontend/src/lib/templates.ts`, swap the import of `isSubPaneIndicator` for `isSubPaneInstance` and change both call sites (lines 178 and 259) from:

```ts
      if (controller.subPanesHidden.value && added.some((a) => isSubPaneIndicator(a.type)))
```

to:

```ts
      if (controller.subPanesHidden.value && added.some((a) => isSubPaneInstance(a)))
```

Leave `Toolbar.tsx:240` and `useIndicatorCommands.ts:195` on the type-keyed `isSubPaneIndicator`: a fresh add and a paste both create non-inset instances, so they have no flag to consult.

- [ ] **Step 5: Run the tests and verify they pass**

```bash
cd frontend && npx vitest run src/ChartLegend.inset.test.tsx src/lib/templates.test.ts src/lib/templateAutosave.test.ts
```

Expected: PASS. `templates.test.ts` and `templateAutosave.test.ts` mock `isSubPaneIndicator`; if they now fail with "not a function", add `isSubPaneInstance: vi.fn(() => false)` to the same mock objects (`templates.test.ts:22`, `templateAutosave.test.ts:13`).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/ChartLegend.tsx frontend/src/ChartLegend.inset.test.tsx frontend/src/lib/templates.ts frontend/src/lib/templates.test.ts frontend/src/lib/templateAutosave.test.ts
git commit -m "feat(inset): legend reads figures and precision through the inset helpers"
```

---

## Task 7: The toggle

**Files:**
- Modify: `frontend/src/chart/useIndicatorCommands.ts:304-450`
- Modify: `frontend/src/lib/menuIcons.tsx`
- Test: covered by `withInset` (Task 3) plus the manual pass in Task 9

**Interfaces:**
- Consumes: `withInset`, `INSET_CAPABLE`, `applyIndicator`, `indTypeOf`.
- Produces: `setIndicatorInset(paneId: string, name: string, on: boolean): void` on the hook's return object, and a `Show as inset` / `Show in own pane` item in `indicatorMenuItems`.

- [ ] **Step 1: Add the icon**

In `frontend/src/lib/menuIcons.tsx`, add to the `MenuIcons` object (beside `moveUp` / `moveDown`):

```ts
  // Inset: a small framed band inside a larger frame — the mode it names.
  inset: svg(
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <rect x="6" y="14" width="12" height="3" rx="1" />
    </>,
  ),
```

- [ ] **Step 2: Add the command**

In `frontend/src/chart/useIndicatorCommands.ts`, import:

```ts
import { INSET_CAPABLE, withInset } from "../lib/indicators/inset";
import { indTypeOf } from "../lib/customIndicators";
```

and add the command next to `removeOn`:

```ts
  // Move an instance between its own sub-pane and the candle pane's inset band.
  // klinecharts has no "change an indicator's pane" API, so this is a teardown +
  // recreate, exactly like reorderSubPanes. chart.removeIndicator directly, NOT
  // removeIndicatorById: that one also deletes the persisted config, which would
  // throw away the instance's params and colors on every toggle.
  const setIndicatorInset = useCallback(
    (paneId: string, name: string, on: boolean) => {
      const c = chartRef.current;
      if (!c) return;
      const next = withInset(controller.indicators.value, name, on);
      const inst = next.find((i) => i.id === name);
      if (!inst) return;
      c.removeIndicator({ paneId, name });
      controller.indicators.set(next);
      saveIndicators(scope, next);
      applyIndicator(c, scope, epicRef.current, inst, { rehydrate: true });
      handle.redrawRef.current();
    },
    [controller, scope],
  );
```

Add `applyIndicator` to the existing `../lib/indicators` import if it is not already there, and add `setIndicatorInset` to the hook's returned object.

- [ ] **Step 3: Add the menu item**

In `indicatorMenuItems`, after the `moveItems` spread and before `Remove`:

```ts
        ...(INSET_CAPABLE.has(indTypeOf({ name, extendData: ind?.extendData }))
          ? [
              {
                label: inset ? "Show in own pane" : "Show as inset",
                icon: MenuIcons.inset,
                onClick: () => setIndicatorInset(paneId, name, !inset),
              },
            ]
          : []),
```

and read the current mode alongside `visible` at the top of the callback:

```ts
      const ind = c ? (getIndicator(c, paneId, name) as { visible?: boolean; extendData?: unknown } | null) : null;
      const visible = ind?.visible ?? true;
      const inset = (ind?.extendData as { inset?: boolean } | undefined)?.inset === true;
```

Add `setIndicatorInset` to the callback's dependency array.

- [ ] **Step 4: Typecheck and lint**

```bash
cd frontend && npx tsc -b --noEmit && npm run lint
```

Expected: clean. `indTypeOf` needs `{ name, extendData }`, which is why the call passes an object literal rather than the raw name.

- [ ] **Step 5: Run the affected suites**

```bash
cd frontend && npx vitest run src/lib/indicators/inset.test.ts src/lib/indicators.test.ts
```

Expected: PASS (no new tests here; this guards against an import cycle breaking the existing ones).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/chart/useIndicatorCommands.ts frontend/src/lib/menuIcons.tsx
git commit -m "feat(inset): Show as inset in the indicator context menu"
```

---

## Task 8: Close the visibility-persistence asymmetry

**Files:**
- Modify: `frontend/src/chart/useIndicatorCommands.ts:312`
- Test: `frontend/src/lib/indicators/inset.test.ts` is not the right home; this one is verified by the manual pass in Task 9 plus the reasoning below.

**Interfaces:** none.

Spec §8. The legend eye (`:86`) persists visibility for every pane; the context menu (`:312`) persists only for `candle_pane`. `applyIndicator` reads that flag for any pane (`lib/indicators.ts:507,520`), so with inset moving instances between panes the guard would make Hide persist while inset and evaporate in a sub-pane, on the same indicator, in the same session.

- [ ] **Step 1: Remove the guard**

In `toggleVisibleOn`, replace:

```ts
    if (paneId === "candle_pane") saveIndicatorVisible(scope, name, next);
```

with:

```ts
    // Persist for EVERY pane, matching the legend eye path above (which has always
    // been pane-agnostic). Inset moves an instance between panes, so a candle-pane
    // guard here would make the same indicator's Hide persist or not depending on
    // which mode it happened to be in.
    saveIndicatorVisible(scope, name, next);
```

- [ ] **Step 2: Verify no test encoded the old behavior**

```bash
cd frontend && grep -rn "saveIndicatorVisible" src/ && npm run test:unit 2>&1 | tail -30
```

Expected: the only non-test references are the two call sites plus the definition. Compare the failure list against the pre-change baseline (`git stash && npm run test:unit; git stash pop`) and confirm it is unchanged.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/chart/useIndicatorCommands.ts
git commit -m "fix(indicators): persist context-menu Hide for sub-pane indicators too"
```

---

## Task 9: Full verification

**Files:** none modified unless a check fails.

- [ ] **Step 1: Typecheck, lint, full unit run**

```bash
cd frontend && npx tsc -b --noEmit && npm run lint && npm run test:unit
```

Expected: typecheck and lint clean; the unit run shows only the known pre-existing failures. Record the failure list and compare with the baseline before claiming success.

- [ ] **Step 2: Drive the app**

Start the app (`npm run dev`, open http://localhost:5173) and check, in order:

1. Add an RSI. It opens a sub-pane as before.
2. Legend row ⋯ → **Show as inset**. The sub-pane closes, the candles reclaim its height, and the RSI draws in a band across the bottom of the candle pane with its overbought/oversold zones and any divergence segments **inside the band**. This is the real test of the `yAxis` shim: zones or divergence lines escaping the band mean the shim is not reaching the base draw.
3. The legend row still lists `RSI: <value>`, and hovering the chart still fills it.
4. Add an ATR and inset it too. Both share one band, each with its own label line.
5. Open RSI's settings, recolor the line and change the length. The band follows both.
6. Reload the page. Both come back inset with their settings.
7. ⋯ → **Show in own pane**. Each returns to a sub-pane with its params and colors intact.
8. Hide an inset instance from ⋯. Its label and curve disappear, the band chrome stays.

- [ ] **Step 3: The price-axis check (the one that must not pass for the wrong reason)**

Turn the rule proximity heatmap **off** (its `precision: 0` forces integer ticks on its own, which would mask the guard) and turn **"Scale price chart only" off**. On a 5-decimal symbol, screenshot the price axis with no inset indicator, then add an inset RSI and screenshot again. The tick labels must be identical: same count, same decimals, same values. Any change means either `figures: []` or `INSET_PRECISION` is not doing its job.

- [ ] **Step 4: The small-pane check**

Switch to a 2x2 grid layout. The band caps at 40% of the candle pane and stays legible-ish. Cramped is the accepted outcome; a band taller than its pane, or a negative rect, is a bug in `insetBandRect`.

- [ ] **Step 5: Commit any fixes, then report**

Report: what passed, what failed, and any deviation from the spec, with the actual command output. Do not claim green without pasting the run.

---

## Self-Review Notes

**Spec coverage.** §1 persistence → Task 1. §2 creation routing → Task 5. §3 inset template → Tasks 4 and 5. §4 geometry and domain → Task 2. §5 drawing → Task 4. §6 legend → Task 6. §7 toggle → Task 7. §8 visibility asymmetry → Task 8. §9 what needs no change → nothing to do, asserted by the Task 9 manual pass (pane reordering and collapse). §10 small panes → Task 2's cap test plus Task 9 Step 4. Non-goals are respected: no built-in indicator support, no draggable band, no `collapseSubPanes` change.

**Naming consistency.** `insetBandRect`, `resolveDomain`, `valueToBandY`, `insetSpecOf`, `isInsetInstance`, `insetBaseTemplate`, `insetFiguresOf`, `legendFiguresOf`, `legendPrecisionOf`, `insetOrder`, `withInset`, `drawInset`, `insetTemplate`, `isSubPaneInstance`, `setIndicatorInset` are each defined once and used under that exact name everywhere later.

**Test-environment trap.** vitest defaults to the `node` environment here (`vite.config.ts`). Any test that imports a React module needs a `.tsx` filename and a `// @vitest-environment jsdom` pragma on line 1 (Task 6). Any test that imports `lib/customIndicators.ts` or anything under `lib/indicators/` needs `vi.mock("klinecharts", ...)` before a dynamic import, because those modules call `registerIndicator` at load time (Tasks 3 to 5).

**Coordinate-frame reminder for the implementer.** Inside `drawInset` everything after `ctx.translate(0, rect.top)` is band-local: y = 0 is the band's top edge, not the pane's. `valueToBandY` returns band-local y for exactly this reason. If you find yourself adding `rect.top` to a y anywhere inside the try block, something has gone wrong.
