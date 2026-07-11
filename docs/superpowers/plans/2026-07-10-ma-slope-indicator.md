# MA Slope Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a sub-pane `SLOPE` indicator that plots the slope of a user-chosen EMA/SMA (units + slope period + timeframe selectable), and register it as a chart-operand type so the exact plotted line is pickable in backtest/live rules.

**Architecture:** One shared slope-math module (`indicators/slope.ts`) owns the MA→slope computation and a `slopeWithUnits()` / `inferBarHours()` pair. The chart visual (`calc` + two-color `draw`) and the rule-operand recipe path (`computeIndicatorRecipe`) both call that same module, so the plotted line and the rule value are identical by construction. MTF for the visual reuses the existing `mtfCoordinator` HTF-fetch machinery; MTF for rules is automatic via `buildChartOperandSeries` running the recipe on native HTF candles.

**Tech Stack:** TypeScript, React, klinecharts (custom indicators via `registerIndicator`), Vitest.

## Global Constraints

- Frontend only — **no backend changes**. `kind:"series"` operands fall through to the existing series-read in `rule.py`; the existing `series_name` D4 key check covers the new key.
- Parity contract: the recipe value for a SLOPE operand MUST equal the plotted sub-pane line. Enforce by calling ONE shared `slopeWithUnits()` from both paths; `barHours` from ONE shared `inferBarHours()` on whatever candle array each path holds (base bars for the visual/base rule; native HTF bars for an MTF operand).
- Units (`%/hr` | `%/bar` | `price/bar`) and MA type (`ema` | `sma`) live on `extendData` so they land inside the recipe's hashed portion (`recipeKey` = FNV-1a over the recipe) — a `%/bar` and a `%/hr` SLOPE on the same MA must NOT dedup to one `seriesKey`.
- Defaults: MA type EMA, MA length 9, slope period 3, units `%/hr`, source close, timeframe blank (chart TF).
- `SLOPE` is a sub-pane indicator (`IndicatorSeries.Normal`) — do NOT add it to `OVERLAY_INDICATORS`.
- Follow existing patterns: the closest analog for the settings/MTF wiring is `PIVOT_BANDS` (two calcParams + MTF via a coordinator apply-fn + a dedicated Timeframe block).

---

### Task 1: Shared slope math (`slopeWithUnits`, `inferBarHours`, `computeSlope`)

**Files:**
- Create: `frontend/src/lib/indicators/slope.ts`
- Test: `frontend/src/lib/indicators/slope.test.ts`

**Interfaces:**
- Produces:
  - `type SlopeUnit = "pctHr" | "pctBar" | "priceBar"`
  - `interface SlopeExtend extends MaExtend { maType?: "ema" | "sma"; units?: SlopeUnit }`
  - `interface SlopePoint { slope?: number }`
  - `inferBarHours(candles: KLineData[]): number` — hours-per-bar = (min positive adjacent timestamp delta in ms) / 3_600_000; falls back to 1 when < 2 bars or no positive delta.
  - `slopeWithUnits(raw: Array<number | undefined>, n: number, barHours: number, units: SlopeUnit): Array<number | undefined>`
  - `computeSlope(candles: KLineData[], maType: "ema" | "sma", maLen: number, n: number, units: SlopeUnit, ext: MaExtend, barHours: number): SlopePoint[]`

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/lib/indicators/slope.test.ts
import { describe, it, expect } from "vitest";
import type { KLineData } from "klinecharts";
import { inferBarHours, slopeWithUnits, computeSlope } from "./slope";

const bar = (t: number, c: number): KLineData =>
  ({ timestamp: t, open: c, high: c, low: c, close: c, volume: 1 }) as KLineData;

describe("inferBarHours", () => {
  it("returns hours from the smallest positive timestamp gap", () => {
    const c = [bar(0, 1), bar(300_000, 1), bar(900_000, 1)]; // 5-min min gap
    expect(inferBarHours(c)).toBeCloseTo(1 / 12, 10);
  });
  it("falls back to 1 for a single bar", () => {
    expect(inferBarHours([bar(0, 1)])).toBe(1);
  });
});

