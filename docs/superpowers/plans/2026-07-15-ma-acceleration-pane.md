# MA Acceleration Pane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional second sub-pane to the MA Slope indicator showing MA acceleration (the rate at which each MA's slope is changing), also pickable as a backtest/live rule operand with MTF parity.

**Architecture:** Acceleration math lives in the existing shared `slope.ts`, called by BOTH the pane and the rule recipe, so they agree by construction. The pane is an internal, parent-owned `SLOPE_ACCEL` companion indicator that is never persisted on its own: the parent Slope owns `showAccel` + accel params in its `extendData` and spawns/tears down the companion. Rule operands stay on the PARENT Slope instance via a 4-block line-index encoding that leaves existing saved rules untouched.

**Tech Stack:** TypeScript, React, klinecharts, vitest.

Spec: `docs/superpowers/specs/2026-07-15-ma-acceleration-pane-design.md`

## Global Constraints

- **No em dashes** in any UI copy, comments, or commit messages. Use a colon, comma, or period.
- **Tooltips:** use the shared `InfoTip` (`frontend/src/components/InfoTip.tsx`) for every new settings field. Never a native `title=`. Keep it inside a styled container (`.ind-info` ancestor) or it renders as a solid black box.
- **Value path is UNCLAMPED everywhere:** `Number(x) || 9` for MA lengths. Never `Math.max(1, ...)` on the value path. `operandBaseLen` keeps `Math.max` because that is reach-back sizing, not a value.
- **`backtestConfig.ts` MUST NOT import `slope.ts`.** That module loads klinecharts, which breaks `backtestConfig.ts`'s pure-config test isolation. It mirrors `slopeLengths` by hand (filter non-finite/zero, `.slice(0, 5)`, default `[9]`). Keep the two in lockstep manually.
- **Vitest gotcha:** the node env exports klinecharts `IndicatorSeries` / `LineType` as `undefined`, so any test importing a module that evaluates an indicator TEMPLATE at load throws. Use the `vi.mock("klinecharts", ...)` + top-level `await import` pattern (see `frontend/src/lib/indicators/pivotBands.test.ts` lines 1-13).
- **Settings writes:** `applySlope` must write `extendData` to the live indicator BEFORE the coordinator call, or the recompute reads stale stored values.
- **Run tests from `frontend/`:** `cd frontend && npx vitest run <path>`.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `frontend/src/lib/indicators/slope.ts` | Accel math (`accelSeries`, `accelLineSeries`), `SlopeExtend` fields, `SLOPE_ACCEL_TEMPLATE` | Modify |
| `frontend/src/lib/indicators/slope.test.ts` | Accel math + parity tests | Modify |
| `frontend/src/lib/customIndicators.ts` | Register `SLOPE_ACCEL` in `BASE_TEMPLATES` | Modify |
| `frontend/src/lib/indicators.ts` | `ACCEL_SUFFIX`, `isInternalIndicator`, `syncAccelCompanion`, hook in `applyIndicator` + `removeIndicatorById` | Modify |
| `frontend/src/ChartLegend.tsx` | Filter legend rows by `isInternalIndicator` | Modify |
| `frontend/src/lib/backtestSeries.ts` | 4-block decode in the SLOPE recipe case | Modify |
| `frontend/src/lib/chartOperand.ts` | 4-block picker rows + labels | Modify |
| `frontend/src/lib/backtestConfig.ts` | 4-block warm-up reach-back | Modify |
| `frontend/src/lib/mtfCoordinator.ts` | Stash `htfAccelByLine` computed on native HTF bars | Modify |
| `frontend/src/IndicatorSettings.tsx` | Accel settings controls + companion sync | Modify |
| `frontend/src/chart/useIndicatorCommands.ts` | Mirror eye-toggle visibility onto the companion | Modify |

**Task order rationale:** Task 1 (math) has no dependencies. Tasks 2-3 (pane + lifecycle) deliver a visible pane. Task 4 is the four-site operand encoding, which MUST land atomically. Task 5 is MTF. Task 6 is the settings UI. Task 7 is visibility mirroring.

---

### Task 1: Acceleration math in the shared module

**Files:**
- Modify: `frontend/src/lib/indicators/slope.ts`
- Test: `frontend/src/lib/indicators/slope.test.ts`

