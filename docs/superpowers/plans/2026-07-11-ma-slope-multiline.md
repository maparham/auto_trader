# Multi-line MA Slope (+ smoothing) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalize the shipped single-line `SLOPE` indicator to plot the slope of up to 5 MAs (one line per length) in one sub-pane, with optional slope smoothing and per-line configurable styles, keeping chart↔rule↔MTF parity.

**Architecture:** One shared pipeline (`slopeLineSeries`: MA → slope → smoothing) is called per length by the visual, the rule recipe, and the MTF coordinator. `calcParams` becomes the list of MA lengths; `regenerateFigures` emits one line figure per length. A single length (N=1) is the existing behavior. Reshapes the just-shipped SLOPE data model — no migration (nothing real persists a SLOPE rule).

**Tech Stack:** TypeScript, React, klinecharts (custom indicators + `regenerateFigures`), Vitest.

## Global Constraints

- Frontend only — NO backend changes.
- **Parity by construction:** the recipe value for a SLOPE line MUST equal that plotted line. Enforce via ONE shared `slopeLineSeries(candles, maType, length, n, units, source, smoothing, barHours)` called by the visual `calc`, the recipe (`computeIndicatorRecipe`), AND the MTF coordinator. `barHours = inferBarHours(candles)` on whatever candle array each route holds. Length is **UNCLAMPED** everywhere (`Number(x)||default`, no `Math.max(1,…)`).
- **Data model:** `calcParams` = list of MA lengths `[len0…lenK]`, 1–5 entries. `extendData` (`SlopeExtend`) carries `slopePeriod`, `maType`, `units`, `source`, `smoothing?: {type:"none"|"sma"|"ema"; length}`, `colorByDirection?`, and `mtf` (now with per-line `htfSeriesByLine`).
- **Figures** keyed `slope0…slopeK` via `regenerateFigures(calcParams)`. `calc` returns points `Record<string, number|undefined>` with those keys.
- **Color rule:** `colorByDirection` ON **and exactly one line** → green(`≥0`)/red(`<0`) using fixed `SLOPE_UP`/`SLOPE_DOWN`. Otherwise each line uses its configured `styles.lines[i].color`. (Configurable up/down direction colors are out of scope; the per-line solid colors are the configurable styles.)
- **Cap 5.** Smoothing default `none`. Defaults otherwise unchanged: maType `ema`, slopePeriod `3`, units `pctHr`, source close.
- Vitest gotcha: klinecharts enums are `undefined` in the node test env — any test importing a template/`customIndicators` MUST use the `vi.mock("klinecharts", …)` + top-level `await import` pattern (see `frontend/src/lib/indicators/pivotBands.test.ts` lines 1-13).
- Commands: tests `cd frontend && npx vitest run <paths>`; types `cd frontend && npx tsc -b` (`--noEmit` is a NO-OP; ignore pre-existing baseline errors in files you didn't touch). Commit ONLY your explicit paths (concurrent sessions have uncommitted files); never `git add -A`. Commit on `main`, do not push.

---

### Task 1: Shared smoothing + `slopeLineSeries`

**Files:**
- Modify: `frontend/src/lib/indicators/slope.ts`
- Modify (maybe): `frontend/src/lib/mtf.ts` (add an array-EMA if only array-`sma` exists)
- Test: `frontend/src/lib/indicators/slope.test.ts`

**Interfaces:**
- Consumes: existing `slopeWithUnits`, `maSeries`, `sma` (array) from `../mtf`.
- Produces:
  - `type SlopeSmoothing = { type: "none" | "sma" | "ema"; length: number }`
  - `smoothSeries(values: Array<number|undefined>, s?: SlopeSmoothing): Array<number|undefined>`
  - `slopeLineSeries(candles: KLineData[], maType: "ema"|"sma", length: number, n: number, units: SlopeUnit, source: MaExtend["source"], smoothing: SlopeSmoothing | undefined, barHours: number): Array<number|undefined>`

- [ ] **Step 1: Write the failing test**

```ts
// add to frontend/src/lib/indicators/slope.test.ts (this file already uses the
// vi.mock("klinecharts",…) + await import pattern — reuse it; import the new fns)
import { smoothSeries, slopeLineSeries } from ... // via the existing await import
const bar = (t: number, c: number): KLineData =>
  ({ timestamp: t, open: c, high: c, low: c, close: c, volume: 1 }) as KLineData;

describe("smoothSeries", () => {
  it("none returns input unchanged", () => {
    const v = [1, 2, 3];
    expect(smoothSeries(v, { type: "none", length: 3 })).toEqual(v);
    expect(smoothSeries(v, undefined)).toEqual(v);
  });
  it("sma length 2 averages the last 2 defined values", () => {
    // sma over [10,20,30] len2 => [undefined,15,25] (first bar has no full window)
    expect(smoothSeries([10, 20, 30], { type: "sma", length: 2 })).toEqual([undefined, 15, 25]);
  });
  it("passes undefined gaps through (leading warm-up preserved)", () => {
    const out = smoothSeries([undefined, 10, 20], { type: "sma", length: 2 });
    expect(out[0]).toBeUndefined();
  });
});

describe("slopeLineSeries", () => {
  it("MA→slope→smoothing, price/bar, sma len1 = adjacent diff then smoothed", () => {
    const c = [10, 12, 14, 16, 18].map((v, i) => bar(i * 60_000, v));
    // sma len1 MA = close; priceBar slope n=1 = +2 each bar; smoothing none => 2s
    const raw = slopeLineSeries(c, "sma", 1, 1, "priceBar", "close", { type: "none", length: 3 }, 1);
    expect(raw[4]).toBeCloseTo(2, 10);
    // with sma-2 smoothing the 2s stay 2 (constant), but the first slope bar drops
    const sm = slopeLineSeries(c, "sma", 1, 1, "priceBar", "close", { type: "sma", length: 2 }, 1);
    expect(sm[4]).toBeCloseTo(2, 10);
    expect(sm[1]).toBeUndefined(); // slope bar1 exists(2) but sma-2 needs 2 → undefined
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `cd frontend && npx vitest run src/lib/indicators/slope.test.ts` → FAIL (fns undefined).

- [ ] **Step 3: Write minimal implementation**

First check `frontend/src/lib/mtf.ts` for an array-based EMA. `sma(values: number[], length)` exists (imported by backtestSeries). If there is NO array-EMA export, add one to `mtf.ts`:
```ts
// mtf.ts — array EMA over a possibly-gappy series (undefined passes through until
// the first defined value seeds it). Mirrors sma()'s array signature.
export function ema(values: Array<number | undefined>, length: number): Array<number | undefined> {
  const k = 2 / (length + 1);
  const out: Array<number | undefined> = [];
  let prev: number | undefined;
  for (const v of values) {
    if (v === undefined) { out.push(undefined); continue; }
    prev = prev === undefined ? v : v * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}
```
(If an equivalent already exists, reuse it — do not duplicate.) Note the existing `sma` may take `number[]`; if it can't handle `undefined`, write a local `smaGappy` in slope.ts that skips leading undefineds and needs a full window. Prefer reusing `sma` if it already tolerates the gap semantics the test asserts; otherwise implement the windowed SMA inline in `smoothSeries`.

In `frontend/src/lib/indicators/slope.ts`:
```ts
import { maSeries, alignHtfToChart, sma, ema } from "../mtf"; // add sma, ema

export type SlopeSmoothing = { type: "none" | "sma" | "ema"; length: number };

/** Smooth a slope series (SMA/EMA) or return it unchanged for "none".
 * SMA needs a full window of `length` DEFINED values → first (length-1) defined
 * bars become undefined; undefined inputs pass through. */
export function smoothSeries(
  values: Array<number | undefined>,
  s?: SlopeSmoothing,
): Array<number | undefined> {
  if (!s || s.type === "none" || s.length <= 1) return values;
  if (s.type === "ema") return ema(values, s.length);
  // SMA over a gappy series: window of the last `length` values, all must be defined.
  return values.map((_, i) => {
    if (i < s.length - 1) return undefined;
    let sum = 0;
    for (let j = i - s.length + 1; j <= i; j++) {
      const v = values[j];
      if (v === undefined) return undefined;
      sum += v;
    }
    return sum / s.length;
  });
}

/** ONE MA-slope line: MA (via maSeries, matches the real EMA/SMA) → slope (units)
 * → optional smoothing. Shared by the visual, the rule recipe, and MTF so all
 * three agree by construction. */
export function slopeLineSeries(
  candles: KLineData[],
  maType: "ema" | "sma",
  length: number,
  n: number,
  units: SlopeUnit,
  source: MaExtend["source"],
  smoothing: SlopeSmoothing | undefined,
  barHours: number,
): Array<number | undefined> {
  const { base } = maSeries(candles, maType, length, { source });
  const raw = slopeWithUnits(base, n, barHours, units);
  return smoothSeries(raw, smoothing);
}
```
Keep the existing `computeSlope` for now (Task 2 removes its single-line callers). Verify `sma`/`ema` array signatures against `mtf.ts` and adjust imports.

- [ ] **Step 4: Run test** — `npx vitest run src/lib/indicators/slope.test.ts` → PASS.

- [ ] **Step 5: Commit** — `git add frontend/src/lib/indicators/slope.ts frontend/src/lib/indicators/slope.test.ts frontend/src/lib/mtf.ts && git commit -m "feat(slope): shared slopeLineSeries + slope smoothing"`

---

### Task 2: Multi-line template (calc over lengths + `regenerateFigures`)

**Files:**
- Modify: `frontend/src/lib/indicators/slope.ts`
- Test: `frontend/src/lib/indicators/slope.test.ts`

**Interfaces:**
- Consumes: `slopeLineSeries`, `inferBarHours`, `SlopeSmoothing` (Task 1).
- Produces: `SlopeExtend` gains `slopePeriod?`, `smoothing?: SlopeSmoothing`, `colorByDirection?: boolean`, and `mtf.htfSeriesByLine`. `SlopePoint` becomes `Record<string, number | undefined>`. `SLOPE_TEMPLATE` now has `calcParams: [9]`, `regenerateFigures`, `styles.lines` = 5 defaults. Helper `slopeLengths(calcParams): number[]` and `slopeShared(ext): {maType,n,units,source,smoothing}`.

- [ ] **Step 1: Write the failing test**

```ts
// SLOPE_TEMPLATE.calc returns one keyed slope per length; regenerateFigures emits N figures
describe("multi-line SLOPE", () => {
  const bar = (t: number, c: number): KLineData =>
    ({ timestamp: t, open: c, high: c, low: c, close: c, volume: 1 }) as KLineData;
  it("calc returns slope0..slopeK, one per calcParams length", () => {
    const c = [10, 11, 12, 13, 14].map((v, i) => bar(i * 60_000, v));
    const out = SLOPE_TEMPLATE.calc!(c, {
      calcParams: [1, 2], // two MA lengths
      extendData: { maType: "sma", units: "priceBar", slopePeriod: 1 },
    } as never) as Array<Record<string, number | undefined>>;
    expect("slope0" in out[4] && "slope1" in out[4]).toBe(true);
    expect(out[4].slope0).toBeCloseTo(1, 10); // sma len1 → +1/bar priceBar slope
  });
  it("regenerateFigures emits one line figure per length", () => {
    const figs = SLOPE_TEMPLATE.regenerateFigures!([9, 21, 50]);
    expect(figs.map((f) => f.key)).toEqual(["slope0", "slope1", "slope2"]);
    expect(figs.every((f) => f.type === "line")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — FAIL (`regenerateFigures` undefined; calc returns `{slope}`).

- [ ] **Step 3: Write minimal implementation**

In `slope.ts`:
```ts
export interface SlopeExtend extends MaExtend {
  maType?: "ema" | "sma";
  units?: SlopeUnit;
  slopePeriod?: number;
  smoothing?: SlopeSmoothing;
  colorByDirection?: boolean;
  mtf?: MaExtend["mtf"] & { htfSeriesByLine?: Array<Array<number | undefined>> };
}
export type SlopePoint = Record<string, number | undefined>;

const SLOPE_PALETTE = ["#26A69A", "#42A5F5", "#FFB300", "#AB47BC", "#EF5350"];

/** MA lengths from calcParams (default [9]); empty/garbage → [9]. */
export function slopeLengths(calcParams: unknown[] | undefined): number[] {
  const xs = (calcParams ?? []).map((v) => Number(v)).filter((v) => Number.isFinite(v) && v !== 0);
  return xs.length ? xs.slice(0, 5) : [9];
}
function slopeShared(ext: SlopeExtend) {
  return {
    maType: (ext.maType === "sma" ? "sma" : "ema") as "ema" | "sma",
    n: Number(ext.slopePeriod) || 3,
    units: (ext.units ?? "pctHr") as SlopeUnit,
    source: ext.source,
    smoothing: ext.smoothing,
  };
}

function computeSlopeCalc(candles: KLineData[], ind: Indicator): SlopePoint[] {
  const ext = (ind.extendData ?? {}) as SlopeExtend;
  const lengths = slopeLengths(ind.calcParams);
  const { maType, n, units, source, smoothing } = slopeShared(ext);
  const mtf = ext.mtf;
  // MTF: coordinator stashes per-line slope series computed on native HTF bars.
  if (mtf?.timeframe && mtf.htfSeriesByLine && mtf.htfStarts && mtf.htfMs) {
    const ts = candles.map((k) => k.timestamp);
    const starts = mtf.htfStarts.map((t) => ({ timestamp: t }) as KLineData);
    const aligned = mtf.htfSeriesByLine.map((series) =>
      alignHtfToChart(ts, starts, series, mtf.htfMs!, true));
    return candles.map((_, i) => {
      const p: SlopePoint = {};
      aligned.forEach((a, li) => (p[`slope${li}`] = a[i] ?? undefined));
      return p;
    });
  }
  const barHours = inferBarHours(candles);
  const lines = lengths.map((len) =>
    slopeLineSeries(candles, maType, len, n, units, source, smoothing, barHours));
  return candles.map((_, i) => {
    const p: SlopePoint = {};
    lines.forEach((line, li) => (p[`slope${li}`] = line[i] ?? undefined));
    return p;
  });
}

function slopeFigures(calcParams: unknown[]): Array<{ key: string; title?: string; type: "line" }> {
  return slopeLengths(calcParams).map((_, i) => ({
    key: `slope${i}`,
    ...(i === 0 ? { title: "Slope: " } : {}),
    type: "line" as const,
  }));
}

export const SLOPE_TEMPLATE: Omit<IndicatorTemplate, "name"> = {
  shortName: "Slope",
  series: IndicatorSeries.Normal,
  precision: 4,
  calcParams: [9],
  figures: slopeFigures([9]),
  regenerateFigures: (calcParams: unknown[]) => slopeFigures(calcParams),
  styles: { lines: SLOPE_PALETTE.map((c) => fullLine(c, LineType.Solid)) },
  calc: (dataList, ind) => computeSlopeCalc(dataList, ind),
  draw: (params) => drawSlope(params as IndicatorDrawParams<SlopePoint>),
};
```
Delete the now-unused single-line `computeSlope` export ONLY after confirming no other file imports it (grep `computeSlope\b`); backtestSeries will switch to `slopeLineSeries` in Task 4, so keep `computeSlope` until then OR update the import in the same commit if grep shows only backtestSeries uses it. `drawSlope` is updated in Task 3 — for now keep it reading `slope` OR temporarily read `slope0` so the file compiles; Task 3 rewrites it fully.

> `regenerateFigures` type: klinecharts types it `(calcParams: any[]) => IndicatorFigure[]`. Cast the return if tsc complains; the runtime shape `{key,title?,type:"line"}` is what MA/RSI built-ins emit.

- [ ] **Step 4: Run test** — PASS. Also `npx tsc -b` clean for slope.ts.

- [ ] **Step 5: Commit** — `git add frontend/src/lib/indicators/slope.ts frontend/src/lib/indicators/slope.test.ts && git commit -m "feat(slope): multi-line calc + regenerateFigures (calcParams = MA lengths)"`

---

### Task 3: Draw — per-line colors + color-by-direction

**Files:**
- Modify: `frontend/src/lib/indicators/slope.ts` (`drawSlope`)
- Test: none automated (canvas) — verified in Task 7.

**Interfaces:**
- Consumes: `SlopePoint`, `SlopeExtend`, `slopeLengths` (Task 2); klinecharts `IndicatorDrawParams` fields `indicator.styles?.lines`, `defaultStyles.lines`.

- [ ] **Step 3: Write minimal implementation**

```ts
function drawSlope(params: IndicatorDrawParams<SlopePoint>): boolean {
  const { ctx, visibleRange, indicator, xAxis, yAxis, bounding, defaultStyles } = params;
  const result = (indicator.result ?? []) as SlopePoint[];
  const ext = (indicator.extendData ?? {}) as SlopeExtend;
  const lengths = slopeLengths(indicator.calcParams);
  const { from, to } = visibleRange;
  ctx.save();
  // Zero reference line.
  const yZero = yAxis.convertToPixel(0);
  ctx.strokeStyle = ZERO_LINE; ctx.lineWidth = 1; ctx.setLineDash([2, 2]);
  ctx.beginPath(); ctx.moveTo(bounding.left, yZero);
  ctx.lineTo(bounding.left + bounding.width, yZero); ctx.stroke(); ctx.setLineDash([]);

  const overrides = indicator.styles?.lines ?? [];
  const defaults = defaultStyles?.lines ?? [];
  const lineColor = (li: number): string =>
    overrides[li]?.color ?? defaults[li]?.color ?? SLOPE_PALETTE[li % SLOPE_PALETTE.length];
  const lineWidth = (li: number): number => overrides[li]?.size ?? defaults[li]?.size ?? 1.5;

  const directionMode = ext.colorByDirection !== false && lengths.length === 1;

  for (let li = 0; li < lengths.length; li++) {
    const key = `slope${li}`;
    ctx.lineWidth = lineWidth(li);
    for (let i = Math.max(from, 1); i < to; i++) {
      const a = result[i - 1]?.[key];
      const b = result[i]?.[key];
      if (a === undefined || b === undefined) continue;
      ctx.strokeStyle = directionMode ? (b >= 0 ? SLOPE_UP : SLOPE_DOWN) : lineColor(li);
      ctx.beginPath();
      ctx.moveTo(xAxis.convertToPixel(i - 1), yAxis.convertToPixel(a));
      ctx.lineTo(xAxis.convertToPixel(i), yAxis.convertToPixel(b));
      ctx.stroke();
    }
  }
  ctx.restore();
  return true; // suppress default lines
}
```
Default `colorByDirection` treated as ON (`!== false`) so a single line keeps today's green/red look with no config. Verify `SmoothLineStyle` exposes `.color`/`.size` (it does — Style tab reads them).

- [ ] **Step 4: Verify** — `npx tsc -b` clean for slope.ts. Visual behavior in Task 7.

- [ ] **Step 5: Commit** — `git add frontend/src/lib/indicators/slope.ts && git commit -m "feat(slope): per-line colors + color-by-direction draw"`

---

### Task 4: Rule operands — slope AND MA per length (2K), warm-up + parity

**Files:**
- Modify: `frontend/src/lib/backtestSeries.ts` (SLOPE recipe case — slope or MA by line)
- Modify: `frontend/src/lib/backtestConfig.ts` (`operandBaseLen` SLOPE)
- Modify: `frontend/src/lib/chartOperand.ts` (`indicatorOutputs` SLOPE returns 2K)
- Test: `frontend/src/lib/backtestSeries.test.ts`

**Interfaces:**
- Consumes: `slopeLineSeries`, `inferBarHours`, `slopeLengths`, `SlopeExtend`, `SlopeSmoothing` (Tasks 1-2); `maSeries` from `../mtf`.

**`line` encoding** (`K = lengths.length` from the recipe's own `calcParams`): `line ∈ [0,K)`
→ slope of `lengths[line]`; `line ∈ [K,2K)` → raw MA of `lengths[line−K]`. So each length
exposes TWO operands: its slope and its underlying MA (MA computed for rules, not plotted).

- [ ] **Step 1: Write the failing tests**

```ts
// (a) a slope line: recipe line 1 == plotted slope1 for the same inputs (incl. smoothing)
it("SLOPE recipe slope line parity with the plotted slope1", () => {
  const candles = [10, 11, 13, 16, 20, 25].map((v, i) => bar(i * 300_000, v));
  const ext = { maType: "sma", units: "pctBar", slopePeriod: 1, smoothing: { type: "sma", length: 2 } };
  const plotted = (SLOPE_TEMPLATE.calc!(candles, { calcParams: [1, 2], extendData: ext } as never) as Array<Record<string, number|undefined>>)
    .map((p) => p.slope1 ?? null);
  const got = computeIndicatorRecipe(
    { source: "indicator", indicatorType: "SLOPE", calcParams: [1, 2], line: 1, extend: ext } as never,
    candles, 1,
  ).map((v) => v ?? null);
  expect(got).toEqual(plotted);
});

// (b) an MA line: with K=2 lengths, line 2 (=K+0) is the RAW MA of lengths[0], line 3 the MA
// of lengths[1] — no slope, no smoothing applied.
it("SLOPE recipe line>=K returns the raw underlying MA", () => {
  const candles = [10, 12, 14, 16, 18].map((v, i) => bar(i * 60_000, v));
  const ext = { maType: "sma", units: "pctBar", slopePeriod: 1 };
  // sma length 1 = close; sma length 2 = trailing mean
  const maLen1 = computeIndicatorRecipe(
    { source: "indicator", indicatorType: "SLOPE", calcParams: [1, 2], line: 2 /*K=2,+0*/, extend: ext } as never,
    candles, 1,
  );
  expect(maLen1[4]).toBeCloseTo(18, 10);          // sma len1 = close
  const maLen2 = computeIndicatorRecipe(
    { source: "indicator", indicatorType: "SLOPE", calcParams: [1, 2], line: 3 /*K=2,+1*/, extend: ext } as never,
    candles, 1,
  );
  expect(maLen2[4]).toBeCloseTo(17, 10);          // sma len2 of [16,18] = 17
});
```
(Mirror the file's existing SLOPE recipe test harness; `computeIndicatorRecipe` was exported by the base feature — reuse that export.)

- [ ] **Step 2: Run test to verify it fails** — FAIL (SLOPE case computes calcParams[0] slope only; no MA branch).

- [ ] **Step 3: Write minimal implementation**

`backtestSeries.ts` — imports: `import { slopeLineSeries, inferBarHours, slopeLengths, type SlopeUnit, type SlopeExtend } from "./indicators/slope";` and ensure `maSeries` is imported from `../mtf` (it already is). Replace the SLOPE case in `computeIndicatorRecipe`:
```ts
case "SLOPE": {
  const ext = (r.extend ?? {}) as SlopeExtend;
  const lengths = slopeLengths(r.calcParams);
  const K = lengths.length;
  const line = r.line ?? 0;
  const maType = ext.maType === "sma" ? "sma" : "ema";
  if (line >= K) {
    // MA operand: the raw underlying MA of lengths[line-K] (no slope/smoothing).
    const len = lengths[line - K] ?? lengths[0];
    return maSeries(candles, maType, len, { source: ext.source }).base;
  }
  const len = lengths[line] ?? lengths[0];
  const n = Number(ext.slopePeriod) || 3;
  const units: SlopeUnit = ext.units ?? "pctHr";
  return slopeLineSeries(candles, maType, len, n, units, ext.source, ext.smoothing, inferBarHours(candles));
}
```
> Note: `LINE_KEYS.SLOPE` is NOT needed — the SLOPE case computes directly by line and does not go through `pickLine`. Do not add a SLOPE entry to `LINE_KEYS`.

`backtestConfig.ts` — `operandBaseLen` SLOPE case (place in the series/indicator branch before the generic `return base`, alongside PIVOT_BANDS):
```ts
if (r.indicatorType === "SLOPE") {
  const ext = (r.extend ?? {}) as { slopePeriod?: number; smoothing?: { type?: string; length?: number } };
  const lengths = (r.calcParams ?? []).map(Number).filter((v) => Number.isFinite(v) && v !== 0);
  const K = lengths.length || 1;
  const line = r.line ?? 0;
  if (line >= K) return lengths[line - K] ?? lengths[0] ?? 9; // MA operand: just MA warm-up
  const len = lengths[line] ?? lengths[0] ?? 9;
  const n = Number(ext.slopePeriod) || 3;
  const sm = ext.smoothing && ext.smoothing.type && ext.smoothing.type !== "none" ? (Number(ext.smoothing.length) || 0) : 0;
  return len + n + sm;
}
```

`chartOperand.ts` — `indicatorOutputs` SLOPE returns 2K outputs (slope then MA per length):
```ts
case "SLOPE": {
  const lengths = (Array.isArray(calcParams) ? calcParams : []).map(Number)
    .filter((v) => Number.isFinite(v) && v !== 0).slice(0, 5);
  const ls = lengths.length ? lengths : [9];
  const K = ls.length;
  const slopes = ls.map((len, i) => ({ lineIndex: i, label: `Slope MA ${len}`, ...(i === 0 ? { base: true } : {}) }));
  const mas = ls.map((len, i) => ({ lineIndex: K + i, label: `MA ${len}` }));
  return [...slopes, ...mas];
}
```
Confirm `indicatorToRecipe` snapshots the full `calcParams` (the lengths) + the chosen `line` verbatim for SLOPE (it already does for all types — verify SLOPE isn't special-cased). The recipe's `line` (which may be ≥ K) rides through unchanged; `recipeKey` hashes it so a slope and an MA operand on the same config get distinct `seriesKey`s.

- [ ] **Step 4: Run test** — `npx vitest run src/lib/backtestSeries.test.ts src/lib/backtestConfig.test.ts` → PASS. `npx tsc -b` clean for touched files.

- [ ] **Step 5: Commit** — `git add frontend/src/lib/backtestSeries.ts frontend/src/lib/backtestConfig.ts frontend/src/lib/chartOperand.ts frontend/src/lib/backtestSeries.test.ts && git commit -m "feat(slope): slope + underlying-MA operands per length (2K) + warm-up + parity"`

---

### Task 5: MTF — per-line HTF series

**Files:**
- Modify: `frontend/src/lib/mtfCoordinator.ts` (`applySlopeTimeframe`, refresh branch)
- Test: none automated — verified in Task 7.

**Interfaces:**
- Consumes: `slopeLineSeries`, `inferBarHours`, `slopeLengths`, `SlopeExtend`, `SlopeSmoothing` (Tasks 1-2).

- [ ] **Step 3: Write minimal implementation**

Rework `applySlopeTimeframe`'s `SlopeConfig` and HTF compute to per-line. The config now carries the length LIST + shared params:
```ts
interface SlopeConfig {
  maType: "ema" | "sma";
  lengths: number[];   // calcParams
  slopeN: number;
  units: SlopeUnit;
  smoothing?: SlopeSmoothing;
  options: MaExtend;   // source/offset
}
```
In the HTF branch, compute one series per length and stash `htfSeriesByLine` (drop the old single `htfSeries`):
```ts
const barHours = inferBarHours(htf);
const byLine = config.lengths.map((len) =>
  slopeLineSeries(htf, config.maType, len, config.slopeN, config.units, config.options.source, config.smoothing, barHours));
ext.mtf = {
  timeframe,
  htfStarts: htf.map((b) => b.timestamp),
  htfSeriesByLine: byLine,
  htfMs,
};
```
`fetchHtfBars` warm-up reach-back = `Math.max(...config.lengths) + config.slopeN + (smoothing length)`.
Update the `refreshMtfIndicators` SLOPE branch to build this config from the live instance:
```ts
} else if (type === "SLOPE") {
  const ext = (ind.extendData ?? {}) as SlopeExtend;
  const lengths = slopeLengths(ind.calcParams);
  const slopeN = Number(ext.slopePeriod) || 3;
  const smLen = ext.smoothing && ext.smoothing.type !== "none" ? (Number(ext.smoothing.length) || 0) : 0;
  if (covered(Math.max(...lengths) + slopeN + smLen)) return;
  jobs.push(applySlopeTimeframe(chart, epic, id, paneId, {
    maType: ext.maType === "sma" ? "sma" : "ema",
    lengths, slopeN, units: ext.units ?? "pctHr", smoothing: ext.smoothing,
    options: { source: ext.source, offset: ext.offset },
  }, tf, brokerId, oldestChartMs));
}
```
Import `slopeLineSeries, inferBarHours, slopeLengths, type SlopeUnit, type SlopeExtend, type SlopeSmoothing` from `./indicators/slope`.

- [ ] **Step 4: Verify** — `npx tsc -b` clean for mtfCoordinator.ts; `npx vitest run` full suite green (no regression). Behavior in Task 7.

- [ ] **Step 5: Commit** — `git add frontend/src/lib/mtfCoordinator.ts && git commit -m "feat(slope): MTF per-line HTF slope series"`

---

### Task 6: Settings UI — MA Lengths editor, Smoothing, Color-by-direction

**Files:**
- Modify: `frontend/src/IndicatorSettings.tsx` (SLOPE branch)
- Maybe: `frontend/src/lib/indicatorMeta.ts` (drop the fixed length/slope-period numeric inputs for SLOPE; keep MA Type/Units/Source/Smoothing selects where the generic renderer can handle them)
- Test: none automated — verified in Task 7.

**Interfaces:**
- Consumes: `applySlopeTimeframe` (Task 5); the SLOPE apply path + timeframe state.

- [ ] **Step 3: Write minimal implementation**

In `IndicatorSettings.tsx` SLOPE branch, add a dedicated **MA Lengths** control (the generic `indicatorMeta` inputs can't express a variable list):
- Render one number input per current `calcParams` entry, each with a remove (×) button, plus an "Add length" button disabled at 5. Editing/adding/removing writes the new `calcParams` array via `applySlope({ lengths })` → which calls the SLOPE apply path.
- Add a **Smoothing** row: a type select (None/SMA/EMA) writing `extendData.smoothing.type`, and a length number input (shown when type ≠ none) writing `extendData.smoothing.length`. Use the existing `showWhen` pattern if routing through meta, else inline.
- Add a **Color by direction** checkbox (writes `extendData.colorByDirection`), auto-disabled/greyed when `calcParams.length > 1` (with a tooltip "single line only").
- Slope Period, MA Type, Units, Source: keep as inputs writing `extendData.slopePeriod` / `maType` / `units` / `source`.
- **Figure refresh on length-count change:** after changing `calcParams`, call `chart.overrideIndicator({ name, calcParams, extendData }, paneId)`. **VERIFY in-browser (do this first, before finishing the task):** that adding/removing a length actually changes the number of drawn lines (i.e. `regenerateFigures` re-fires). If it does NOT, implement the fallback: remove and recreate the indicator instance on a length-COUNT change (reuse the app's remove+add helpers in `lib/indicators.ts`, preserving `extendData`), keeping `overrideIndicator` for per-length value/style/param edits. Document which path you used in the report.
- Mirror the Pivot Bands wiring for `applySlope` (the base feature added `applySlope` in Task 6 — extend it to pass `lengths`/`smoothing`, and route the new inputs through it). Persistence still stores only `mtf:{timeframe}` for SLOPE.

- [ ] **Step 4: Verify** — `npx tsc -b` clean; `npx vitest run` green. Full behavior in Task 7.

- [ ] **Step 5: Commit** — `git add frontend/src/IndicatorSettings.tsx frontend/src/lib/indicatorMeta.ts && git commit -m "feat(slope): MA Lengths editor + smoothing + color-by-direction settings"`

---

### Task 7: End-to-end browser verification

**Files:** none (claude-in-chrome; dev server on :5173 — do NOT kill HMR; set a document.title; close the tab when done).

- [ ] Add **MA Slope**. Confirm one green/red line + zero line (N=1 unchanged).
- [ ] Settings → **Add length** to make 3 lengths (e.g. 9, 21, 50). Confirm **3 distinct-colored lines** appear (this is the `regenerateFigures` runtime check — if only 1 line, Task 6's recreate fallback is required). Confirm color-by-direction auto-disables with >1 line.
- [ ] Style tab: confirm 3 line rows; change one line's color/width → chart updates.
- [ ] **Smoothing** → SMA length 5: confirm all lines get smoother; None restores.
- [ ] Remove a length back to 1: confirm it returns to a single green/red line.
- [ ] **Timeframe** → 1H: confirm all lines become stepped HTF series; survives a reload.
- [ ] Backtest chart-operand picker: confirm **two pickable entries per length** — a slope ("MA Slope: Slope MA 9") AND the raw MA ("MA Slope: MA 9"). Add a slope operand and an MA operand → confirm distinct chips. Run backtest → results, no console errors.
- [ ] `cd frontend && npx tsc -b` (no new errors) and `npx vitest run` (all pass).
- [ ] Clean up: remove the test indicator + any rule operands added; close the tab.

---

## Self-review notes (intentional)

- Reshapes the shipped single-line SLOPE (calcParams = lengths; slopePeriod → extend). No migration — no persisted SLOPE rules.
- `regenerateFigures` on a custom per-instance template is the one runtime unknown; Task 6/7 verify it with a documented recreate-on-count-change fallback.
- Color-by-direction is single-line-only (fixed green/red); per-line solid colors are the configurable styles. Configurable up/down direction colors are out of scope.
