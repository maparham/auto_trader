# Chart Operand Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the chart-initiated "Copy to rule" clipboard flow with a strategy-side `ChartOperandPicker` that lists the focused cell's on-chart indicators/drawings — one sub-item per active output line — fixing the "no paste target in an empty group" bug and the multi-output (line:0-only) limitation.

**Architecture:** UI-layer swap only. The `Operand` data model (`kind:"series"`, `recipe`, `recipeKey`, `@tf`/`~len` key contract), `computeSeriesRecipe`/`LINE_KEYS`, `buildSeries`, and the backend series operand are all unchanged. We add pure helpers (`indicatorOutputs`, `chartOperandSources`, `swapSides`, `ruleFromChartOperand`) + a presentational `ChartOperandPicker`, wire two entry points (per-operand `+`, group-level `+ Rule from chart`) plus a per-rule `⇄` swap-sides button, and delete the old clipboard path outright (no-legacy).

**Tech Stack:** React + TypeScript (Vite), a lightweight `Signal` pattern, klinecharts, vitest (+ `@testing-library/react`, jsdom) for unit/component tests, Playwright for e2e. Shared `Tooltip`/`InfoTip` components. CSS in `frontend/src/App.css`.

## Global Constraints

- **No-legacy:** delete the old copy/paste path outright; no deprecation shims, no data migration (the `Operand`/`recipe` wire format is unchanged so saved presets keep working). (Repo convention.)
- **Tooltips:** use the shared `Tooltip` (`frontend/src/components/Tooltip.tsx`) / `InfoTip`, never native `title=` in NEW code. (CLAUDE.md.)
- **Correctness invariant — never list an output the compute can't resolve.** `indicatorOutputs()` must mirror `computeIndicatorRecipe` (`backtestSeries.ts`) exactly: VWAP/AVWAP resolve **line 0 only** (the compute maps `p.vwap` regardless of `line`), so they are single-output even though the chart draws bands; LR/PREV_HL resolve by `pickLine` index; EMA/MA resolve `base` (0) / `smoothing` (1).
- **Compute gates for "active" (from the instance's RAW `extendData`, which still carries render-state keys):**
  - EMA/MA smoothing (line 1) active iff `extendData.smoothing?.type !== "none" && extendData.smoothing?.length > 0`.
  - LR line active iff `!extendData.lineHidden?.[key]` for key in `["lr","up","dn"]`.
  - PREV_HL line active iff `!extendData.lineHidden?.[key]`; the `anchorHigh`/`anchorLow` lines additionally require `Number(extendData.anchorTs) > 0`.
- **Label composition:** single-output → base label only (`recipeLabel(recipe)`, e.g. `EMA(200)`). Multi-output → each sub-item is `base` (unsuffixed) or `${baseLabel}: ${outputLabel}` (e.g. `Prev H/L: Day High`, `LR(100, 2): Upper`). Never emit a doubled label like `EMA(9): EMA(9)`.
- All verification runs from `frontend/`: `npm run test:unit` (vitest), `npx tsc -b` / `npm run build` (types). Baseline before this work: vitest green, ~23 pre-existing tsc errors (do not introduce new ones).

---

## File Structure

- `frontend/src/lib/chartOperand.ts` — **modify.** Add `indicatorOutputs()`, the `ChartOperandSource`/`OutputChoice`/`RawChartSource` types, and the pure `chartOperandSources(raw)` builder. Keep all existing exports.
- `frontend/src/lib/backtestSeries.ts` — **modify.** Export `LINE_KEYS` (currently module-private) so `chartOperand.ts` reuses the same line-index ordering.
- `frontend/src/lib/backtestConfig.ts` — **modify.** Add `OP_REVERSE`, `swapSides(rule)`, `ruleFromChartOperand(op)` (pure, near `Rule`).
- `frontend/src/lib/overlays.ts` — **modify.** Add public `listDrawings()` to `OverlayManager` (enumerate straight-line drawings by id/name/points).
- `frontend/src/lib/chartOperandEnumerate.ts` — **create.** `enumerateChartOperands(controller)`: the impure glue reading `controller.chart.getIndicatorByPaneId()` + `controller.overlays.listDrawings()` → `ChartOperandSource[]`.
- `frontend/src/ChartOperandPicker.tsx` — **create.** Presentational modal: `{ sources, onPick, onClose }`. No controller/chart knowledge.
- `frontend/src/BacktestSettingsModal.tsx` — **modify.** Own picker open-state; thread `openChartPicker` through `SidePanel` → `RuleGroupSection` → `OperandPicker`; per-operand `+`, group-level `+ Rule from chart`, per-rule `⇄`; delete `useRuleClipboard`/`pasteFromChart`/⧉; import `OP_REVERSE` from `backtestConfig`.
- `frontend/src/ChartCore.tsx` — **modify.** Delete `indicatorCopyToRuleItem` + its menu entry + now-unused imports.
- `frontend/src/Toolbar.tsx` — **modify.** Delete `copyDrawingToRule` + both "Copy to rule" menu entries + now-unused imports.
- `frontend/src/lib/signals.ts` — **modify.** Delete `ruleClipboard` + `RuleClipboardEntry`.
- `frontend/src/App.css` — **modify.** Styles for `.bt-operand-add`, `.bt-swap-sides`, and the picker (`.chart-operand-picker*`).
- Tests: `frontend/src/lib/chartOperand.test.ts`, `frontend/src/lib/backtestSeries.test.ts`, `frontend/src/lib/backtestConfig.test.ts` (**modify**); `frontend/src/ChartOperandPicker.test.tsx` (**create**).

**Interfaces produced (used across tasks — exact shapes):**

```ts
// chartOperand.ts
export interface OutputChoice { lineIndex: number; label: string; base?: boolean }
export function indicatorOutputs(indType: string, extendData: unknown, calcParams: number[]): OutputChoice[];

export type RawChartSource =
  | { kind: "indicator"; id: string; indType: string; calcParams: number[]; extendData: unknown }
  | { kind: "drawing"; id: string; name: string; points: Array<{ timestamp?: number; value?: number; dataIndex?: number }>; candles: import("klinecharts").KLineData[] };

export interface PickerOutput { lineIndex: number; label: string; base?: boolean; operand: import("./backtestConfig").Operand }
export interface ChartOperandSource { id: string; baseLabel: string; disabled?: boolean; disabledReason?: string; outputs: PickerOutput[] }
export function chartOperandSources(raw: RawChartSource): ChartOperandSource;

// backtestConfig.ts
export const OP_REVERSE: Record<Operator, Operator>;
export function swapSides(rule: Rule): Rule;
export function ruleFromChartOperand(op: Operand): Rule;

// chartOperandEnumerate.ts
export function enumerateChartOperands(controller: import("./chartController").ChartController | null): ChartOperandSource[];

// overlays.ts (OverlayManager method)
listDrawings(): Array<{ id: string; name: string; points: Array<{ timestamp?: number; value?: number; dataIndex?: number }> }>;
```

---

### Task 1: Export `LINE_KEYS` + add `indicatorOutputs()`

**Files:**
- Modify: `frontend/src/lib/backtestSeries.ts:158` (`const LINE_KEYS` → `export const LINE_KEYS`)
- Modify: `frontend/src/lib/chartOperand.ts` (add import of `LINE_KEYS` + `PREV_HL_PERIODS`, add `OutputChoice` + `indicatorOutputs`)
- Test: `frontend/src/lib/chartOperand.test.ts`

**Interfaces:**
- Consumes: `LINE_KEYS` (`backtestSeries.ts`), `PREV_HL_PERIODS` (`frontend/src/lib/indicators/prevHl.ts`, shape `{ kind: "rolling"|"day"|"week"|"anchor"; hi: string; lo: string }`).
- Produces: `OutputChoice`, `indicatorOutputs(indType, extendData, calcParams): OutputChoice[]`.

- [ ] **Step 1: Write the failing tests** — append to `frontend/src/lib/chartOperand.test.ts`:

```ts
import { indicatorOutputs } from "./chartOperand";

describe("indicatorOutputs", () => {
  it("EMA/MA: base only, plus Smoothing when the smoothing MA is enabled", () => {
    expect(indicatorOutputs("EMA", {}, [9])).toEqual([{ lineIndex: 0, label: "Value", base: true }]);
    expect(indicatorOutputs("EMA", { smoothing: { type: "none", length: 9 } }, [9])).toEqual([
      { lineIndex: 0, label: "Value", base: true },
    ]);
    expect(indicatorOutputs("MA", { smoothing: { type: "ema", length: 5 } }, [20])).toEqual([
      { lineIndex: 0, label: "Value", base: true },
      { lineIndex: 1, label: "Smoothing" },
    ]);
  });

  it("LR: regression + bands, gated by lineHidden (index matches LINE_KEYS.LR)", () => {
    expect(indicatorOutputs("LR", {}, [100, 2])).toEqual([
      { lineIndex: 0, label: "Regression", base: true },
      { lineIndex: 1, label: "Upper" },
      { lineIndex: 2, label: "Lower" },
    ]);
    expect(indicatorOutputs("LR", { lineHidden: { up: true, dn: true } }, [100, 2])).toEqual([
      { lineIndex: 0, label: "Regression", base: true },
    ]);
    // All hidden -> fall back to the primary so the row stays pickable.
    expect(indicatorOutputs("LR", { lineHidden: { lr: true, up: true, dn: true } }, [100, 2])).toEqual([
      { lineIndex: 0, label: "Regression", base: true },
    ]);
  });

  it("PREV_HL: active boundary lines only; anchor needs a placed anchorTs", () => {
    // Default (nothing hidden, no anchor) -> rolling+day+week highs & lows, no anchor.
    expect(indicatorOutputs("PREV_HL", {}, [])).toEqual([
      { lineIndex: 0, label: "Rolling High" },
      { lineIndex: 1, label: "Rolling Low" },
      { lineIndex: 2, label: "Day High" },
      { lineIndex: 3, label: "Day Low" },
      { lineIndex: 4, label: "Week High" },
      { lineIndex: 5, label: "Week Low" },
    ]);
    // Only day & week visible.
    expect(
      indicatorOutputs("PREV_HL", { lineHidden: { rollingHigh: true, rollingLow: true } }, []),
    ).toEqual([
      { lineIndex: 2, label: "Day High" },
      { lineIndex: 3, label: "Day Low" },
      { lineIndex: 4, label: "Week High" },
      { lineIndex: 5, label: "Week Low" },
    ]);
    // A placed anchor exposes anchor high/low (indices 6/7).
    const withAnchor = indicatorOutputs("PREV_HL", { anchorTs: 1700000000000 }, []);
    expect(withAnchor).toContainEqual({ lineIndex: 6, label: "Anchor High" });
    expect(withAnchor).toContainEqual({ lineIndex: 7, label: "Anchor Low" });
  });

  it("RSI/VWAP/AVWAP: single output (matches computeIndicatorRecipe resolving line 0 only)", () => {
    expect(indicatorOutputs("RSI", {}, [14])).toEqual([{ lineIndex: 0, label: "Value", base: true }]);
    expect(indicatorOutputs("VWAP", {}, [])).toEqual([{ lineIndex: 0, label: "Value", base: true }]);
    expect(indicatorOutputs("AVWAP", { bands: [{ on: true }] }, [120000])).toEqual([
      { lineIndex: 0, label: "Value", base: true },
    ]);
  });

  it("unsupported types return []", () => {
    expect(indicatorOutputs("MACD", {}, [12, 26, 9])).toEqual([]);
    expect(indicatorOutputs("SESSIONS", {}, [])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/lib/chartOperand.test.ts -t indicatorOutputs`
Expected: FAIL — `indicatorOutputs is not a function`.

- [ ] **Step 3: Export `LINE_KEYS`** — in `frontend/src/lib/backtestSeries.ts:158` change:

```ts
export const LINE_KEYS: Record<string, readonly string[]> = {
```

- [ ] **Step 4: Implement `indicatorOutputs`** — in `frontend/src/lib/chartOperand.ts`, add imports at the top (after the existing imports):

```ts
import { LINE_KEYS } from "./backtestSeries";
import { PREV_HL_PERIODS } from "./indicators/prevHl";
```

Then add the export (place it after `recipeLabel`):

```ts
/** One selectable output line of an indicator instance. `base` marks the primary
 * line whose chip label carries NO output suffix (kept unsuffixed to avoid
 * doubling, e.g. "EMA(9)" rather than "EMA(9): Value"). */
export interface OutputChoice {
  lineIndex: number;
  label: string;
  base?: boolean;
}

// Human labels for the PREV_HL boundary lines, by output key.
const PREV_HL_LABELS: Record<string, string> = {
  rollingHigh: "Rolling High", rollingLow: "Rolling Low",
  dayHigh: "Day High", dayLow: "Day Low",
  weekHigh: "Week High", weekLow: "Week Low",
  anchorHigh: "Anchor High", anchorLow: "Anchor Low",
};

/** The instance's ACTIVE output lines, mirroring exactly what computeIndicatorRecipe
 * (backtestSeries.ts) can resolve — so a picked line always reproduces a real curve.
 * `[]` for unsupported types. Reads the RAW extendData (which still carries the
 * render-state keys lineHidden/smoothing/anchorTs that the recipe snapshot strips). */
export function indicatorOutputs(indType: string, extendData: unknown, calcParams: number[]): OutputChoice[] {
  if (!isSupportedIndicatorType(indType)) return [];
  const ext = (extendData && typeof extendData === "object" ? extendData : {}) as Record<string, unknown>;
  switch (indType) {
    case "EMA":
    case "MA": {
      const sm = ext.smoothing as { type?: string; length?: number } | undefined;
      const out: OutputChoice[] = [{ lineIndex: 0, label: "Value", base: true }];
      if (sm && sm.type !== "none" && (sm.length ?? 0) > 0) out.push({ lineIndex: 1, label: "Smoothing" });
      return out;
    }
    case "LR": {
      const hidden = (ext.lineHidden ?? {}) as Record<string, boolean>;
      const keys = LINE_KEYS.LR; // ["lr","up","dn"]
      const labels: Record<string, string> = { lr: "Regression", up: "Upper", dn: "Lower" };
      const out: OutputChoice[] = [];
      keys.forEach((k, i) => {
        if (!hidden[k]) out.push(i === 0 ? { lineIndex: 0, label: labels.lr, base: true } : { lineIndex: i, label: labels[k] });
      });
      return out.length ? out : [{ lineIndex: 0, label: labels.lr, base: true }];
    }
    case "PREV_HL": {
      const hidden = (ext.lineHidden ?? {}) as Record<string, boolean>;
      const anchorTs = Number(ext.anchorTs) || 0;
      const keys = LINE_KEYS.PREV_HL;
      const out: OutputChoice[] = [];
      for (const b of PREV_HL_PERIODS) {
        if (b.kind === "anchor" && anchorTs <= 0) continue;
        for (const key of [b.hi, b.lo]) {
          if (hidden[key]) continue;
          out.push({ lineIndex: keys.indexOf(key), label: PREV_HL_LABELS[key] });
        }
      }
      return out;
    }
    // RSI/VWAP/AVWAP resolve only line 0 in computeIndicatorRecipe.
    case "RSI":
    case "VWAP":
    case "AVWAP":
      return [{ lineIndex: 0, label: "Value", base: true }];
    default:
      return [];
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/lib/chartOperand.test.ts`
Expected: PASS (existing chartOperand tests + the new `indicatorOutputs` block).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/backtestSeries.ts frontend/src/lib/chartOperand.ts frontend/src/lib/chartOperand.test.ts
git commit -m "feat(rules): indicatorOutputs() enumerates an instance's active output lines"
```

---

### Task 2: Pure `chartOperandSources()` builder + label composition

**Files:**
- Modify: `frontend/src/lib/chartOperand.ts` (add `RawChartSource`, `PickerOutput`, `ChartOperandSource`, `chartOperandSources`)
- Test: `frontend/src/lib/chartOperand.test.ts` and `frontend/src/lib/backtestSeries.test.ts`

**Interfaces:**
- Consumes: `indicatorToRecipe`, `drawingToRecipe`, `recipeLabel`, `indicatorOutputs`, `indicatorCopyDisabledReason`, `drawingCopyDisabledReason`, `isSupportedIndicatorType`, `isSupportedDrawingName` (all `chartOperand.ts`); `recipeKey` (`backtestConfig.ts`).
- Produces: `RawChartSource`, `PickerOutput`, `ChartOperandSource`, `chartOperandSources(raw): ChartOperandSource`.

- [ ] **Step 1: Write the failing tests** — append to `frontend/src/lib/chartOperand.test.ts`:

```ts
import { chartOperandSources } from "./chartOperand";

describe("chartOperandSources", () => {
  it("single-output indicator: one output, chip label = base label, no suffix", () => {
    const s = chartOperandSources({ kind: "indicator", id: "EMA#1", indType: "EMA", calcParams: [200], extendData: {} });
    expect(s.baseLabel).toBe("EMA(200)");
    expect(s.disabled).toBeFalsy();
    expect(s.outputs).toHaveLength(1);
    expect(s.outputs[0].operand).toMatchObject({ kind: "series", label: "EMA(200)" });
    expect(s.outputs[0].operand.recipe).toMatchObject({ source: "indicator", indicatorType: "EMA", line: 0 });
  });

  it("multi-output indicator: base unsuffixed, siblings suffixed; distinct recipe.line + seriesKey", () => {
    const s = chartOperandSources({
      kind: "indicator", id: "LR#1", indType: "LR", calcParams: [100, 2], extendData: {},
    });
    expect(s.outputs.map((o) => o.operand.label)).toEqual(["LR(100, 2)", "LR(100, 2): Upper", "LR(100, 2): Lower"]);
    expect(s.outputs.map((o) => o.operand.recipe.source === "indicator" && o.operand.recipe.line)).toEqual([0, 1, 2]);
    const keys = s.outputs.map((o) => o.operand.seriesKey);
    expect(new Set(keys).size).toBe(3); // distinct outputs => distinct series
  });

  it("PREV_HL sub-item labels read 'Prev H/L: Day High' etc.", () => {
    const s = chartOperandSources({ kind: "indicator", id: "PH#1", indType: "PREV_HL", calcParams: [], extendData: {} });
    expect(s.outputs.map((o) => o.operand.label)).toContain("Prev H/L: Day High");
  });

  it("carries the instance MTF timeframe onto the operand", () => {
    const s = chartOperandSources({ kind: "indicator", id: "EMA#2", indType: "EMA", calcParams: [9], extendData: { mtf: { timeframe: "HOUR" } } });
    expect(s.outputs[0].operand).toMatchObject({ timeframe: "HOUR" });
  });

  it("unsupported indicator: disabled + reason, no outputs", () => {
    const s = chartOperandSources({ kind: "indicator", id: "MACD#1", indType: "MACD", calcParams: [12, 26, 9], extendData: {} });
    expect(s.disabled).toBe(true);
    expect(s.disabledReason).toBe("MACD isn't supported in rules yet");
    expect(s.outputs).toEqual([]);
  });

  it("drawing: single output, label via recipeLabel", () => {
    const candles = Array.from({ length: 3 }, (_, i) => ({ timestamp: i * 60000, open: 1, high: 1, low: 1, close: 1, volume: 0 }));
    const s = chartOperandSources({
      kind: "drawing", id: "d1", name: "segment",
      points: [{ timestamp: 0, value: 1 }, { timestamp: 120000, value: 2 }], candles,
    });
    expect(s.baseLabel).toBe("Trendline");
    expect(s.outputs).toHaveLength(1);
    expect(s.outputs[0].operand.recipe).toMatchObject({ source: "drawing", drawingKind: "segment" });
  });

  it("unsupported drawing: disabled + reason", () => {
    const s = chartOperandSources({ kind: "drawing", id: "d2", name: "fibonacciLine", points: [], candles: [] });
    expect(s.disabled).toBe(true);
    expect(s.disabledReason).toBe("Fibonacci tools aren't supported in rules yet");
  });
});
```

Also append the end-to-end line-resolution test to `frontend/src/lib/backtestSeries.test.ts` (inside the existing `describe("series operand — indicator recipes match the chart template")` block, reusing the file's `seriesFor`/`candles`/`computeLr`/`nul` helpers):

```ts
  it("a picker-built LR 'Upper' operand (line 1) resolves to computeLr().up end-to-end", async () => {
    const { chartOperandSources } = await import("./chartOperand");
    const bars = candles([1, 3, 2, 4, 6, 5, 7, 9, 8, 10]);
    const src = chartOperandSources({ kind: "indicator", id: "LR#x", indType: "LR", calcParams: [5, 2], extendData: {} });
    const upper = src.outputs.find((o) => o.operand.label.endsWith("Upper"))!;
    const recipe = (upper.operand as Extract<Operand, { kind: "series" }>).recipe;
    const got = await seriesFor(recipe, bars);
    expect(got).toEqual(nul(computeLr(bars, 5, 2, {}).map((p) => (p as Record<string, number | undefined>).up)));
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/lib/chartOperand.test.ts -t chartOperandSources`
Expected: FAIL — `chartOperandSources is not a function`.

- [ ] **Step 3: Implement `chartOperandSources`** — in `frontend/src/lib/chartOperand.ts`, add the `recipeKey` import (extend the existing `backtestConfig` import) and the types + builder:

```ts
import { recipeKey, type Operand } from "./backtestConfig";

export type RawChartSource =
  | { kind: "indicator"; id: string; indType: string; calcParams: number[]; extendData: unknown }
  | { kind: "drawing"; id: string; name: string; points: Array<{ timestamp?: number; value?: number; dataIndex?: number }>; candles: KLineData[] };

export interface PickerOutput extends OutputChoice { operand: Operand }
export interface ChartOperandSource {
  id: string;
  baseLabel: string;
  disabled?: boolean;
  disabledReason?: string;
  outputs: PickerOutput[];
}

/** Turn one on-chart instance/drawing into a picker row with a ready-built operand
 * per active output. Pure — all chart access happens in enumerateChartOperands. */
export function chartOperandSources(raw: RawChartSource): ChartOperandSource {
  if (raw.kind === "drawing") {
    if (!isSupportedDrawingName(raw.name)) {
      return { id: raw.id, baseLabel: raw.name, disabled: true, disabledReason: drawingCopyDisabledReason(raw.name), outputs: [] };
    }
    const recipe = drawingToRecipe(raw.name, raw.points, raw.candles);
    if (!recipe) {
      return { id: raw.id, baseLabel: raw.name, disabled: true, disabledReason: "This drawing has no anchors yet", outputs: [] };
    }
    const label = recipeLabel(recipe);
    const operand: Operand = { kind: "series", seriesKey: recipeKey(recipe), label, recipe };
    return { id: raw.id, baseLabel: label, outputs: [{ lineIndex: 0, label, base: true, operand }] };
  }
  if (!isSupportedIndicatorType(raw.indType)) {
    return { id: raw.id, baseLabel: raw.indType, disabled: true, disabledReason: indicatorCopyDisabledReason(raw.indType), outputs: [] };
  }
  const outputs = indicatorOutputs(raw.indType, raw.extendData, raw.calcParams);
  // baseLabel comes from a line-0 recipe (recipeLabel ignores `line`).
  const built0 = indicatorToRecipe(raw.indType, raw.calcParams, raw.extendData, 0);
  const baseLabel = built0 ? recipeLabel(built0.recipe) : raw.indType;
  const rows: PickerOutput[] = [];
  for (const o of outputs) {
    const built = indicatorToRecipe(raw.indType, raw.calcParams, raw.extendData, o.lineIndex);
    if (!built) continue;
    const label = o.base ? baseLabel : `${baseLabel}: ${o.label}`;
    const operand: Operand = {
      kind: "series", seriesKey: recipeKey(built.recipe), label, recipe: built.recipe,
      ...(built.timeframe ? { timeframe: built.timeframe } : {}),
    };
    rows.push({ ...o, operand });
  }
  return { id: raw.id, baseLabel, outputs: rows };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend && npx vitest run src/lib/chartOperand.test.ts src/lib/backtestSeries.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/chartOperand.ts frontend/src/lib/chartOperand.test.ts frontend/src/lib/backtestSeries.test.ts
git commit -m "feat(rules): chartOperandSources() builds picker rows + operands from a chart instance"
```

---

### Task 3: `OverlayManager.listDrawings()` + `enumerateChartOperands()`

**Files:**
- Modify: `frontend/src/lib/overlays.ts` (add public `listDrawings()` to `OverlayManager`, near the existing `getDrawing`)
- Create: `frontend/src/lib/chartOperandEnumerate.ts`
- Test: `frontend/src/lib/chartOperandEnumerate.test.ts` (create)

**Interfaces:**
- Consumes: `ChartController` (`chartController.ts`) — `controller.chart?.getIndicatorByPaneId()` returns `Map<paneId, Map<name, Indicator>>` where each `Indicator` has `calcParams?`, `extendData?`; `controller.chart?.getDataList()` returns `KLineData[]`; `controller.overlays.listDrawings()`. `indTypeOf` (`frontend/src/lib/indicators/shared.ts`). `chartOperandSources` (Task 2).
- Produces: `enumerateChartOperands(controller): ChartOperandSource[]`; `OverlayManager.listDrawings()`.

- [ ] **Step 1: Add `listDrawings()` to `OverlayManager`** — in `frontend/src/lib/overlays.ts`, immediately after the `getDrawing(...)` method (~line 566), add:

```ts
  /** Every straight-line drawing on this cell as { id, name, points } — the source
   * for the chart-operand picker. Excludes alerts and transient overlays
   * (measure/rangeBand/slope). Points are by value; safe to snapshot. */
  listDrawings(): Array<{ id: string; name: string; points: Array<{ timestamp?: number; value?: number; dataIndex?: number }> }> {
    const out: Array<{ id: string; name: string; points: Array<{ timestamp?: number; value?: number; dataIndex?: number }> }> = [];
    if (!this.chart) return out;
    for (const [id, kind] of this.entries) {
      if (kind !== "drawing") continue;
      const ov = this.chart.getOverlayById(id);
      if (!ov) continue;
      out.push({ id, name: ov.name, points: ov.points });
    }
    return out;
  }
```

- [ ] **Step 2: Write the failing test** — create `frontend/src/lib/chartOperandEnumerate.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { enumerateChartOperands } from "./chartOperandEnumerate";

// Minimal duck-typed controller: only the fields enumerateChartOperands reads.
function fakeController(indicators: Array<[string, string, { calcParams?: number[]; extendData?: unknown }]>, drawings: Array<{ id: string; name: string; points: unknown[] }>) {
  const paneMap = new Map<string, Map<string, unknown>>();
  const inds = new Map<string, unknown>();
  for (const [name, indType, ind] of indicators) inds.set(name, { name, extendData: { indType }, ...ind });
  paneMap.set("pane_1", inds);
  return {
    chart: {
      getIndicatorByPaneId: () => paneMap,
      getDataList: () => [{ timestamp: 0, open: 1, high: 1, low: 1, close: 1, volume: 0 }],
    },
    overlays: { listDrawings: () => drawings },
  } as unknown as import("./chartController").ChartController;
}

describe("enumerateChartOperands", () => {
  it("returns [] for a null controller", () => {
    expect(enumerateChartOperands(null)).toEqual([]);
  });

  it("lists supported indicators (with outputs) and drawings, greys unsupported", () => {
    const c = fakeController(
      [
        ["EMA#1", "EMA", { calcParams: [200], extendData: { indType: "EMA" } }],
        ["MACD#1", "MACD", { calcParams: [12, 26, 9], extendData: { indType: "MACD" } }],
      ],
      [{ id: "d1", name: "segment", points: [{ timestamp: 0, value: 1 }, { timestamp: 60000, value: 2 }] }],
    );
    const sources = enumerateChartOperands(c);
    const ema = sources.find((s) => s.id === "EMA#1")!;
    expect(ema.baseLabel).toBe("EMA(200)");
    expect(ema.outputs).toHaveLength(1);
    expect(sources.find((s) => s.id === "MACD#1")!.disabled).toBe(true);
    expect(sources.find((s) => s.id === "d1")!.baseLabel).toBe("Trendline");
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd frontend && npx vitest run src/lib/chartOperandEnumerate.test.ts`
Expected: FAIL — cannot find module `./chartOperandEnumerate`.

- [ ] **Step 4: Implement** — create `frontend/src/lib/chartOperandEnumerate.ts`:

```ts
// Impure glue: read the focused cell's live on-chart indicators + drawings off its
// ChartController and turn each into a picker row (chartOperandSources). Kept thin
// and separate from the pure builder so the picker/tests never touch klinecharts.
import type { ChartController } from "./chartController";
import { indTypeOf } from "./indicators/shared";
import { chartOperandSources, type ChartOperandSource } from "./chartOperand";

export function enumerateChartOperands(controller: ChartController | null): ChartOperandSource[] {
  const chart = controller?.chart;
  if (!controller || !chart) return [];
  const out: ChartOperandSource[] = [];
  const panes = chart.getIndicatorByPaneId() as Map<string, Map<string, { name: string; calcParams?: unknown[]; extendData?: unknown }>> | null | undefined;
  if (panes) {
    for (const inds of panes.values()) {
      for (const [name, ind] of inds) {
        out.push(chartOperandSources({
          kind: "indicator",
          id: name,
          indType: indTypeOf(ind),
          calcParams: (ind.calcParams ?? []).map(Number),
          extendData: ind.extendData,
        }));
      }
    }
  }
  const candles = chart.getDataList();
  for (const d of controller.overlays.listDrawings()) {
    out.push(chartOperandSources({ kind: "drawing", id: d.id, name: d.name, points: d.points, candles }));
  }
  return out;
}
```

- [ ] **Step 5: Run to verify pass**

Run: `cd frontend && npx vitest run src/lib/chartOperandEnumerate.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/overlays.ts frontend/src/lib/chartOperandEnumerate.ts frontend/src/lib/chartOperandEnumerate.test.ts
git commit -m "feat(rules): enumerate on-chart indicators/drawings into picker rows"
```

---

### Task 4: `ChartOperandPicker` presentational modal

**Files:**
- Create: `frontend/src/ChartOperandPicker.tsx`
- Create: `frontend/src/ChartOperandPicker.test.tsx`
- Modify: `frontend/src/App.css` (picker styles)

**Interfaces:**
- Consumes: `ChartOperandSource`, `PickerOutput` (`chartOperand.ts`); `Operand` (`backtestConfig.ts`); shared `Tooltip`, `CloseButton`.
- Produces: `<ChartOperandPicker sources={ChartOperandSource[]} onPick={(op: Operand) => void} onClose={() => void} />`.

- [ ] **Step 1: Write the failing test** — create `frontend/src/ChartOperandPicker.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import ChartOperandPicker from "./ChartOperandPicker";
import type { ChartOperandSource } from "./lib/chartOperand";
import type { Operand } from "./lib/backtestConfig";

afterEach(cleanup);

const op = (label: string): Operand => ({ kind: "series", seriesKey: label, label, recipe: { source: "indicator", indicatorType: "EMA", calcParams: [9], line: 0 } });

const SOURCES: ChartOperandSource[] = [
  { id: "EMA#1", baseLabel: "EMA(9)", outputs: [{ lineIndex: 0, label: "EMA(9)", base: true, operand: op("EMA(9)") }] },
  { id: "PH#1", baseLabel: "Prev H/L", outputs: [
    { lineIndex: 2, label: "Day High", operand: op("Prev H/L: Day High") },
    { lineIndex: 3, label: "Day Low", operand: op("Prev H/L: Day Low") },
  ] },
  { id: "MACD#1", baseLabel: "MACD", disabled: true, disabledReason: "MACD isn't supported in rules yet", outputs: [] },
];

describe("ChartOperandPicker", () => {
  it("empty state when there are no sources", () => {
    render(<ChartOperandPicker sources={[]} onPick={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText(/No indicators on this chart/i)).toBeTruthy();
  });

  it("single-output row picks on click", () => {
    const onPick = vi.fn();
    render(<ChartOperandPicker sources={SOURCES} onPick={onPick} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "EMA(9)" }));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ label: "EMA(9)" }));
  });

  it("multi-output row expands then picks a sub-item", () => {
    const onPick = vi.fn();
    render(<ChartOperandPicker sources={SOURCES} onPick={onPick} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Prev H\/L/ }));
    fireEvent.click(screen.getByRole("button", { name: "Day High" }));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ label: "Prev H/L: Day High" }));
  });

  it("disabled source is not clickable and shows its reason", () => {
    const onPick = vi.fn();
    render(<ChartOperandPicker sources={SOURCES} onPick={onPick} onClose={vi.fn()} />);
    const row = screen.getByRole("button", { name: /MACD/ }) as HTMLButtonElement;
    expect(row.disabled).toBe(true);
    fireEvent.click(row);
    expect(onPick).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/ChartOperandPicker.test.tsx`
Expected: FAIL — cannot find module `./ChartOperandPicker`.

- [ ] **Step 3: Implement** — create `frontend/src/ChartOperandPicker.tsx`:

```tsx
import { useState } from "react";
import CloseButton from "./CloseButton";
import Tooltip from "./components/Tooltip";
import type { ChartOperandSource } from "./lib/chartOperand";
import type { Operand } from "./lib/backtestConfig";

/** Strategy-side picker: lists the focused cell's on-chart indicators/drawings,
 * one sub-item per active output line, and returns the chosen operand. Purely
 * presentational — the caller enumerates sources and handles the picked operand. */
export default function ChartOperandPicker({
  sources,
  onPick,
  onClose,
}: {
  sources: ChartOperandSource[];
  onPick: (op: Operand) => void;
  onClose: () => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <div className="chart-operand-picker-backdrop" onClick={onClose}>
      <div className="chart-operand-picker" onClick={(e) => e.stopPropagation()}>
        <div className="chart-operand-picker-head">
          <span>Add from chart</span>
          <CloseButton onClick={onClose} />
        </div>
        {sources.length === 0 ? (
          <div className="al-note chart-operand-picker-empty">
            No indicators on this chart — add one from the chart toolbar.
          </div>
        ) : (
          <ul className="chart-operand-picker-list">
            {sources.map((s) => {
              const multi = s.outputs.length > 1;
              if (s.disabled) {
                return (
                  <li key={s.id}>
                    <Tooltip content={s.disabledReason ?? "Not supported in rules yet"}>
                      <button type="button" className="chart-operand-row" disabled>
                        {s.baseLabel}
                      </button>
                    </Tooltip>
                  </li>
                );
              }
              if (!multi) {
                const only = s.outputs[0];
                return (
                  <li key={s.id}>
                    <button type="button" className="chart-operand-row" onClick={() => onPick(only.operand)}>
                      {s.baseLabel}
                    </button>
                  </li>
                );
              }
              const open = expanded === s.id;
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    className="chart-operand-row chart-operand-row-parent"
                    aria-expanded={open}
                    onClick={() => setExpanded(open ? null : s.id)}
                  >
                    <span className={`chart-operand-chevron${open ? " open" : ""}`}>▸</span>
                    {s.baseLabel}
                  </button>
                  {open && (
                    <ul className="chart-operand-sublist">
                      {s.outputs.map((o) => (
                        <li key={o.lineIndex}>
                          <button type="button" className="chart-operand-row chart-operand-sub" onClick={() => onPick(o.operand)}>
                            {o.label}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Add styles** — append to `frontend/src/App.css` (mirror the flat, no-shadow, light-first house style; reuse existing vars):

```css
/* Chart-operand picker (strategy-side "Add from chart"). */
.chart-operand-picker-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.15); z-index: 60; display: flex; align-items: center; justify-content: center; }
.chart-operand-picker { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; min-width: 260px; max-width: 340px; max-height: 70vh; display: flex; flex-direction: column; }
.chart-operand-picker-head { display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; border-bottom: 1px solid var(--border); font-weight: 600; }
.chart-operand-picker-empty { padding: 16px 12px; }
.chart-operand-picker-list, .chart-operand-sublist { list-style: none; margin: 0; padding: 4px; overflow-y: auto; }
.chart-operand-sublist { padding: 0 0 0 18px; }
.chart-operand-row { display: flex; align-items: center; gap: 6px; width: 100%; text-align: left; padding: 6px 8px; background: none; border: none; border-radius: 4px; cursor: pointer; color: var(--text); font: inherit; }
.chart-operand-row:hover:not(:disabled) { background: var(--hover); }
.chart-operand-row:disabled { color: var(--text-faint); cursor: not-allowed; }
.chart-operand-chevron { transition: transform 0.12s; font-size: 10px; }
.chart-operand-chevron.open { transform: rotate(90deg); }
```

- [ ] **Step 5: Run to verify pass**

Run: `cd frontend && npx vitest run src/ChartOperandPicker.test.tsx`
Expected: PASS (all 4 cases).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/ChartOperandPicker.tsx frontend/src/ChartOperandPicker.test.tsx frontend/src/App.css
git commit -m "feat(rules): ChartOperandPicker modal (list on-chart indicators/drawings by output)"
```

---

### Task 5: `swapSides` + `ruleFromChartOperand` + `OP_REVERSE` in backtestConfig

**Files:**
- Modify: `frontend/src/lib/backtestConfig.ts` (add `OP_REVERSE`, `swapSides`, `ruleFromChartOperand`)
- Test: `frontend/src/lib/backtestConfig.test.ts`

**Interfaces:**
- Consumes: `Operand`, `Operator`, `Rule` (`backtestConfig.ts`).
- Produces: `OP_REVERSE`, `swapSides(rule): Rule`, `ruleFromChartOperand(op): Rule`.

- [ ] **Step 1: Write the failing tests** — append to `frontend/src/lib/backtestConfig.test.ts`:

```ts
import { swapSides, ruleFromChartOperand, OP_REVERSE } from "./backtestConfig";
import type { Rule, Operand } from "./backtestConfig";

const series: Operand = { kind: "series", seriesKey: "k", label: "EMA(9)", recipe: { source: "indicator", indicatorType: "EMA", calcParams: [9], line: 0 } };

describe("swapSides", () => {
  it("A gt B -> B lt A (operands swapped, operator mirrored, truth preserved)", () => {
    const rule: Rule = { left: { kind: "price", field: "close" }, op: "gt", right: { kind: "const", value: 5 } };
    expect(swapSides(rule)).toEqual({ left: { kind: "const", value: 5 }, op: "lt", right: { kind: "price", field: "close" } });
  });
  it("crosses self-mirrors", () => {
    const rule: Rule = { left: series, op: "crosses", right: { kind: "const", value: 0 } };
    expect(swapSides(rule).op).toBe("crosses");
  });
  it("a full round-trip returns the original rule", () => {
    const rule: Rule = { left: series, op: "crossesAbove", right: { kind: "const", value: 1 }, enabled: false, count: 3 };
    expect(swapSides(swapSides(rule))).toEqual(rule);
  });
  it("OP_REVERSE is a complete involution", () => {
    for (const [k, v] of Object.entries(OP_REVERSE)) expect(OP_REVERSE[v]).toBe(k);
  });
});

describe("ruleFromChartOperand", () => {
  it("seeds { left: series, op: gt, right: const 0 }", () => {
    expect(ruleFromChartOperand(series)).toEqual({ left: series, op: "gt", right: { kind: "const", value: 0 } });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/lib/backtestConfig.test.ts -t swapSides`
Expected: FAIL — `swapSides is not a function`.

- [ ] **Step 3: Implement** — in `frontend/src/lib/backtestConfig.ts`, add after the `Rule` interface (~line 146):

```ts
/** Each operator's mirror, so swapping a rule's two operands preserves its truth:
 * gt↔lt, gte↔lte, crossesAbove↔crossesBelow; `crosses` (direction-agnostic) is its
 * own mirror. Single source of truth (BacktestSettingsModal's "reverse all" reuses it). */
export const OP_REVERSE: Record<Operator, Operator> = {
  crossesAbove: "crossesBelow",
  crossesBelow: "crossesAbove",
  crosses: "crosses",
  gt: "lt",
  lt: "gt",
  gte: "lte",
  lte: "gte",
};

/** Swap a rule's two operands AND flip the operator, so `A > B` becomes the
 * equivalent `B < A` (same truth value). enabled/count are preserved. */
export function swapSides(rule: Rule): Rule {
  return { ...rule, left: rule.right, right: rule.left, op: OP_REVERSE[rule.op] };
}

/** A new rule seeded from a chart operand: `<operand> > 0`, ready to edit. Used by
 * the group-level "+ Rule from chart" entry so an empty group needs no pre-step. */
export function ruleFromChartOperand(op: Operand): Rule {
  return { left: op, op: "gt", right: { kind: "const", value: 0 } };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend && npx vitest run src/lib/backtestConfig.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/backtestConfig.ts frontend/src/lib/backtestConfig.test.ts
git commit -m "feat(rules): swapSides + ruleFromChartOperand + shared OP_REVERSE"
```

---

### Task 6: Wire the picker into the rule builder (entry points + removals in the modal)

**Files:**
- Modify: `frontend/src/BacktestSettingsModal.tsx`

**Interfaces:**
- Consumes: `enumerateChartOperands` (`chartOperandEnumerate.ts`), `ChartOperandPicker` (default import), `swapSides`, `ruleFromChartOperand`, `OP_REVERSE` (`backtestConfig.ts`), the existing `controller: ChartController | null` prop.
- Produces: threaded `openChartPicker: (onPick: (op: Operand) => void) => void` through `SidePanel` → `RuleGroupSection` → `OperandPicker`.

- [ ] **Step 1: Add imports** — top of `frontend/src/BacktestSettingsModal.tsx`:
  - Add `import ChartOperandPicker from "./ChartOperandPicker";`
  - Add `import { enumerateChartOperands } from "./lib/chartOperandEnumerate";`
  - In the `./lib/backtestConfig` import add `swapSides, ruleFromChartOperand, OP_REVERSE`.
  - In the `./lib/signals` import, remove `ruleClipboard` and `type RuleClipboardEntry` (leave `requestGoLive, requestConfirm, backtestClearRequest`). `recipeKey` may no longer be needed in this file (the picker builds operands) — remove it from the `./lib/backtestConfig` import if `tsc` flags it unused.

- [ ] **Step 2: Delete the local `OP_REVERSE`** — remove the `const OP_REVERSE: Record<Operator, Operator> = {…}` block at lines 194–202 (now imported). `reverseAll` (line 1595) keeps working via the import.

- [ ] **Step 3: Own picker state in the modal** — inside `BacktestSettingsModal(...)`, add near the other `useState` hooks:

```tsx
  // The chart-operand picker is modal-owned (opened from deep in the rule builder
  // via a threaded callback). `pickerFor` holds the pick handler; non-null = open.
  const [pickerFor, setPickerFor] = useState<((op: Operand) => void) | null>(null);
  const openChartPicker = (onPick: (op: Operand) => void) => setPickerFor(() => onPick);
  const pickerSources = useMemo(() => (pickerFor ? enumerateChartOperands(controller) : []), [pickerFor, controller]);
```

Ensure `useMemo` is imported from `react`.

- [ ] **Step 4: Render the picker** — just before the closing tag of the modal's root return (alongside where other overlays/portals render), add:

```tsx
      {pickerFor && (
        <ChartOperandPicker
          sources={pickerSources}
          onPick={(op) => { pickerFor(op); setPickerFor(null); }}
          onClose={() => setPickerFor(null)}
        />
      )}
```

- [ ] **Step 5: Thread `openChartPicker` through `SidePanel`** — add `openChartPicker` to `SidePanel`'s props (type `(onPick: (op: Operand) => void) => void`), pass it to both `<RuleGroupSection … openChartPicker={openChartPicker} />` (lines ~1269 and ~1282), and at `SidePanel`'s render site pass `openChartPicker={openChartPicker}`.

- [ ] **Step 6: Thread through `RuleGroupSection`** — add `openChartPicker` to its props, pass to each `<OperandPicker … openChartPicker={openChartPicker} />` (lines ~1686 and ~1688).

- [ ] **Step 7: Per-operand `+` (replace ⧉) in `OperandPicker`** — add `openChartPicker` to `OperandPicker`'s props. Delete the clipboard bits: `const clip = useRuleClipboard();` (line 1817), the `pasteFromChart` function (1818–1829), and the `{clip && ( … ⧉ … )}` block (1973–1984). In the non-series branch (right before the closing `</>` at line 1985), add:

```tsx
      <Tooltip content="Add a chart indicator or drawing as this operand">
        <button
          type="button"
          className="bt-operand-add"
          onClick={() => openChartPicker((op) => onChange(prevSlope ? { ...op, slope: prevSlope } : op))}
          aria-label="Add from chart"
        >
          +
        </button>
      </Tooltip>
```

- [ ] **Step 8: Delete `useRuleClipboard`** — remove the hook definition (lines 1781–1787). Remove any remaining `RuleClipboardEntry` reference.

- [ ] **Step 9: Group-level `+ Rule from chart`** — in `RuleGroupSection`, in the footer (`.bt-rule-foot`, after the `+ Add rule` button, ~line 1721) add:

```tsx
        <button
          className="ghost"
          onClick={() => openChartPicker((op) => onChange({ ...group, rules: [...group.rules, ruleFromChartOperand(op)] }))}
          title="Add a rule seeded from a chart indicator or drawing"
        >
          + Rule from chart
        </button>
```

And surface the same affordance in the empty-state area — replace the plain empty hint at line 1644 (`{group.rules.length === 0 && <div className="al-note bt-empty-rules">{emptyHint}</div>}`) with:

```tsx
        {group.rules.length === 0 && (
          <div className="al-note bt-empty-rules">
            {emptyHint}
            <div className="bt-empty-actions">
              <button
                className="ghost"
                onClick={() => openChartPicker((op) => onChange({ ...group, rules: [ruleFromChartOperand(op)] }))}
              >
                + Rule from chart
              </button>
            </div>
          </div>
        )}
```

- [ ] **Step 10: Per-rule `⇄` swap-sides** — in the `.bt-rule-actions` cluster (after the eye button, before the trash button, ~line 1697) add:

```tsx
      <Tooltip content="Swap sides (same condition)">
        <button
          type="button"
          className="bt-rule-toggle bt-swap-sides"
          onClick={() => setRule(i, swapSides(rule))}
          aria-label="Swap sides"
        >
          ⇄
        </button>
      </Tooltip>
```

- [ ] **Step 11: Styles** — append to `frontend/src/App.css`:

```css
/* Per-operand "add from chart" button (replaces the old ⧉ paste). */
.bt-operand-add { flex: 0 0 auto; width: 24px; height: 24px; padding: 0; min-width: 0; display: inline-flex; align-items: center; justify-content: center; font-size: 15px; line-height: 1; cursor: pointer; border: 1px solid var(--accent); border-radius: 4px; background: var(--surface); color: var(--accent); }
.bt-operand-add:hover { background: var(--accent); color: var(--accent-text); }
.bt-swap-sides { white-space: nowrap; }
.bt-empty-actions { margin-top: 6px; }
```

- [ ] **Step 12: Typecheck + run modal tests**

Run: `cd frontend && npx tsc -b 2>&1 | grep -E "BacktestSettingsModal|ChartOperandPicker|chartOperand" || echo "no new errors in touched files"`
Then: `cd frontend && npx vitest run src/BacktestSettingsModal.test.tsx`
Expected: no new type errors in the touched files; modal tests PASS (the existing rule-builder tests must stay green — they don't pass a `controller`, so the picker simply enumerates `[]`).

- [ ] **Step 13: Add a modal-level interaction test** — append to `frontend/src/BacktestSettingsModal.test.tsx` (uses the file's `openStrategy`/`groupSection` helpers; no controller, so the picker opens empty — this proves the empty-group entry point renders and opens without a pre-added rule, the reported bug):

```tsx
describe("chart-operand entry points", () => {
  it("an empty rule group offers '+ Rule from chart' and opens the picker", () => {
    renderModal();
    openStrategy();
    // Empty group: the entry point exists without adding a rule first.
    const btns = screen.getAllByRole("button", { name: "+ Rule from chart" });
    expect(btns.length).toBeGreaterThan(0);
    fireEvent.click(btns[0]);
    // No controller in the test harness -> picker shows its empty state.
    expect(screen.getByText(/No indicators on this chart/i)).toBeTruthy();
  });

  it("every operand shows an 'Add from chart' button", () => {
    renderModal();
    openStrategy();
    fireEvent.click(screen.getAllByRole("button", { name: "+ Add rule" })[0]);
    expect(screen.getAllByRole("button", { name: "Add from chart" }).length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 14: Run the new tests**

Run: `cd frontend && npx vitest run src/BacktestSettingsModal.test.tsx`
Expected: PASS.

- [ ] **Step 15: Commit**

```bash
git add frontend/src/BacktestSettingsModal.tsx frontend/src/BacktestSettingsModal.test.tsx frontend/src/App.css
git commit -m "feat(rules): strategy-side chart-operand picker entry points + swap-sides; drop ⧉ paste"
```

---

### Task 7: Delete the chart-side "Copy to rule" path + `ruleClipboard`

**Files:**
- Modify: `frontend/src/ChartCore.tsx`, `frontend/src/Toolbar.tsx`, `frontend/src/lib/signals.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: removal only. After this task no reference to `ruleClipboard`, `RuleClipboardEntry`, `indicatorCopyToRuleItem`, `copyDrawingToRule`, or the "Copy to rule" menu label remains.

- [ ] **Step 1: ChartCore** — delete the `indicatorCopyToRuleItem` `useCallback` (`ChartCore.tsx:4784-4813`) and its use in the indicator menu array (`ChartCore.tsx:4841` — the `indicatorCopyToRuleItem(paneId, name),` line). Remove now-unused imports from `./lib/chartOperand` (`isSupportedIndicatorType`, `indicatorCopyDisabledReason`, `indicatorToRecipe`, `recipeLabel`) and `ruleClipboard` from `./lib/signals` — but first grep the file; delete an import only if it has no other use.

- [ ] **Step 2: Toolbar** — delete `copyDrawingToRule` (`Toolbar.tsx:381-391`) and both "Copy to rule" branches in `drawMenuItems` (`Toolbar.tsx:417-419`, the `drawName && isSupportedDrawingName(...) ? {…"Copy to rule"…} : {…}` ternary — remove the whole ternary entry). Remove now-unused imports (`drawingToRecipe`, `recipeLabel`, `isSupportedDrawingName`, `drawingCopyDisabledReason`, `ruleClipboard`) — again only those with no remaining use.

- [ ] **Step 3: signals.ts** — delete the `RuleClipboardEntry` interface and `export const ruleClipboard = new Signal<…>(null);` (`signals.ts:70-83`), including the doc comment block above them.

- [ ] **Step 4: Verify nothing references the removed symbols**

Run: `cd frontend && grep -rn "ruleClipboard\|RuleClipboardEntry\|indicatorCopyToRuleItem\|copyDrawingToRule\|Copy to rule\|useRuleClipboard\|pasteFromChart" src && echo "STILL REFERENCED (fix above)" || echo "clean"`
Expected: `clean`.

- [ ] **Step 5: Typecheck**

Run: `cd frontend && npx tsc -b 2>&1 | grep -E "ChartCore|Toolbar|signals" || echo "no new errors in touched files"`
Expected: no new errors (unused-import errors here mean Step 1/2 missed an import — remove it).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/ChartCore.tsx frontend/src/Toolbar.tsx frontend/src/lib/signals.ts
git commit -m "refactor(rules): remove chart-side Copy-to-rule + ruleClipboard (superseded by picker)"
```

---

### Task 8: Full verification + optional e2e

**Files:**
- Optional create: `frontend/e2e/chart-operand-picker.spec.ts`

- [ ] **Step 1: Full unit suite**

Run: `cd frontend && npm run test:unit`
Expected: all green — the pre-existing series-operand tests (frontend compute) and every other suite pass unchanged, proving the data model and wire format are untouched.

- [ ] **Step 2: Backend suite unchanged** — the backend series operand (`rule.py`/`schemas.py`) was not touched; confirm it's still green:

Run: `cd backend && python -m pytest -q` (or the repo's usual pytest invocation)
Expected: green, same count as baseline.

- [ ] **Step 3: Typecheck / build**

Run: `cd frontend && npx tsc -b`
Expected: no NEW errors beyond the ~23 pre-existing baseline. If the count rose, fix the files you touched.

- [ ] **Step 4 (optional but recommended): e2e** — if time permits, add a Playwright spec that adds an EMA on the chart, opens Backtest → Strategy on an empty group, clicks `+ Rule from chart`, picks the EMA, and asserts a runnable rule row with an `EMA(...)` chip appears. Follow the existing `frontend/e2e/*.spec.ts` patterns (see `higher-timeframes.spec.ts` for chart+backtest setup). Run: `cd frontend && npx playwright test chart-operand-picker`.

- [ ] **Step 5: Commit any e2e**

```bash
git add frontend/e2e/chart-operand-picker.spec.ts
git commit -m "test(rules): e2e for the chart-operand picker empty-group flow"
```

---

## Post-implementation: history tidy (user-requested)

After all tasks are committed and green, squash the rule-related commits into one and reorder the unrelated ones out of the way (see conversation). **Prerequisite:** the working tree currently holds uncommitted, NON-rule work (equity-curve + trade-selection). Commit that as its own separate commit (or stash it) first so a rebase has a clean tree and that work is never swept into the rule squash. Rule-related commits to fold: the existing `3bb5c3a`/`4ea015a`/`27d27cf`/`3ae5f3d` + the two docs-spec commits + all Task 1–8 commits above. Keep `d7ded0a` (trade-nav) and `ddffdf5` (trade-selection spec) as their own commits, reordered where conflict-free.

---

## Self-Review

- **Spec coverage:** `ChartOperandPicker` (Task 4), `indicatorOutputs()` (Task 1), per-operand `+` and group-level `+ Rule from chart` (Task 6), swap-sides `⇄` (Tasks 5+6), removal of `ruleClipboard`/`useRuleClipboard`/⧉/`pasteFromChart`/both menu items (Tasks 6–7). Out-of-scope items (data model, compute, backend, drawing recipes) untouched — asserted green in Task 8. Every spec section maps to a task.
- **Resolved ambiguities:** "multi-output" = runtime `outputs.length > 1` (LR with bands hidden → single-click, no expand); label composition avoids doubling via the `base` flag (single source of truth in `chartOperandSources`); VWAP/AVWAP are single-output to match `computeIndicatorRecipe`.
- **Type consistency:** `OutputChoice`/`PickerOutput`/`ChartOperandSource`/`RawChartSource` defined in Task 1–2 and consumed verbatim in Tasks 3–4/6; `openChartPicker: (onPick: (op: Operand) => void) => void` threaded identically through `SidePanel`/`RuleGroupSection`/`OperandPicker`; `OP_REVERSE` moved to `backtestConfig` and re-imported by the modal (no duplicate definition).