**Interfaces:**
- Consumes: existing `slopeLineSeries`, `smoothSeries`, `SlopeSmoothing`, `SlopeUnit`, `MaExtend` from `slope.ts`.
- Produces:
  - `accelSeries(slope: Array<number|undefined>, n2: number, barHours: number, perHour: boolean): Array<number|undefined>`
  - `accelLineSeries(candles: KLineData[], maType: "ema"|"sma", length: number, n: number, n2: number, units: SlopeUnit, source: MaExtend["source"], smoothing: SlopeSmoothing|undefined, accelSmoothing: SlopeSmoothing|undefined, barHours: number): Array<number|undefined>`
  - `SlopeExtend` gains `showAccel?: boolean`, `accelPeriod?: number`, `accelSmoothing?: SlopeSmoothing`, `accelThreshold?: SlopeThreshold`, and `mtf.htfAccelByLine?: Array<Array<number|undefined>>`.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/lib/indicators/slope.test.ts`:

```ts
describe("accelSeries", () => {
  it("is undefined for the first n2 bars", () => {
    const out = accelSeries([1, 2, 3, 4], 2, 1, false);
    expect(out[0]).toBeUndefined();
    expect(out[1]).toBeUndefined();
    expect(out[2]).toBe(1); // (3-1)/2
    expect(out[3]).toBe(1); // (4-2)/2
  });

  it("uses an absolute difference, so a zero-crossing slope stays finite", () => {
    // A percentage-style (v-prev)/|prev| would divide by 0 here and blow up.
    const out = accelSeries([-1, 0, 1], 1, 1, false);
    expect(out[1]).toBe(1);
    expect(out[2]).toBe(1);
    expect(Number.isFinite(out[2]!)).toBe(true);
  });

  it("divides by barHours when perHour is true", () => {
    // slope goes 0 -> 4 over n2=2 bars of 2h each = 4 hours -> 1 per hour
    const out = accelSeries([0, 2, 4], 2, 2, true);
    expect(out[2]).toBe(1);
  });

  it("does not divide by barHours when perHour is false", () => {
    const out = accelSeries([0, 2, 4], 2, 2, false);
    expect(out[2]).toBe(2); // (4-0)/2 bars
  });

  it("propagates undefined gaps", () => {
    const out = accelSeries([1, undefined, 3, 4], 1, 1, false);
    expect(out[1]).toBeUndefined();
    expect(out[2]).toBeUndefined(); // prev is undefined
    expect(out[3]).toBe(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/lib/indicators/slope.test.ts -t accelSeries`
Expected: FAIL with `accelSeries is not defined` (or an import error).

- [ ] **Step 3: Implement the math**

In `frontend/src/lib/indicators/slope.ts`, after `smoothSeries`:

```ts
/** Rate of change of a slope series over `n2` bars: the MA's acceleration.
 * Uses an ABSOLUTE difference, NOT the percentage renormalization slopeWithUnits
 * applies. The slope crosses zero, so dividing by |prev slope| would blow up at
 * the crossing. Units are therefore "slope units per hour" (perHour) or "slope
 * units per bar". undefined for the first n2 bars and wherever either endpoint
 * is undefined. */
export function accelSeries(
  slope: Array<number | undefined>,
  n2: number,
  barHours: number,
  perHour: boolean,
): Array<number | undefined> {
  return slope.map((v, i) => {
    const prev = slope[i - n2];
    if (i < n2 || v === undefined || prev === undefined) return undefined;
    const denom = n2 * (perHour ? barHours : 1);
    if (denom === 0) return undefined;
    return (v - prev) / denom;
  });
}

/** ONE MA-acceleration line: the slope line (already unit-converted and
 * slope-smoothed) differentiated again, then optionally smoothed on its own.
 * Pipeline: MA -> slope -> (slope smoothing) -> accel -> (accel smoothing).
 * Shared by the pane, the rule recipe, and MTF so all three agree by construction. */
export function accelLineSeries(
  candles: KLineData[],
  maType: "ema" | "sma",
  length: number,
  n: number,
  n2: number,
  units: SlopeUnit,
  source: MaExtend["source"],
  smoothing: SlopeSmoothing | undefined,
  accelSmoothing: SlopeSmoothing | undefined,
  barHours: number,
): Array<number | undefined> {
  const slope = slopeLineSeries(candles, maType, length, n, units, source, smoothing, barHours);
  // Time base follows the slope's units: a %/hr slope accelerates per hour;
  // %/bar and price/bar accelerate per bar. That is why there is no separate
  // accel units control.
  const accel = accelSeries(slope, n2, barHours, units === "pctHr");
  return smoothSeries(accel, accelSmoothing);
}
```

Extend the `SlopeExtend` interface in the same file:

```ts
export interface SlopeExtend extends MaExtend {
  maType?: "ema" | "sma";
  units?: SlopeUnit;
  slopePeriod?: number;
  smoothing?: SlopeSmoothing;
  colorByDirection?: boolean;
  showMa?: boolean;
  threshold?: SlopeThreshold;
  showAccel?: boolean;
  accelPeriod?: number;
  accelSmoothing?: SlopeSmoothing;
  accelThreshold?: SlopeThreshold;
  mtf?: MaExtend["mtf"] & {
    htfSeriesByLine?: Array<Array<number | undefined>>;
    htfMaBaseByLine?: Array<Array<number | undefined>>;
    htfAccelByLine?: Array<Array<number | undefined>>;
  };
}
```

Add `accelSeries` to the test file's imports alongside the existing slope imports.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/lib/indicators/slope.test.ts`
Expected: PASS, all tests including the pre-existing ones.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/indicators/slope.ts frontend/src/lib/indicators/slope.test.ts
git commit -m "feat(slope): shared MA acceleration math"
```

---

### Task 2: The SLOPE_ACCEL companion template

**Files:**
- Modify: `frontend/src/lib/indicators/slope.ts`
- Modify: `frontend/src/lib/customIndicators.ts`
- Test: `frontend/src/lib/indicators/slope.test.ts`

**Interfaces:**
- Consumes: `accelLineSeries`, `slopeLengths`, `slopeShared`, `drawSlope`, `slopeThresholdLevel` from Task 1 / existing `slope.ts`.
- Produces: `SLOPE_ACCEL_TEMPLATE: Omit<IndicatorTemplate, "name">`, exported from `slope.ts` and registered as `BASE_TEMPLATES.SLOPE_ACCEL`. `CustomIndicatorType` gains `"SLOPE_ACCEL"`.

**Note on the threshold guide:** `drawSlope` reads `ext.threshold`. The companion stores its own guide in `accelThreshold`. `syncAccelCompanion` (Task 3) copies `accelThreshold` into the companion's `threshold` field, so `drawSlope` and the auto-scale trick work unchanged with no branching.

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/lib/indicators/slope.test.ts`. This file already uses the `vi.mock("klinecharts", ...)` + top-level `await import` pattern; follow the existing imports at the top of the file.

```ts
describe("SLOPE_ACCEL_TEMPLATE", () => {
  it("labels figures as Accel per configured length", () => {
    const figs = SLOPE_ACCEL_TEMPLATE.regenerateFigures!([9, 21]) as Array<{ key: string; title: string }>;
    expect(figs[0]).toMatchObject({ key: "slope0", title: "Accel 9: " });
    expect(figs[1]).toMatchObject({ key: "slope1", title: "Accel 21: " });
    // Threshold auto-scale figures are appended, title-less.
    expect(figs.slice(2).map((f) => f.key)).toEqual(["thHi", "thLo"]);
  });

  it("computes acceleration, not slope", () => {
    const candles = Array.from({ length: 40 }, (_, i) => ({
      timestamp: i * 3_600_000,
      open: 100 + i, high: 100 + i, low: 100 + i, close: 100 + i, volume: 1,
    }));
    const ind = { calcParams: [5], extendData: { slopePeriod: 2, accelPeriod: 2, units: "pctBar" } };
    const out = SLOPE_ACCEL_TEMPLATE.calc(candles as never, ind as never) as Array<Record<string, number | undefined>>;
    const expected = accelLineSeries(candles as never, "ema", 5, 2, 2, "pctBar", undefined, undefined, undefined, 1);
    expect(out.map((p) => p.slope0)).toEqual(expected);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/indicators/slope.test.ts -t SLOPE_ACCEL_TEMPLATE`
Expected: FAIL with `SLOPE_ACCEL_TEMPLATE is not defined`.

- [ ] **Step 3: Implement the template**

In `frontend/src/lib/indicators/slope.ts`, add a figures helper next to `slopeFigures`:

```ts
// Same shape as slopeFigures (including the title-less thHi/thLo auto-scale
// figures) but labelled Accel, so the companion pane's native canvas legend
// reads correctly. Keys stay slope<i> so drawSlope is reused verbatim.
function accelFigures(calcParams: unknown[]): Array<{ key: string; title: string; type: "line" }> {
  const lines = slopeLengths(calcParams).map((len, i) => ({
    key: `slope${i}`,
    title: `Accel ${len}: `,
    type: "line" as const,
  }));
  const threshold = ["thHi", "thLo"].map((key) => ({ key, title: "", type: "line" as const }));
  return [...lines, ...threshold];
}
```

Add the accel calc next to `computeSlopeCalc`:

```ts
// The companion pane's calc. Mirrors computeSlopeCalc exactly (same keys, same
// threshold auto-scale trick, same MTF align-don't-recompute rule) but the values
// are acceleration. On a higher timeframe it aligns the coordinator-stashed
// htfAccelByLine, which was computed on NATIVE HTF bars: differentiating the
// already-aligned slope would read zero inside a bucket and spike at boundaries.
function computeAccelCalc(candles: KLineData[], ind: Indicator): SlopePoint[] {
  const ext = (ind.extendData ?? {}) as SlopeExtend;
  const lengths = slopeLengths(ind.calcParams);
  const { maType, n, units, source, smoothing } = slopeShared(ext);
  const n2 = Number(ext.accelPeriod) || 3;
  const th = slopeThresholdLevel(ext);
  const withThreshold = (p: SlopePoint): SlopePoint => {
    if (th !== null) {
      p.thHi = th;
      p.thLo = -th;
    }
    return p;
  };
  const mtf = ext.mtf;
  if (mtf?.timeframe && mtf.htfAccelByLine && mtf.htfStarts && mtf.htfMs) {
    const ts = candles.map((k) => k.timestamp);
    const starts = mtf.htfStarts.map((t) => ({ timestamp: t }) as KLineData);
    const aligned = mtf.htfAccelByLine.map((series) =>
      alignHtfToChart(ts, starts, series, mtf.htfMs!, true),
    );
    return candles.map((_, i) => {
      const p: SlopePoint = {};
      aligned.forEach((a, li) => (p[`slope${li}`] = a[i] ?? undefined));
      return withThreshold(p);
    });
  }
  const barHours = inferBarHours(candles);
  const lines = lengths.map((len) =>
    accelLineSeries(candles, maType, len, n, n2, units, source, smoothing, ext.accelSmoothing, barHours),
  );
  return candles.map((_, i) => {
    const p: SlopePoint = {};
    lines.forEach((line, li) => (p[`slope${li}`] = line[i] ?? undefined));
    return withThreshold(p);
  });
}

/** The acceleration companion pane. An INTERNAL template: it is never in the
 * indicator menu and never a rule operand (operands live on the parent Slope).
 * Reuses drawSlope, so the zero line, threshold guide, color-by-direction and
 * palette all behave exactly like the Slope pane. */
export const SLOPE_ACCEL_TEMPLATE: Omit<IndicatorTemplate, "name"> = {
  shortName: "Accel",
  series: IndicatorSeries.Normal,
  precision: 4,
  calcParams: [9],
  figures: accelFigures([9]),
  regenerateFigures: ((calcParams: unknown[]) =>
    accelFigures(calcParams)) as IndicatorTemplate["regenerateFigures"],
  styles: { lines: SLOPE_PALETTE.map((c) => fullLine(c, LineType.Solid)) },
  calc: (dataList: KLineData[], ind: Indicator) => computeAccelCalc(dataList, ind),
  draw: (params) => drawSlope(params as IndicatorDrawParams<SlopePoint>),
};
```

In `frontend/src/lib/customIndicators.ts`: add `SLOPE_ACCEL` to the `CustomIndicatorType` union, import `SLOPE_ACCEL_TEMPLATE` from `./indicators/slope`, and add `SLOPE_ACCEL: SLOPE_ACCEL_TEMPLATE` to `BASE_TEMPLATES`.

Do NOT add it to `SUPPORTED_INDICATORS` (`chartOperand.ts`) or to `INDICATOR_META` (`indicatorMeta.ts`). It must not be pickable as an operand and must not appear in the indicator menu.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/lib/indicators/slope.test.ts src/lib/indicators.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/indicators/slope.ts frontend/src/lib/customIndicators.ts frontend/src/lib/indicators/slope.test.ts
git commit -m "feat(slope): SLOPE_ACCEL companion pane template"
```

---

### Task 3: Companion lifecycle (spawn, tear down, internal filtering)

**Files:**
- Modify: `frontend/src/lib/indicators.ts`
- Modify: `frontend/src/ChartLegend.tsx:824`
- Test: `frontend/src/lib/indicators.test.ts`

**Interfaces:**
- Consumes: `SLOPE_ACCEL` from `BASE_TEMPLATES` (Task 2); existing `applyIndicator`, `removeIndicatorById`, `INTERNAL_INDICATORS`.
- Produces:
  - `ACCEL_SUFFIX = "__accel"`
  - `accelCompanionId(parentId: string): string`
  - `isInternalIndicator(name: string): boolean`
  - `syncAccelCompanion(chart: Chart, parentId: string): void`

**The invariant this task establishes:** the companion is derived, ephemeral, and always spawned/torn down BY THE PARENT. It never enters the persisted instance list and is never recreated by the reorder loop from an empty config.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/lib/indicators.test.ts` (this file already mocks klinecharts; follow its existing pattern):

```ts
describe("isInternalIndicator", () => {
  it("matches the fixed equity pane", () => {
    expect(isInternalIndicator("EQUITY")).toBe(true);
  });
  it("matches any accel companion, whose id is dynamic", () => {
    expect(isInternalIndicator("SLOPE__accel")).toBe(true);
    expect(isInternalIndicator("SLOPE#a1b2c3__accel")).toBe(true);
  });
  it("does not match a normal indicator", () => {
    expect(isInternalIndicator("SLOPE")).toBe(false);
    expect(isInternalIndicator("RSI#a1b2c3")).toBe(false);
  });
});

describe("accelCompanionId", () => {
  it("derives a deterministic id from the parent", () => {
    expect(accelCompanionId("SLOPE#a1b2c3")).toBe("SLOPE#a1b2c3__accel");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/lib/indicators.test.ts -t isInternalIndicator`
Expected: FAIL with `isInternalIndicator is not defined`.

- [ ] **Step 3: Implement the predicate and the sync helper**

In `frontend/src/lib/indicators.ts`, replace the `INTERNAL_INDICATORS` block (currently line 167-171) with:

```ts
// Panes the reorder feature must never touch: the candle pane is handled by paneId,
// and the backtest equity curve is app-owned. Exported so ChartLegend filters on the
// SAME predicate — the legend's card index and this engine's reorderable order both
// exclude these, and they must agree or arrow/menu moves go off-by-one. One
// definition, no drift.
export const INTERNAL_INDICATORS = new Set<string>([EQUITY_INDICATOR]);

/** The Slope indicator's acceleration companion pane is parent-owned and derived:
 * its id is minted from the parent's, so it cannot be a fixed set member. */
export const ACCEL_SUFFIX = "__accel";
export const accelCompanionId = (parentId: string): string => `${parentId}${ACCEL_SUFFIX}`;

/** Internal for REORDER and LEGEND purposes: app-owned panes plus accel companions.
 * NOTE deliberately NOT used by applyIndicatorVisibility — see the comment there.
 * The equity pane has no user visibility intent; the accel pane follows its parent. */
export const isInternalIndicator = (name: string): boolean =>
  INTERNAL_INDICATORS.has(name) || name.endsWith(ACCEL_SUFFIX);
```

Update `reorderablePanes` (line 193) to use the predicate:

```ts
      if (!ind?.name || isInternalIndicator(ind.name)) continue;
```

Leave `applyIndicatorVisibility` (line 479) on `INTERNAL_INDICATORS.has(ind.name)` and add this comment above that line:

```ts
      // NOT isInternalIndicator: the accel companion DOES have user visibility
      // intent and must follow its parent (syncAccelCompanion copies the parent's
      // userVisible + visibility model onto it, so this sweep computes the same
      // answer for both). Skipping it here would leave a stray accel pane on
      // screen when its Slope is hidden. Only EQUITY is app-owned.
      if (!ind?.name || INTERNAL_INDICATORS.has(ind.name)) continue;
```

In `ChartLegend.tsx:824`, swap the filter to the predicate and update its import at line 28:

```ts
    const rows = rowsForPane(inds, lineStyles, legendTextColor).filter(
      (r) => !isInternalIndicator(r.name),
    );
```

Add the sync helper to `indicators.ts`:

```ts
// Spawn/tear down a Slope's acceleration companion pane. The companion is DERIVED
// state: the parent owns showAccel + the accel params, and nothing about the
// companion is persisted, so there is exactly one source of truth. Remove-then-
// create is what keeps the companion directly below its parent: reorder recreates
// parents in order (each pane appended at the bottom) and this runs inside the
// parent's applyIndicator, so panes land as [P1, A1, P2, A2, ...].
export function syncAccelCompanion(chart: Chart, parentId: string): void {
  const companionId = accelCompanionId(parentId);
  const panes = chart.getIndicatorByPaneId() as
    | Map<string, Map<string, Indicator>>
    | null
    | undefined;
  let parent: Indicator | null = null;
  for (const inds of panes?.values() ?? []) {
    const p = inds.get(parentId);
    if (p) parent = p as Indicator;
  }
  // Drop any existing companion wherever it currently sits.
  for (const [paneId, inds] of panes ?? []) {
    if (inds.has(companionId)) {
      chart.removeIndicator(paneId, companionId);
      break;
    }
  }
  if (!parent) return;
  const ext = (parent.extendData ?? {}) as SlopeExtend & {
    userVisible?: boolean;
    visibility?: VisibilityModel;
  };
  if (!ext.showAccel) return;
  registerInstanceTemplate(chart, "SLOPE_ACCEL", companionId);
  // Copy the parent's config. accelThreshold lands on the companion's `threshold`
  // field so the reused drawSlope + its auto-scale trick work with no branching.
  // The mtf stash is copied wholesale: computeAccelCalc reads htfAccelByLine.
  const newPaneId = chart.createIndicator(
    {
      name: companionId,
      createTooltipDataSource: legendTooltipSource,
      calcParams: parent.calcParams,
      extendData: {
        ...ext,
        indType: "SLOPE_ACCEL",
        threshold: ext.accelThreshold,
      },
      ...(parent.visible === false ? { visible: false } : {}),
    },
    false,
    { height: SUBPANE_HEIGHT, gap: { top: 0.08, bottom: 0.08 } },
  );
  // Match the parent's per-line style overrides so line N is the same color in
  // both panes. Styles must be applied by overrideIndicator against the pane
  // createIndicator just returned.
  if (newPaneId && parent.styles)
    chart.overrideIndicator(
      { name: companionId, styles: parent.styles as unknown as Partial<IndicatorStyle> },
      newPaneId,
    );
}
```

Hook it into `applyIndicator`, immediately before its `return paneId;` (currently line 457). This single choke point covers hydrate, reorder-recreate, fresh add, paste, templates, and snapshots:

```ts
  // The parent Slope owns its acceleration companion. applyIndicator is the ONE
  // creation choke point (hydrate, reorder, fresh add, paste, templates,
  // snapshots all route here), so every recreate path re-derives the companion.
  if (type === "SLOPE") syncAccelCompanion(chart, id);
  return paneId;
```

Hook teardown into `removeIndicatorById`, before `deleteIndicatorConfig`:

```ts
export function removeIndicatorById(chart: Chart, scope: string, id: string): void {
  const panes = chart.getIndicatorByPaneId() as
    | Map<string, Map<string, Indicator>>
    | null
    | undefined;
  for (const [paneId, inds] of panes ?? []) {
    if (inds.has(id)) {
      chart.removeIndicator(paneId, id);
      break;
    }
  }
  // A Slope owns its accel companion: remove it alongside, or it is orphaned.
  const companionId = accelCompanionId(id);
  for (const [paneId, inds] of panes ?? []) {
    if (inds.has(companionId)) {
      chart.removeIndicator(paneId, companionId);
      break;
    }
  }
  deleteIndicatorConfig(scope, id);
}
```

Import `SlopeExtend` from `./indicators/slope` in `indicators.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/lib/indicators.test.ts && npx tsc --noEmit -p frontend/tsconfig.json`
Expected: tests PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/indicators.ts frontend/src/lib/indicators.test.ts frontend/src/ChartLegend.tsx
git commit -m "feat(slope): parent-owned accel companion lifecycle"
```

---

### Task 4: Operand encoding across four sites (ATOMIC)

**Files:**
- Modify: `frontend/src/lib/chartOperand.ts:249-270`
- Modify: `frontend/src/lib/backtestSeries.ts:283-303`
- Modify: `frontend/src/lib/backtestConfig.ts:434-451`
- Modify: `frontend/src/lib/mtfCoordinator.ts`
- Test: `frontend/src/lib/backtestSeries.test.ts`, `frontend/src/lib/backtestConfig.test.ts`, `frontend/src/lib/chartOperand.test.ts`

**Interfaces:**
- Consumes: `accelLineSeries` (Task 1).
- Produces: the 4-block line encoding, relative to `K = slopeLengths(calcParams).length`.

**THIS TASK MUST LAND AS ONE COMMIT.** These four sites encode the same meaning. Commit `46f044b` flipped the evaluator and the picker but NOT the warm-up, and smoothed-slope backtests silently under-warmed until `753df77` fixed it. Do not split this task.

| Block | Lines | Meaning |
|---|---|---|
| 0 | `0 … K-1` | raw slope of `lengths[j]` (unchanged) |
| 1 | `K … 2K-1` | smoothed slope of `lengths[j]` (unchanged) |
| 2 | `2K … 3K-1` | acceleration of `lengths[j]`, no accel smoothing |
| 3 | `3K … 4K-1` | acceleration of `lengths[j]`, accel-smoothed |

Decode: `block = Math.floor(line / K)`, `j = line % K`. Blocks 0/1 keep their exact current meaning, so every saved rule keeps its meaning. All blocks always decode (a block that is off degenerates to a real value rather than undefined, because a dead operand would silently stop a rule); only the picker hides blocks that are not meaningful.

- [ ] **Step 1: Write the failing tests**

In `frontend/src/lib/backtestSeries.test.ts`:

```ts
it("SLOPE block 2 resolves acceleration, block 3 the smoothed acceleration", () => {
  // `candles(closes)` is the existing helper at the top of this file (line 27).
  const bars = candles(Array.from({ length: 60 }, (_, i) => 100 + i));
  const extend = { slopePeriod: 2, accelPeriod: 2, units: "pctBar", maType: "ema",
                   accelSmoothing: { type: "sma", length: 3 } };
  const recipe = (line: number) => ({
    source: "indicator" as const, indicatorType: "SLOPE" as const,
    calcParams: [5, 10], line, extend,
  });
  const K = 2;
  const bh = inferBarHours(bars);
  // Block 2: accel of lengths[0], no accel smoothing.
  expect(computeIndicatorRecipe(bars, recipe(2 * K + 0), bh)).toEqual(
    accelLineSeries(bars, "ema", 5, 2, 2, "pctBar", undefined, undefined, undefined, bh),
  );
  // Block 3: accel of lengths[1], accel-smoothed.
  expect(computeIndicatorRecipe(bars, recipe(3 * K + 1), bh)).toEqual(
    accelLineSeries(bars, "ema", 10, 2, 2, "pctBar", undefined, undefined,
                    { type: "sma", length: 3 }, bh),
  );
});

it("SLOPE blocks 0 and 1 keep their existing meaning", () => {
  const bars = candles(Array.from({ length: 60 }, (_, i) => 100 + i));
  const extend = { slopePeriod: 2, units: "pctBar", maType: "ema",
                   smoothing: { type: "sma", length: 3 } };
  const bh = inferBarHours(bars);
  const recipe = (line: number) => ({
    source: "indicator" as const, indicatorType: "SLOPE" as const,
    calcParams: [5, 10], line, extend,
  });
  expect(computeIndicatorRecipe(bars, recipe(0), bh)).toEqual(
    slopeLineSeries(bars, "ema", 5, 2, "pctBar", undefined, undefined, bh),
  );
  expect(computeIndicatorRecipe(bars, recipe(2), bh)).toEqual(
    slopeLineSeries(bars, "ema", 5, 2, "pctBar", undefined, { type: "sma", length: 3 }, bh),
  );
});
```

In `frontend/src/lib/backtestConfig.test.ts`:

```ts
it("SLOPE accel warm-up reaches back far enough per block", () => {
  const op = (line: number, extend: object) => ({
    kind: "series" as const,
    recipe: { source: "indicator" as const, indicatorType: "SLOPE" as const,
              calcParams: [9, 21], line, extend },
  });
  const base = { slopePeriod: 3, accelPeriod: 4 };
  const K = 2;
  // Block 0: len + n
  expect(operandBaseLen(op(0, base))).toBe(9 + 3);
  // Block 1: len + n + smoothing window
  expect(operandBaseLen(op(K + 0, { ...base, smoothing: { type: "sma", length: 5 } })))
    .toBe(9 + 3 + 5);
  // Block 2: len + n + n2
  expect(operandBaseLen(op(2 * K + 0, base))).toBe(9 + 3 + 4);
  // Block 2 with slope smoothing on: accel differentiates the SMOOTHED slope,
  // so the smoothing window counts too.
  expect(operandBaseLen(op(2 * K + 0, { ...base, smoothing: { type: "sma", length: 5 } })))
    .toBe(9 + 3 + 4 + 5);
  // Block 3: block 2 + accel smoothing window
  expect(operandBaseLen(op(3 * K + 1, { ...base, accelSmoothing: { type: "sma", length: 2 } })))
    .toBe(21 + 3 + 4 + 2);
});
```

In `frontend/src/lib/chartOperand.test.ts`:

```ts
it("offers accel outputs only when showAccel is on", () => {
  const cp = [9, 21];
  expect(indicatorOutputs("SLOPE", { slopePeriod: 3 }, cp).map((o) => o.lineIndex))
    .toEqual([0, 1]);
  const withAccel = indicatorOutputs("SLOPE", { slopePeriod: 3, showAccel: true }, cp);
  expect(withAccel.map((o) => o.lineIndex)).toEqual([0, 1, 4, 5]);
  expect(withAccel[2].label).toBe("Accel MA 9");
  // Block 3 only when accel smoothing is active.
  const smoothed = indicatorOutputs(
    "SLOPE",
    { slopePeriod: 3, showAccel: true, accelSmoothing: { type: "ema", length: 4 } },
    cp,
  );
  expect(smoothed.map((o) => o.lineIndex)).toEqual([0, 1, 4, 5, 6, 7]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/lib/backtestSeries.test.ts src/lib/backtestConfig.test.ts src/lib/chartOperand.test.ts`
Expected: FAIL. The accel assertions fail; blocks 0/1 assertions already pass.

- [ ] **Step 3a: Evaluator (`backtestSeries.ts`)**

Replace the body of the `case "SLOPE":` block (lines 283-303) with:

```ts
    case "SLOPE": {
      // Uses inferBarHours(candles) — NOT the threaded barHours param — so this
      // matches SLOPE_TEMPLATE.calc exactly (recipe/visual parity). The threaded
      // barHours instead drives the operand-level `~slope` transform in derive().
      // Four fixed blocks, relative to K = number of configured lengths:
      //   block 0 (line < K)      raw slope of lengths[j]
      //   block 1 (K..2K-1)       smoothed slope of lengths[j]
      //   block 2 (2K..3K-1)      acceleration of lengths[j]
      //   block 3 (3K..4K-1)      accel-smoothed acceleration of lengths[j]
      // Every block always resolves to a real value: a block whose toggle is off
      // degenerates (smoothing none is identity) rather than returning undefined,
      // because a dead operand would silently stop a rule.
      const sext = ext as SlopeExtend;
      const lengths = slopeLengths(r.calcParams);
      const K = lengths.length;
      const line = r.line ?? 0;
      const block = Math.floor(line / K);
      const len = lengths[line % K] ?? lengths[0];
      const maType = sext.maType === "sma" ? "sma" : "ema";
      const n = Number(sext.slopePeriod) || 3;
      const n2 = Number(sext.accelPeriod) || 3;
      const units: SlopeUnit = sext.units ?? "pctHr";
      const bh = inferBarHours(candles);
      if (block >= 2) {
        return accelLineSeries(candles, maType, len, n, n2, units, sext.source,
          sext.smoothing, block === 3 ? sext.accelSmoothing : undefined, bh);
      }
      return slopeLineSeries(candles, maType, len, n, units, sext.source,
        block === 1 ? sext.smoothing : undefined, bh);
    }
```

Add `accelLineSeries` to this file's import from `./indicators/slope`.

- [ ] **Step 3b: Picker (`chartOperand.ts`)**

Replace the body of `case "SLOPE":` (lines 249-270) with:

```ts
    case "SLOPE": {
      // Rate-only outputs in four fixed blocks relative to K. See the matching
      // `line` encoding in backtestSeries.ts's computeIndicatorRecipe and the
      // warm-up in backtestConfig.ts's operandBaseLen — all three must agree.
      const lengths = (Array.isArray(calcParams) ? calcParams : []).map(Number)
        .filter((v) => Number.isFinite(v) && v !== 0).slice(0, 5);
      const ls = lengths.length ? lengths : [9];
      const K = ls.length;
      const sm = ext.smoothing as { type?: string; length?: number } | undefined;
      const smOn = !!sm && sm.type !== "none" && (sm.length ?? 0) > 1;
      const aSm = ext.accelSmoothing as { type?: string; length?: number } | undefined;
      const aSmOn = !!aSm && aSm.type !== "none" && (aSm.length ?? 0) > 1;
      // The parent label ("MA Slope") carries no length, so the chip fuses the
      // length in ("MA Slope 9") rather than reading "MA Slope: Slope MA 9".
      const slopes = ls.map((len, i) => ({ lineIndex: i, label: `Slope MA ${len}`, chipLabel: `MA Slope ${len}` }));
      const smoothed = smOn
        ? ls.map((len, i) => {
            const suffix = `${String(sm!.type).toUpperCase()} ${sm!.length}`;
            return { lineIndex: K + i, label: `Slope MA ${len} · ${suffix}`, chipLabel: `MA Slope ${len} · ${suffix}` };
          })
        : [];
      const accel = ext.showAccel
        ? ls.map((len, i) => ({ lineIndex: 2 * K + i, label: `Accel MA ${len}`, chipLabel: `MA Accel ${len}` }))
        : [];
      const accelSmoothed = ext.showAccel && aSmOn
        ? ls.map((len, i) => {
            const suffix = `${String(aSm!.type).toUpperCase()} ${aSm!.length}`;
            return { lineIndex: 3 * K + i, label: `Accel MA ${len} · ${suffix}`, chipLabel: `MA Accel ${len} · ${suffix}` };
          })
        : [];
      return [...slopes, ...smoothed, ...accel, ...accelSmoothed];
    }
```

- [ ] **Step 3c: Warm-up (`backtestConfig.ts`)**

Replace the `if (r.indicatorType === "SLOPE")` body (lines 434-451) with:

```ts
    if (r.indicatorType === "SLOPE") {
      const ext = (r.extend ?? {}) as {
        slopePeriod?: number;
        accelPeriod?: number;
        smoothing?: { type?: string; length?: number };
        accelSmoothing?: { type?: string; length?: number };
      };
      // Mirror slopeLengths() (indicators/slope.ts) inline rather than importing it —
      // that module pulls in klinecharts at load time, which breaks this file's
      // pure-config test isolation (no klinecharts mock there). Keep the filter +
      // cap + default in lockstep with slopeLengths by hand.
      const raw = (r.calcParams ?? []).map(Number).filter((v) => Number.isFinite(v) && v !== 0);
      const lengths = (raw.length ? raw.slice(0, 5) : [9]);
      const K = lengths.length;
      const line = r.line ?? 0;
      const block = Math.floor(line / K);
      const len = lengths[line % K] ?? lengths[0];
      const n = Number(ext.slopePeriod) || 3;
      const n2 = Number(ext.accelPeriod) || 3;
      const win = (s?: { type?: string; length?: number }): number =>
        s && s.type && s.type !== "none" ? (Number(s.length) || 0) : 0;
      const smLen = win(ext.smoothing);
      // block 0: MA + slope lookback. block 1: + the smoothing window (only the
      // smoothed line is built with smoothing; adding it to the raw line would
      // over-warm a series that never smooths). blocks 2/3: accel differentiates
      // the slope AS BUILT, so slope smoothing counts whenever it is on; block 3
      // adds its own accel smoothing window.
      if (block >= 2) return len + n + n2 + smLen + (block === 3 ? win(ext.accelSmoothing) : 0);
      return len + n + (block === 1 ? smLen : 0);
    }
```

- [ ] **Step 3d: MTF K-agreement (`mtfCoordinator.ts`)**

In `applySlopeTimeframe`, widen the HTF reach-back so accel's extra lookback is covered. Replace the `smLen` + `fetchHtfBars` reach-back argument (around lines 415-420):

```ts
  // Reach back the longest MA length + slope period + accel period (+ both
  // smoothing windows) so the HTF left edge is populated for every line.
  const smLen = config.smoothing && config.smoothing.type !== "none" ? Number(config.smoothing.length) || 0 : 0;
  const aSmLen = ext.accelSmoothing && ext.accelSmoothing.type !== "none" ? Number(ext.accelSmoothing.length) || 0 : 0;
  const n2 = Number(ext.accelPeriod) || 3;
  const { htf, htfMs, failed } = await fetchHtfBars(
    chart,
    epic,
    timeframe,
    Math.max(...config.lengths) + config.slopeN + smLen + (ext.showAccel ? n2 + aSmLen : 0),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/lib/backtestSeries.test.ts src/lib/backtestConfig.test.ts src/lib/chartOperand.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit (all four sites together)**

```bash
git add frontend/src/lib/backtestSeries.ts frontend/src/lib/chartOperand.ts frontend/src/lib/backtestConfig.ts frontend/src/lib/mtfCoordinator.ts frontend/src/lib/backtestSeries.test.ts frontend/src/lib/backtestConfig.test.ts frontend/src/lib/chartOperand.test.ts
git commit -m "feat(slope): acceleration rule operands via 4-block line encoding"
```

---

### Task 5: MTF for the acceleration pane

**Files:**
- Modify: `frontend/src/lib/mtfCoordinator.ts`
- Test: `frontend/src/lib/indicators/slope.test.ts`

**Interfaces:**
- Consumes: `accelSeries` (Task 1); the existing `applySlopeTimeframe` HTF fetch and `htfSeriesByLine` stash.
- Produces: `ext.mtf.htfAccelByLine`, read by `computeAccelCalc` (Task 2).

**The trap:** acceleration MUST be computed on NATIVE HTF bars and THEN aligned. Differentiating the already-aligned slope is wrong: alignment forward-fills one HTF value across every chart bar in a bucket, so an aligned diff reads zero inside the bucket and spikes at boundaries, and it would diverge from the rule value (which computes on native HTF). This is the same slope-before-forward-fill trap recorded in `[[slope-conditions]]`.

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/lib/indicators/slope.test.ts`:

```ts
it("accel on native HTF bars differs from diffing the aligned slope", () => {
  // Alignment forward-fills, so diffing AFTER aligning reads 0 inside a bucket.
  const nativeSlope = [1, 2, 3, 4];
  const nativeAccel = accelSeries(nativeSlope, 1, 1, false);
  expect(nativeAccel).toEqual([undefined, 1, 1, 1]);
  // The same series aligned onto 2 chart bars per HTF bar, then diffed.
  const aligned = [1, 1, 2, 2, 3, 3, 4, 4];
  const wrong = accelSeries(aligned, 1, 1, false);
  expect(wrong).toEqual([undefined, 0, 1, 0, 1, 0, 1, 0]);
  // The zeros are the bug this stash exists to avoid.
  expect(wrong).not.toEqual([undefined, 1, 1, 1, 1, 1, 1, 1]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/indicators/slope.test.ts -t "native HTF"`
Expected: PASS immediately if `accelSeries` is correct. This test locks the invariant rather than driving new code; if it fails, `accelSeries` from Task 1 is wrong. Fix Task 1 before continuing.

- [ ] **Step 3: Stash the HTF accel series**

In `mtfCoordinator.ts` `applySlopeTimeframe`, find where `htfSeriesByLine` is built from the fetched `htf` bars and add the accel stash alongside it. It must reuse the SAME `inferBarHours(htf)` the slope stash uses:

```ts
  // Slope computed on native HTF bars with HTF barHours (inferBarHours matches the
  // rule path, so the visual and the operand agree).
  const htfBarHours = inferBarHours(htf);
  const htfSeriesByLine = config.lengths.map((len) =>
    slopeLineSeries(htf, config.maType, len, config.slopeN, config.units, ext.source, config.smoothing, htfBarHours),
  );
  // Acceleration computed on NATIVE HTF bars too, then aligned by computeAccelCalc.
  // Differentiating the ALIGNED slope would read zero inside each HTF bucket and
  // spike at the boundaries, and would diverge from the rule value.
  const htfAccelByLine = ext.showAccel
    ? config.lengths.map((len) =>
        accelLineSeries(htf, config.maType, len, config.slopeN, Number(ext.accelPeriod) || 3,
          config.units, ext.source, config.smoothing, ext.accelSmoothing, htfBarHours),
      )
    : undefined;
```

Include `htfAccelByLine` in the `ext.mtf = { ... }` object that this function writes, alongside the existing `htfSeriesByLine` / `htfMaBaseByLine` / `htfStarts` / `htfMs` fields.

After the coordinator writes the parent's `extendData`, the companion must be re-synced so it picks up the new MTF stash. At the end of `applySlopeTimeframe`, after the final `chart.overrideIndicator(...)` call for the parent, add:

```ts
  // The companion mirrors the parent's extendData (including the MTF stash).
  syncAccelCompanion(chart, name);
```

Import `accelLineSeries` from `./indicators/slope` and `syncAccelCompanion` from `./indicators` in `mtfCoordinator.ts`.

- [ ] **Step 4: Run the tests and typecheck**

Run: `cd frontend && npx vitest run src/lib/indicators/slope.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/mtfCoordinator.ts frontend/src/lib/indicators/slope.test.ts
git commit -m "feat(slope): MTF for the acceleration pane, computed on native HTF bars"
```

---

### Task 6: Settings UI

**Files:**
- Modify: `frontend/src/IndicatorSettings.tsx` (the SLOPE branch, around lines 750-790 for `applySlope` and 1400-1480 for the controls)

**Interfaces:**
- Consumes: `syncAccelCompanion` (Task 3); the existing `applySlope` closure and `ColorLineStylePicker`.
- Produces: user-facing controls writing `showAccel`, `accelPeriod`, `accelSmoothing`, `accelThreshold` to the parent's `extendData`.

- [ ] **Step 1: Extend `applySlope` to carry the accel fields**

`applySlope` currently takes a partial patch and writes `extendData` to the live indicator BEFORE calling `applySlopeTimeframe`. Add the new fields to its patch type and to the `ext` it builds:

```ts
  function applySlope(
    patch: {
      lengths?: number[];
      slopeN?: number;
      smoothing?: SlopeSmoothing;
      colorByDirection?: boolean;
      showMa?: boolean;
      threshold?: SlopeThreshold;
      showAccel?: boolean;
      accelPeriod?: number;
      accelSmoothing?: SlopeSmoothing;
      accelThreshold?: SlopeThreshold;
    },
  ) {
```

Keep the existing "write extendData to the live indicator BEFORE the coordinator call" ordering. After the `applySlopeTimeframe` call, re-derive the companion:

```ts
    // The companion is derived from the parent's extendData: re-sync after every
    // edit so a toggle, a param change, or a style change lands in both panes.
    syncAccelCompanion(chart, name);
```

Import `syncAccelCompanion` from `./lib/indicators`.

- [ ] **Step 2: Add the controls**

In the SLOPE branch of the settings body, after the existing threshold block, add. Every field gets an `InfoTip`, and the block must stay inside the existing `.ind-info`-styled container so the tip does not render as a solid black box:

```tsx
<label className="ind-row">
  <input
    type="checkbox"
    checked={!!ext.showAccel}
    onChange={(e) => applySlope({ showAccel: e.target.checked })}
  />
  Show acceleration pane
  <InfoTip
    title="Show acceleration pane"
    text={[
      "Adds a second pane below showing how fast each MA's slope is changing.",
      "Positive means the slope is steepening. Negative means it is flattening.",
    ]}
  />
</label>
{ext.showAccel && (
  <>
    <label className="ind-row">
      Acceleration period
      <input
        type="number"
        min={1}
        value={ext.accelPeriod ?? 3}
        onChange={(e) => applySlope({ accelPeriod: Number(e.target.value) })}
      />
      <InfoTip
        title="Acceleration period"
        text={[
          "How many bars the slope change is measured over.",
          "A larger period gives a smaller, smoother reading.",
        ]}
      />
    </label>
    <label className="ind-row">
      Acceleration smoothing
      <select
        value={ext.accelSmoothing?.type ?? "none"}
        onChange={(e) =>
          applySlope({
            accelSmoothing: {
              type: e.target.value as SlopeSmoothing["type"],
              length: ext.accelSmoothing?.length ?? 3,
            },
          })
        }
      >
        <option value="none">None</option>
        <option value="sma">SMA</option>
        <option value="ema">EMA</option>
      </select>
      <input
        type="number"
        min={1}
        value={ext.accelSmoothing?.length ?? 3}
        onChange={(e) =>
          applySlope({
            accelSmoothing: {
              type: ext.accelSmoothing?.type ?? "none",
              length: Number(e.target.value),
            },
          })
        }
      />
      <InfoTip
        title="Acceleration smoothing"
        text="Averages the acceleration line to cut noise. Acceleration is a second derivative, so it is noisier than slope."
      />
    </label>
  </>
)}
```

Units note for the InfoTip copy: acceleration units follow the slope's units, so a %/hr slope gives %/hr per hour, and %/bar or price/bar gives per bar.

- [ ] **Step 3: Typecheck and lint**

Run: `cd frontend && npx tsc --noEmit && npx eslint src/IndicatorSettings.tsx`
Expected: no errors.

- [ ] **Step 4: Verify in the browser**

Do NOT kill the user's HMR dev server. Open the app, add an MA Slope indicator, and confirm:
1. Toggling "Show acceleration pane" adds a pane directly below the Slope pane.
2. Changing the MA lengths chips updates both panes' line counts.
3. Toggling off removes the accel pane.
4. Removing the Slope removes both panes.
5. Reloading the page brings both panes back.
6. In a backtest rule, the chart-operand picker offers "MA Accel 9" rows.

Close any browser tab you opened when done.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/IndicatorSettings.tsx
git commit -m "feat(slope): acceleration pane settings"
```

---

### Task 7: Visibility mirroring

**Files:**
- Modify: `frontend/src/chart/useIndicatorCommands.ts:81-90`

**Interfaces:**
- Consumes: `syncAccelCompanion` (Task 3).

**Why:** `applyIndicatorVisibility` deliberately still uses `INTERNAL_INDICATORS.has(name)` (Task 3), so it DOES process the companion, and `syncAccelCompanion` copies the parent's `userVisible` + `visibility` model onto it. That covers the sidebar master switch and per-resolution visibility. The per-indicator eye toggle writes only to the parent, so it needs an explicit mirror.

- [ ] **Step 1: Mirror the eye toggle onto the companion**

In the legend eye-toggle callback, after the existing `saveIndicatorVisible(scope, name, next);`:

```ts
    // A Slope's accel companion follows its parent's visibility. Mirror the flag
    // directly rather than re-running syncAccelCompanion: a pane teardown and
    // recreate on every eye click would flicker.
    const companionId = accelCompanionId(name);
    const cPane = paneIdOf(companionId);
    if (cPane)
      c.overrideIndicator(
        {
          name: companionId,
          extendData: { ...ext, indType: "SLOPE_ACCEL" },
          visible: next && isVisibleOnResolution(vis, period.resolution),
        },
        cPane,
      );
```

Import `accelCompanionId` from `../lib/indicators`.

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Verify in the browser**

With an accel pane showing:
1. Click the Slope's legend eye: both the Slope curve and the accel pane hide.
2. Click it again: both return.
3. Toggle the sidebar's master "Hide indicators" switch: both hide, then both return.

- [ ] **Step 4: Run the full suite**

Run: `cd frontend && npx vitest run && npx tsc --noEmit`
Expected: all PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/chart/useIndicatorCommands.ts
git commit -m "fix(slope): accel pane follows its parent's visibility"
```

---

## Definition of done

- Toggling "Show acceleration pane" on a Slope adds/removes a linked pane directly below it.
- The accel pane survives reload, pane reorder, and timeframe switches, and is never in the saved instance list.
- Hiding or removing the Slope hides or removes the accel pane.
- "MA Accel {len}" is pickable in backtest/live rules, matches the plotted line, and warms up correctly.
- On a higher timeframe, accel is computed on native HTF bars and aligned (no zero-inside-bucket staircase).
- `cd frontend && npx vitest run && npx tsc --noEmit` is clean.