describe("slopeWithUnits", () => {
  const raw = [100, 101, 102, 103]; // +1 per bar off a 100 base
  it("pctBar = percent change per bar", () => {
    // (102-100)/100/2*100 = 1
    expect(slopeWithUnits(raw, 2, 1 / 12, "pctBar")[2]).toBeCloseTo(1, 10);
  });
  it("pctHr divides pctBar-run by elapsed hours", () => {
    // pctBar 1 over 2 bars * (1/12 h each) => 1 / (2 * 1/12) *? -> reuse formula
    // (102-100)/100/(2 * 1/12)*100 = 12
    expect(slopeWithUnits(raw, 2, 1 / 12, "pctHr")[2]).toBeCloseTo(12, 10);
  });
  it("priceBar = raw price change per bar", () => {
    // (102-100)/2 = 1
    expect(slopeWithUnits(raw, 2, 1 / 12, "priceBar")[2]).toBeCloseTo(1, 10);
  });
  it("undefined for the first n bars and where prev is 0", () => {
    expect(slopeWithUnits(raw, 2, 1, "pctBar")[1]).toBeUndefined();
    expect(slopeWithUnits([0, 1, 2], 1, 1, "pctBar")[1]).toBeUndefined(); // prev===0
  });
});

describe("computeSlope", () => {
  it("slopes the SMA of close over n bars", () => {
    const c = [bar(0, 10), bar(60_000, 12), bar(120_000, 14), bar(180_000, 16)];
    // sma length 1 = close itself; priceBar slope n=1 = adjacent diff = 2
    const pts = computeSlope(c, "sma", 1, 1, "priceBar", {}, 1);
    expect(pts[3].slope).toBeCloseTo(2, 10);
    expect(pts[0].slope).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/indicators/slope.test.ts`
Expected: FAIL — cannot find module `./slope`.

- [ ] **Step 3: Write minimal implementation**

```ts
// frontend/src/lib/indicators/slope.ts
// Slope of a TV-style EMA/SMA, plotted in its own sub-pane (green up / red down
// around a zero line). The SAME slopeWithUnits + inferBarHours + computeSlope are
// used by the chart visual (calc/draw below) AND the rule-operand recipe path
// (backtestSeries.computeIndicatorRecipe), so the plotted line and the rule value
// are identical by construction. Units live on extendData so they're part of the
// recipe hash (a %/bar and a %/hr slope on the same MA don't dedup).
import {
  IndicatorSeries,
  LineType,
  type Indicator,
  type IndicatorTemplate,
  type IndicatorDrawParams,
  type KLineData,
} from "klinecharts";
import { maSeries } from "../mtf";
import type { MaExtend } from "./ma";
import { fullLine } from "./shared";

export type SlopeUnit = "pctHr" | "pctBar" | "priceBar";

export interface SlopeExtend extends MaExtend {
  maType?: "ema" | "sma";
  units?: SlopeUnit;
}

export interface SlopePoint {
  slope?: number;
}

/** Hours per bar inferred from the smallest positive gap between adjacent bar
 * timestamps. Used identically by the visual and the rule path, so %/hr matches
 * by construction regardless of timeframe regularity. Falls back to 1 hour. */
export function inferBarHours(candles: KLineData[]): number {
  let minMs = Infinity;
  for (let i = 1; i < candles.length; i++) {
    const d = candles[i].timestamp - candles[i - 1].timestamp;
    if (d > 0 && d < minMs) minMs = d;
  }
  return Number.isFinite(minMs) ? minMs / 3_600_000 : 1;
}

/** Slope of `raw` over `n` bars in the chosen units. undefined for the first `n`
 * bars, where raw is undefined, or where the denominator is 0.
 *   pctBar   = (v − prev) / |prev| / n × 100
 *   pctHr    = (v − prev) / |prev| / (n × barHours) × 100   (matches slopeOf)
 *   priceBar = (v − prev) / n */
export function slopeWithUnits(
  raw: Array<number | undefined>,
  n: number,
  barHours: number,
  units: SlopeUnit,
): Array<number | undefined> {
  return raw.map((v, i) => {
    const prev = raw[i - n];
    if (i < n || v === undefined || prev === undefined) return undefined;
    if (units === "priceBar") return (v - prev) / n;
    if (prev === 0) return undefined;
    const denom = units === "pctHr" ? n * barHours : n;
    return ((v - prev) / Math.abs(prev) / denom) * 100;
  });
}

/** MA (via the shared maSeries, so it matches the real EMA/SMA) then its slope. */
export function computeSlope(
  candles: KLineData[],
  maType: "ema" | "sma",
  maLen: number,
  n: number,
  units: SlopeUnit,
  ext: MaExtend,
  barHours: number,
): SlopePoint[] {
  const { base } = maSeries(candles, maType, maLen, ext);
  return slopeWithUnits(base, n, barHours, units).map((s) => ({ slope: s ?? undefined }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/indicators/slope.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/indicators/slope.ts frontend/src/lib/indicators/slope.test.ts
git commit -m "feat(slope): shared MA-slope math (units + inferBarHours)"
```

---

### Task 2: SLOPE indicator template (calc + two-color/zero-line draw)

**Files:**
- Modify: `frontend/src/lib/indicators/slope.ts` (append the template + draw)
- Test: `frontend/src/lib/indicators/slope.test.ts` (add a calc-dispatch test)

**Interfaces:**
- Consumes: `computeSlope`, `inferBarHours`, `SlopeExtend` (Task 1).
- Produces: `export const SLOPE_TEMPLATE: Omit<IndicatorTemplate, "name">` with `shortName:"Slope"`, `series: IndicatorSeries.Normal`, `precision: 4`, `calcParams:[9, 3]`, `figures:[{key:"slope", title:"Slope: ", type:"line"}]`.

- [ ] **Step 1: Write the failing test**

```ts
// add to frontend/src/lib/indicators/slope.test.ts
import { SLOPE_TEMPLATE } from "./slope";
import { IndicatorSeries } from "klinecharts";

describe("SLOPE_TEMPLATE", () => {
  const bar = (t: number, c: number): KLineData =>
    ({ timestamp: t, open: c, high: c, low: c, close: c, volume: 1 }) as KLineData;
  it("is a sub-pane single-line indicator", () => {
    expect(SLOPE_TEMPLATE.series).toBe(IndicatorSeries.Normal);
    expect(SLOPE_TEMPLATE.figures?.[0]?.key).toBe("slope");
  });
  it("calc reads maType/units from extendData and slopes the MA", () => {
    const c = [bar(0, 10), bar(60_000, 12), bar(120_000, 14)];
    const out = SLOPE_TEMPLATE.calc!(c, {
      calcParams: [1, 1],
      extendData: { maType: "sma", units: "priceBar" },
    } as never) as Array<{ slope?: number }>;
    expect(out[2].slope).toBeCloseTo(2, 10); // adjacent diff of a length-1 SMA
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/indicators/slope.test.ts`
Expected: FAIL — `SLOPE_TEMPLATE` is undefined.

- [ ] **Step 3: Write minimal implementation**

Append to `frontend/src/lib/indicators/slope.ts` (and add `alignHtfToChart` to the existing `../mtf` import — it's used by `computeSlopeCalc` below):

```ts
// Green when the MA is rising, red when falling. TV-ish palette.
const SLOPE_UP = "#26A69A";
const SLOPE_DOWN = "#EF5350";
const ZERO_LINE = "#9598A1";

function computeSlopeCalc(candles: KLineData[], ind: Indicator): SlopePoint[] {
  const ext = (ind.extendData ?? {}) as SlopeExtend;
  const maLen = Number(ind.calcParams?.[0]) || 9;
  const n = Number(ind.calcParams?.[1]) || 3;
  const units: SlopeUnit = ext.units ?? "pctHr";
  const maType = ext.maType === "sma" ? "sma" : "ema";
  // MTF: the coordinator stashes the slope-of-MA computed on native HTF bars
  // (with HTF barHours) — align it to the chart bars, no lookahead. See
  // mtfCoordinator.applySlopeTimeframe.
  const mtf = ext.mtf;
  if (mtf?.timeframe && mtf.htfSeries && mtf.htfStarts && mtf.htfMs) {
    const aligned = alignHtfToChart(
      candles.map((k) => k.timestamp),
      mtf.htfStarts.map((t) => ({ timestamp: t }) as KLineData),
      mtf.htfSeries,
      mtf.htfMs,
      true,
    );
    return aligned.map((v) => ({ slope: v ?? undefined }));
  }
  return computeSlope(candles, maType, maLen, n, units, ext, inferBarHours(candles));
}

// Two-color line split at zero crossings + a zero reference line. Returns true to
// SUPPRESS the default single-color figure line (we draw the colored one here).
function drawSlope(params: IndicatorDrawParams<SlopePoint>): boolean {
  const { ctx, visibleRange, indicator, xAxis, yAxis, bounding } = params;
  const result = indicator.result as SlopePoint[];
  const { from, to } = visibleRange;
  // Zero reference line across the pane.
  const yZero = yAxis.convertToPixel(0);
  ctx.save();
  ctx.strokeStyle = ZERO_LINE;
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 2]);
  ctx.beginPath();
  ctx.moveTo(bounding.left ?? 0, yZero);
  ctx.lineTo((bounding.left ?? 0) + bounding.width, yZero);
  ctx.stroke();
  ctx.setLineDash([]);
  // Colored slope line: color each segment by the sign at its right end.
  ctx.lineWidth = 1.5;
  for (let i = Math.max(from, 1); i < to; i++) {
    const a = result[i - 1]?.slope;
    const b = result[i]?.slope;
    if (a === undefined || b === undefined) continue;
    const x1 = xAxis.convertToPixel(i - 1);
    const x2 = xAxis.convertToPixel(i);
    const y1 = yAxis.convertToPixel(a);
    const y2 = yAxis.convertToPixel(b);
    ctx.strokeStyle = b >= 0 ? SLOPE_UP : SLOPE_DOWN;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
  ctx.restore();
  return true; // suppress default line
}

export const SLOPE_TEMPLATE: Omit<IndicatorTemplate, "name"> = {
  shortName: "Slope",
  series: IndicatorSeries.Normal,
  precision: 4,
  calcParams: [9, 3],
  figures: [{ key: "slope", title: "Slope: ", type: "line" }],
  styles: { lines: [fullLine(SLOPE_UP, LineType.Solid)] },
  calc: (dataList: KLineData[], ind: Indicator) => computeSlopeCalc(dataList, ind),
  draw: (params) => drawSlope(params as IndicatorDrawParams<SlopePoint>),
};
```

> Note: verify the exact `IndicatorDrawParams` field names (`bounding`, `visibleRange`, `xAxis`, `yAxis`) against `rsi.ts`'s `drawRsiDivergences` signature and adjust if the local klinecharts types differ (rsi.ts uses `xAxis.convertToPixel`/`yAxis.convertToPixel` and a `left`/`right` from `bounding` — match whatever it destructures).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/indicators/slope.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/indicators/slope.ts frontend/src/lib/indicators/slope.test.ts
git commit -m "feat(slope): SLOPE sub-pane template (two-color line + zero ref)"
```

---

### Task 3: Register SLOPE + menu metadata

**Files:**
- Modify: `frontend/src/lib/customIndicators.ts` (export, type union, BASE_TEMPLATES)
- Modify: `frontend/src/lib/indicatorMeta.ts` (INDICATOR_META entry)
- Test: `frontend/src/lib/customIndicators.test.ts` (or a new `slope.register.test.ts` if none exists)

**Interfaces:**
- Consumes: `SLOPE_TEMPLATE` (Task 2).
- Produces: `"SLOPE"` in `CustomIndicatorType`; `BASE_TEMPLATES.SLOPE`; `INDICATOR_META.SLOPE`.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/lib/slope.register.test.ts
import { describe, it, expect } from "vitest";
import { BASE_TEMPLATES } from "./customIndicators";

describe("SLOPE registration", () => {
  it("SLOPE is a known base template", () => {
    expect(BASE_TEMPLATES.SLOPE).toBeDefined();
    expect(BASE_TEMPLATES.SLOPE.figures?.[0]?.key).toBe("slope");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/slope.register.test.ts`
Expected: FAIL — `Property 'SLOPE' does not exist` (tsc/vitest) or undefined.

- [ ] **Step 3: Write minimal implementation**

In `frontend/src/lib/customIndicators.ts`:

```ts
export * from "./indicators/slope";          // add near the other barrel re-exports
```
```ts
import { SLOPE_TEMPLATE } from "./indicators/slope";   // add near the other imports
```
Add `"SLOPE"` to the `CustomIndicatorType` union, and to `BASE_TEMPLATES`:
```ts
export type CustomIndicatorType =
  | "EMA" | "MA" | "LR" | "VWAP" | "AVWAP" | "PREV_HL" | "RSI"
  | "SESSIONS" | "TIME_HIGHLIGHT" | "PIVOT_BANDS" | "SLOPE";

export const BASE_TEMPLATES: Record<CustomIndicatorType, Omit<IndicatorTemplate, "name">> = {
  // ...existing entries...
  SLOPE: SLOPE_TEMPLATE,
};
```
(Do NOT add SLOPE to `OVERLAY_INDICATORS` — it is a sub-pane.)

In `frontend/src/lib/indicatorMeta.ts`, add to `INDICATOR_META`:

```ts
SLOPE: {
  inputs: [
    num(0, "MA Length"),
    num(1, "Slope Period", { min: 1 }),
    {
      key: "maType", label: "MA Type", type: "select",
      source: "extend", field: "maType", default: "ema",
      options: [
        { value: "ema", label: "EMA" },
        { value: "sma", label: "SMA" },
      ],
    },
    {
      key: "units", label: "Units", type: "select",
      source: "extend", field: "units", default: "pctHr",
      options: [
        { value: "pctHr", label: "% / hour" },
        { value: "pctBar", label: "% / bar" },
        { value: "priceBar", label: "Price / bar" },
      ],
    },
    {
      key: "source", label: "Source", type: "select",
      source: "extend", field: "source", default: "close",
      options: PRICE_SOURCES,
    },
  ],
  title: "MA Slope",
  desc: "Rate of change of an EMA or SMA over a lookback period (%/hr, %/bar, or price/bar).",
},
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/slope.register.test.ts && npx tsc --noEmit`
Expected: PASS + no type errors (the `Record<CustomIndicatorType, …>` forces every key present).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/customIndicators.ts frontend/src/lib/indicatorMeta.ts frontend/src/lib/slope.register.test.ts
git commit -m "feat(slope): register SLOPE indicator + settings-modal inputs"
```

---

### Task 4: SLOPE as a rule operand (recipe compute + type + warm-up)

**Files:**
- Modify: `frontend/src/lib/backtestConfig.ts` (`SeriesIndicatorType`, `operandBaseLen`)
- Modify: `frontend/src/lib/backtestSeries.ts` (`computeIndicatorRecipe` SLOPE case; thread `barHours`)
- Modify: `frontend/src/lib/chartOperand.ts` (`SUPPORTED_INDICATORS`, `indicatorOutputs`, label)
- Test: `frontend/src/lib/backtestSeries.test.ts` (recipe parity), `frontend/src/lib/backtestConfig.test.ts` (warm-up)

**Interfaces:**
- Consumes: `computeSlope`, `inferBarHours`, `SlopeUnit`, `SlopeExtend` (Tasks 1–2).
- Produces: `"SLOPE"` in `SeriesIndicatorType`; a `SLOPE` case in `computeIndicatorRecipe` that returns `computeSlope(...)`'s `.slope` array; `operandBaseLen` SLOPE = `maLen + slopePeriod`.

- [ ] **Step 1: Write the failing test**

```ts
// add to frontend/src/lib/backtestSeries.test.ts (import buildChartOperandSeries + a config builder as the file already does)
import { describe, it, expect } from "vitest";
import type { KLineData } from "klinecharts";
import { SLOPE_TEMPLATE } from "./indicators/slope";
// The recipe compute is internal; assert via buildChartOperandSeries OR export
// computeIndicatorRecipe for the test. Prefer asserting the operand series equals
// the plotted line (parity). Use the same maType/units/params on both sides.

const bar = (t: number, c: number): KLineData =>
  ({ timestamp: t, open: c, high: c, low: c, close: c, volume: 1 }) as KLineData;

describe("SLOPE recipe parity", () => {
  it("operand series equals the plotted SLOPE line (same inputs)", async () => {
    const candles = [0, 1, 2, 3, 4].map((i) => bar(i * 300_000, 10 + i));
    const plotted = (SLOPE_TEMPLATE.calc!(candles, {
      calcParams: [1, 1],
      extendData: { maType: "sma", units: "pctBar" },
    } as never) as Array<{ slope?: number }>).map((p) => p.slope ?? null);

    const cfg = {
      // minimal config with one series operand referencing a SLOPE recipe
      // (mirror how existing backtestSeries tests build a config with a
      // kind:"series" operand — recipe: { source:"indicator", indicatorType:"SLOPE",
      // calcParams:[1,1], line:0, extend:{ maType:"sma", units:"pctBar" } }).
    } as never;
    const out = await buildChartOperandSeries(candles, cfg, "5", async () => []);
    const key = Object.keys(out)[0];
    expect(out[key]).toEqual(plotted);
  });
});
```

> The exact config/operand construction should copy the pattern already used by the nearest existing `buildChartOperandSeries`/`computeSeriesRecipe` test in this file. If none exists, export `computeIndicatorRecipe` and assert it directly against `SLOPE_TEMPLATE.calc`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/backtestSeries.test.ts`
Expected: FAIL — SLOPE not handled (returns all-undefined) so the arrays differ.

- [ ] **Step 3: Write minimal implementation**

`frontend/src/lib/backtestConfig.ts`:
```ts
export type SeriesIndicatorType =
  "EMA" | "MA" | "LR" | "VWAP" | "AVWAP" | "PREV_HL" | "RSI" | "PIVOT_BANDS" | "SLOPE";
```
In `operandBaseLen`, before the final `return base;` inside the `series/indicator` branch:
```ts
if (r.indicatorType === "SLOPE") {
  const maLen = Math.max(1, Number(r.calcParams[0]) || 9);
  const slopeN = Math.max(1, Number(r.calcParams[1]) || 3);
  return maLen + slopeN;
}
```

`frontend/src/lib/backtestSeries.ts` — thread `barHours` so the SLOPE case can compute `%/hr` identically to the visual:
```ts
// derive() already has barHours; pass it down:
function computeRaw(op: Operand, candles: KLineData[], barHours: number): Array<number | undefined> {
  // ...unchanged branches...
  if (op.kind === "series") return computeSeriesRecipe(op.recipe, candles, barHours);
  // ...
}
function computeSeriesRecipe(recipe: SeriesRecipe, candles: KLineData[], barHours: number): Array<number | undefined> {
  return recipe.source === "indicator"
    ? computeIndicatorRecipe(recipe, candles, barHours)
    : computeDrawingRecipe(recipe, candles);
}
```
Update `derive` to pass it: `const raw = computeRaw(op, candles, barHours);`.
Add the SLOPE case in `computeIndicatorRecipe(r, candles, barHours)` — **use the SAME `inferBarHours(candles)` the visual uses**, so parity holds even for irregular timeframes; ignore the threaded `barHours` for this case (the threaded value drives the operand-level `~slope` double-slope transform in `derive`, not the indicator's own slope):
```ts
case "SLOPE": {
  const ext = (r.extend ?? {}) as SlopeExtend;
  const maLen = Math.max(1, Number(r.calcParams[0]) || 9);
  const n = Math.max(1, Number(r.calcParams[1]) || 3);
  const units: SlopeUnit = ext.units ?? "pctHr";
  const maType = ext.maType === "sma" ? "sma" : "ema";
  return computeSlope(candles, maType, maLen, n, units, ext, inferBarHours(candles)).map(
    (p) => p.slope ?? undefined,
  );
}
```
Add imports at the top of `backtestSeries.ts`:
```ts
import { computeSlope, inferBarHours, type SlopeUnit, type SlopeExtend } from "./indicators/slope";
```

`frontend/src/lib/chartOperand.ts`:
```ts
const SUPPORTED_INDICATORS = new Set<string>([
  "EMA", "MA", "LR", "VWAP", "AVWAP", "PREV_HL", "RSI", "PIVOT_BANDS", "SLOPE",
]);
```
Add a SLOPE case to `indicatorOutputs()`:
```ts
case "SLOPE":
  return [{ lineIndex: 0, label: "Value", base: true }];
```
Add a label in `recipeLabel`/the label switch (find where `PIVOT_BANDS` returns `"Pivot Bands"`):
```ts
if (t === "SLOPE") return "MA Slope";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/backtestSeries.test.ts src/lib/backtestConfig.test.ts && npx tsc --noEmit`
Expected: PASS + no type errors. `SlopeExtend` extends `MaExtend`, so `sanitizeExtend` still strips `mtf`/`indType`; confirm the recipe's `extend` carries `maType`, `units`, `source`.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/backtestConfig.ts frontend/src/lib/backtestSeries.ts frontend/src/lib/chartOperand.ts frontend/src/lib/backtestSeries.test.ts
git commit -m "feat(slope): SLOPE pickable as a rule operand (recipe parity + warm-up)"
```

---

### Task 5: MTF for the visual (coordinator branch)

**Files:**
- Modify: `frontend/src/lib/mtfCoordinator.ts` (`applySlopeTimeframe` + a `SLOPE` branch in `refreshMtfIndicators`)
- Modify: `frontend/src/lib/indicators/slope.ts` — extend `SlopeExtend.mtf` to carry the precomputed HTF slope series (already inherited from `MaExtend.mtf`: `{timeframe, htfStarts, htfSeries, htfMs}` — reuse it verbatim, no change needed unless a field is missing).
- Test: none automated (async chart fetch); verified in-browser in Task 7.

**Interfaces:**
- Consumes: `computeSlope`, `inferBarHours`, `SlopeUnit` (Tasks 1–2); `fetchHtfBars` (existing, un-exported — export it or add the branch inside `mtfCoordinator.ts` which already has it in scope).
- Produces: `export async function applySlopeTimeframe(chart, epic, name, paneId, config, timeframe, brokerId?, oldestChartMs?)`.

- [ ] **Step 1: Write the failing test** — N/A (async chart integration). Skip to Step 3; verification is the browser check in Task 7. State this explicitly in the commit.

- [ ] **Step 3: Write minimal implementation**

In `frontend/src/lib/mtfCoordinator.ts`:
```ts
import { computeSlope, inferBarHours, type SlopeUnit } from "./indicators/slope";

interface SlopeConfig {
  maType: "ema" | "sma";
  maLen: number;    // calcParams[0]
  slopeN: number;   // calcParams[1]
  units: SlopeUnit;
  options: MaExtend; // source/offset
}

export async function applySlopeTimeframe(
  chart: Chart, epic: string, name: string, paneId: string,
  config: SlopeConfig, timeframe: string | null,
  brokerId?: string, oldestChartMs?: number,
): Promise<void> {
  const ind = chart.getIndicatorByPaneId(paneId, name) as { extendData?: SlopeExtend } | null;
  const ext: SlopeExtend = {
    ...(ind?.extendData ?? {}), ...config.options,
    maType: config.maType, units: config.units,
  };
  const calcParams = [config.maLen, config.slopeN];
  if (!timeframe || timeframe === "chart") {
    ext.mtf = { timeframe: null };
    chart.overrideIndicator({ name, calcParams, extendData: ext }, paneId);
    return;
  }
  // Reach back MA length + slope period so the HTF left edge is populated.
  const { htf, htfMs } = await fetchHtfBars(
    chart, epic, timeframe, config.maLen + config.slopeN, brokerId, oldestChartMs,
  );
  // Slope computed on native HTF bars with HTF barHours (inferBarHours matches the
  // rule path's computeIndicatorRecipe), BEFORE alignHtfToChart forward-fills.
  const pts = computeSlope(
    htf, config.maType, config.maLen, config.slopeN, config.units,
    config.options, inferBarHours(htf),
  );
  ext.mtf = {
    timeframe,
    htfStarts: htf.map((b) => b.timestamp),
    htfSeries: pts.map((p) => p.slope),
    htfMs,
  };
  chart.overrideIndicator({ name, calcParams, extendData: ext }, paneId);
}
```
Import `SlopeExtend` at the top:
```ts
import type { SlopeExtend } from "./indicators/slope";
```
Add a branch in `refreshMtfIndicators` (after the `PIVOT_BANDS` branch), using `maLen + slopeN` as the warm-up for the `covered()` guard:
```ts
} else if (type === "SLOPE") {
  const ext = (ind.extendData ?? {}) as SlopeExtend;
  const maLen = Number(ind.calcParams?.[0]) || 9;
  const slopeN = Number(ind.calcParams?.[1]) || 3;
  if (covered(maLen + slopeN)) return;
  jobs.push(
    applySlopeTimeframe(
      chart, epic, id, paneId,
      {
        maType: ext.maType === "sma" ? "sma" : "ema",
        maLen, slopeN,
        units: ext.units ?? "pctHr",
        options: { source: ext.source, offset: ext.offset },
      },
      tf, brokerId, oldestChartMs,
    ),
  );
}
```
Ensure `indTypeOf` resolves `"SLOPE"` for a SLOPE instance (it keys off the instance name / extendData.indType — confirm a fresh SLOPE instance's name starts with `SLOPE`, as EMA/MA/PIVOT_BANDS do; the add flow in `lib/indicators.ts` sets this).

- [ ] **Step 4: Verify** — `cd frontend && npx tsc --noEmit` passes; full MTF behavior verified in Task 7.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/mtfCoordinator.ts frontend/src/lib/indicators/slope.ts
git commit -m "feat(slope): MTF for the SLOPE visual (HTF slope aligned to chart bars)"
```

---

### Task 6: Settings-modal Timeframe (MTF) wiring

**Files:**
- Modify: `frontend/src/IndicatorSettings.tsx` (add a SLOPE Timeframe block + an `applySlope` apply-fn mirroring `applyPivotBands`)
- Test: none automated; verified in Task 7.

**Interfaces:**
- Consumes: `applySlopeTimeframe` (Task 5); the existing `higherTimeframes`, `timeframe`/`setTimeframe` state, `chart/epic/name/paneId/brokerId` in scope.
- Produces: an `applySlope(next)` closure + a Timeframe `<select>` block rendered when `type === "SLOPE"`.

- [ ] **Step 1: Write the failing test** — N/A (React modal + async fetch). Verified in Task 7.

- [ ] **Step 3: Write minimal implementation**

Follow the `applyPivotBands` pattern (`IndicatorSettings.tsx` ~lines 645–673). Add near it:
```ts
function applySlope(
  next: Partial<{ maLen: number; slopeN: number; maType: string; units: string; source: string; timeframe: string }> = {},
): void {
  const tf = next.timeframe ?? timeframe;
  void applySlopeTimeframe(
    chart, epic, name, paneId,
    {
      maType: (next.maType ?? (ext0.maType === "sma" ? "sma" : "ema")) as "ema" | "sma",
      maLen: next.maLen ?? Number(calcParams[0]) || 9,
      slopeN: next.slopeN ?? Number(calcParams[1]) || 3,
      units: (next.units ?? ext0.units ?? "pctHr") as SlopeUnit,
      options: { source: next.source ?? source, offset },
    },
    tf === "chart" ? null : tf,
    brokerId,
  );
}
```
- Import `applySlopeTimeframe` from `./lib/mtfCoordinator` and `SlopeUnit` from `./lib/indicators/slope`.
- Route the generic Inputs `onChange` for a SLOPE instance through `applySlope` (as Pivot Bands routes `mode`/`source` and calcParams through `applyPivotBands` at ~lines 412 and 694–700), so an MTF SLOPE recomputes its HTF series on any input change instead of leaving a stale one aligned.
- Render a Timeframe `<select>` for `type === "SLOPE"` mirroring the Pivot Bands block (~lines 1121–1133): `value={timeframe}`, `onChange` → `setTimeframe(v); applySlope({ timeframe: v })`, options from `higherTimeframes`, plus the `"chart"` default option.
- In the persistence effect (~line 556), persist only `mtf:{timeframe}` for SLOPE (never the bulky HTF series), exactly like the Pivot Bands line: `if (type === "SLOPE" && timeframe !== "chart") extendData.mtf = { timeframe };`.

- [ ] **Step 4: Verify** — `cd frontend && npx tsc --noEmit` passes; behavior in Task 7.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/IndicatorSettings.tsx
git commit -m "feat(slope): Timeframe (MTF) control in the SLOPE settings modal"
```

---

### Task 7: End-to-end browser verification

**Files:** none (manual verification via claude-in-chrome, per the browser-tool memory).

- [ ] **Step 1:** Start/confirm the dev server is running (do NOT kill the user's HMR). Open a chart tab; set a document.title so the user can spot it.
- [ ] **Step 2:** Add the **MA Slope** indicator from the indicator menu. Confirm it opens a sub-pane with a two-color line (green above 0 / red below) and a dashed zero line.
- [ ] **Step 3:** Open its settings → change **Units** to `% / bar` then `Price / bar`; confirm the line rescales and the legend value updates. Change **MA Type** EMA↔SMA and **MA Length**/**Slope Period**; confirm recompute.
- [ ] **Step 4:** Set **Timeframe** to a higher TF; confirm the slope line becomes a stepped HTF-aligned series and survives a scroll-back (left edge stays populated) and a reload.
- [ ] **Step 5:** Open the Backtest Strategy panel → chart-operand picker → confirm **MA Slope** appears as a pickable operand with the label matching the chart. Build a rule (`MA Slope gt 0`), Run backtest → 200 with results. Confirm a `%/bar` vs `%/hr` SLOPE produce distinct `seriesKey`s (no dedup collision) by adding both to a rule.
- [ ] **Step 6:** Full check: `cd frontend && npx tsc --noEmit && npx vitest run`. Expected: clean + all tests pass.
- [ ] **Step 7:** Close any tabs this task opened. Commit nothing (verification only) unless fixes were needed.

---

## Notes / known divergences (documented, intentional)

- The SLOPE indicator's `%/hr` uses `inferBarHours(candles)` (min positive timestamp gap), which for irregular timeframes (monthly/quarterly/yearly) differs slightly from the app's `RESOLUTION_SECONDS`-based `tfHours` that the separate `slope()` operand transform uses. This is deliberate: it guarantees the SLOPE indicator's plotted line and its rule value are identical by construction. Sub-monthly timeframes are exact either way.
- The Δ (operand-level slope) toggle is not hidden for the SLOPE `series` operand, so a user could slope an already-slope operand (a second derivative). Left available per the approved design.
