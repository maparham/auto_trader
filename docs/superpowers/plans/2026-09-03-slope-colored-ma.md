# Slope-Colored Moving Averages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Opt-in per-instance coloring of the EMA/MA/VWAP/AVWAP main line by slope state (rising / falling / flat), each state with its own color + width + dash, configured from a new gated "Slope" tab in the indicator settings modal.

**Architecture:** A pure classifier (`slopeStates`) maps plotted main-line values to per-bar states using the spec's %/bar formula; `calc` attaches the state to each result point (MTF-safe: states are computed on the native HTF series and forward-filled, never on the aligned staircase). A custom klinecharts `draw` — modeled directly on the in-repo `drawSlope` (`src/lib/indicators/slope.ts:363`) — returns `false` (zero cost, byte-identical rendering) when disabled, and when enabled returns `true` to suppress the default figure lines, strokes the main line segment-by-segment styled by state, and repaints the template's other figure lines (smoothing/envelope/AVWAP bands) with their normal resolved styles.

**Tech Stack:** React 18 + TypeScript, klinecharts 10.0.0, vitest (node env, klinecharts stubbed via `vi.mock`).

**Spec:** `docs/superpowers/specs/2026-07-06-slope-colored-ma-design.md`

## Rulings (spec-vs-code deltas, decided at plan time)

1. **Draw suppression**: the spec preferred transparent-main-line via style overrides and distrusted the "draw returns true skips default figures" contract. That contract is proven in-repo (`drawSlope` at `slope.ts:445` relies on it, klinecharts 10). Ruling: use `return true` + repaint the sibling figure lines ourselves — one code path, no style-override plumbing across apply sites. Cost if wrong: sibling lines (smoothing/bands) render differently than default.
2. **Theme-aware defaults**: no indicator `draw` in the codebase has theme access; the house convention is theme-neutral constants (`sessions.ts:35`, `chartTheme.ts` exports `UP`/`DOWN` for exactly this reuse). Ruling: defaults are `UP` (#26a69a), `DOWN` (#ef5350), flat #9598A1 — no theme resolution.
3. **`slopeOf`** no longer exists in `backtestSeries.ts` (removed with series-shipping). The classifier re-derives the spec's %/bar formula as a new pure function; it deliberately does NOT reuse `slopeWithUnits` (that is %/hr with unit modes — different vocabulary).

## Global Constraints

- `extendData.slopeColor` absent or `enabled: false` ⇒ rendering byte-identical to today (draw returns `false` immediately; no state computation in calc).
- Slope formula (spec, %/bar): `slope[i] = (v[i] − v[i−N]) / |v[i−N]| / N × 100`; undefined (warm-up `i < N`, `v[i]`/`v[i−N]` missing, or `v[i−N] === 0`) → flat/base look. `|slope| ≤ flatBandPct` → flat; `> flatBandPct` → rising; `< −flatBandPct` → falling. Defaults: `len = 1` (min 1), `flatBandPct = 0.1` (min 0).
- MTF MAs: states computed on `ext.mtf.htfSeries` (native HTF values) then forward-filled via the existing `alignHtfToChart` with the same `waitClose`/`formingIdx` arguments — NEVER computed on the aligned staircase.
- Only the main line is slope-colored (`ma` for EMA/MA, `vwap` for VWAP/AVWAP); smoothing line, envelope bands, and AVWAP bands keep their existing styles.
- The draw must use only `yAxis.convertToPixel` / `bounding` / `xAxis.convertToPixel` (never `chart.convertToPixel`) — inset-wrapper compatibility (`src/lib/indicators/inset.ts` substitutes these).
- New modal state MUST be added to both `currentConfig()` (IndicatorSettings.tsx:894) and the persistence effect's dependency array (IndicatorSettings.tsx:1015), or edits silently don't persist.
- Node-env tests stub klinecharts with `vi.mock` and use top-level `await import(...)` (pattern: `src/lib/indicators/ma.test.ts:1-16`).
- Baseline to keep green: `cd frontend && npm run test:unit` (3855 tests) and `npx tsc -b` (88 pre-existing errors — add none).
- All paths relative to `frontend/` unless noted. Commit after each task.

---

### Task 1: Classifier + config types (`src/lib/indicators/slopeColor.ts`)

**Files:**
- Create: `src/lib/indicators/slopeColor.ts`
- Test: `src/lib/indicators/slopeColor.test.ts`

**Interfaces (Produces — later tasks import these exactly):**

```ts
export type SlopeState = -1 | 0 | 1; // falling | flat | rising
export interface SlopeStateStyle {
  color: string;                       // hex or rgba
  size?: number;                       // px; absent → main line's resolved width
  style?: "solid" | "dashed" | "dotted"; // absent → solid
}
export interface SlopeColorConfig {
  enabled: boolean;
  len: number;          // lookback N, min 1
  flatBandPct: number;  // ± flat band in %/bar, min 0
  up: SlopeStateStyle;
  down: SlopeStateStyle;
  flat: SlopeStateStyle;
}
export function defaultSlopeColor(): SlopeColorConfig;
export function slopeStates(
  values: Array<number | undefined>,
  len: number,
  flatBandPct: number,
): Array<SlopeState | undefined>; // undefined = warm-up/base look
```

- [ ] **Step 1: Write the failing tests**

Create `src/lib/indicators/slopeColor.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";

vi.mock("klinecharts", () => ({
  LineType: { Solid: "solid", Dashed: "dashed" },
  IndicatorSeries: { Normal: "normal", Price: "price" },
  registerIndicator: () => {},
}));

const { slopeStates, defaultSlopeColor } = await import("./slopeColor");

describe("slopeStates", () => {
  it("classifies rising / falling / flat around the band edges", () => {
    // len=1, band=0.1 %/bar. 100→100.2 = +0.2%/bar rising; →99.8 = falling;
    // →100.05 = +0.05% flat; exactly ±0.1% is flat (≤ band).
    const v = [100, 100.2, 100, 99.8, 99.8, 99.85, 99.85, 99.95];
    const s = slopeStates(v, 1, 0.1);
    expect(s[0]).toBeUndefined(); // warm-up
    expect(s[1]).toBe(1);   // +0.2 %/bar
    expect(s[2]).toBe(-1);  // -0.199... %/bar
    expect(s[3]).toBe(-1);
    expect(s[4]).toBe(0);   // 0 %/bar
    expect(s[5]).toBe(0);   // ~+0.063 %/bar within band
    expect(s[6]).toBe(0);
    expect(s[7]).toBe(0);   // ~+0.1002? no: (99.95-99.85)/99.85 = 0.1002% > 0.1 → recheck below
  });

  it("treats exactly the band edge as flat", () => {
    // (100.1 - 100)/100/1*100 = exactly 0.1 → flat (≤ band).
    expect(slopeStates([100, 100.1], 1, 0.1)[1]).toBe(0);
  });

  it("divides by N so the band is stable as lookback grows", () => {
    // 100 → 100.4 over 2 bars = 0.2 %/bar with len=2.
    const s = slopeStates([100, 100.2, 100.4], 2, 0.1);
    expect(s[0]).toBeUndefined();
    expect(s[1]).toBeUndefined(); // i < N
    expect(s[2]).toBe(1);
  });

  it("returns undefined for missing values and zero denominators", () => {
    const s = slopeStates([0, 5, undefined, 6, 7], 1, 0.1);
    expect(s[1]).toBeUndefined(); // v[i-1] === 0
    expect(s[2]).toBeUndefined(); // v[i] missing
    expect(s[3]).toBeUndefined(); // v[i-1] missing
    expect(s[4]).toBe(1);
  });

  it("flatBandPct 0 collapses to 2-state (any nonzero slope colors)", () => {
    const s = slopeStates([100, 100.0001, 100.0001], 1, 0);
    expect(s[1]).toBe(1);
    expect(s[2]).toBe(0); // exactly zero slope stays flat even at band 0
  });
});

describe("defaultSlopeColor", () => {
  it("is disabled with spec defaults", () => {
    const d = defaultSlopeColor();
    expect(d.enabled).toBe(false);
    expect(d.len).toBe(1);
    expect(d.flatBandPct).toBe(0.1);
    expect(d.up.color).toBe("#26a69a");
    expect(d.down.color).toBe("#ef5350");
    expect(d.flat.color).toBe("#9598A1");
  });
});
```

Note on the first test's last expectation: `(99.95 − 99.85)/99.85 × 100 = 0.10015…% > 0.1` → that IS rising. Fix the expectation to `expect(s[7]).toBe(1);` when transcribing — the inline comment chain above is the authority, recompute each value and make the assertions match the formula exactly (the executor must verify each expected value by hand; the formula, not this prose, is the source of truth).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/lib/indicators/slopeColor.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/lib/indicators/slopeColor.ts` (types verbatim from Interfaces above, plus):

```ts
// Slope-state coloring for the moving-average family (EMA/MA/VWAP/AVWAP):
// classify the plotted main line per bar as rising / falling / flat and let a
// custom draw stroke each segment in that state's style. Config lives in
// extendData.slopeColor per instance; absent/disabled changes nothing.
//
// Slope is %/bar over a lookback of N bars (the spec's portable definition —
// NOT lib/indicators/slope.ts's %/hr vocabulary):
//   slope[i] = (v[i] − v[i−N]) / |v[i−N]| / N × 100
// Warm-up (i < N), missing values, and a zero denominator yield undefined —
// drawn with the flat/base look.
import { UP, DOWN } from "../chartTheme";

const FLAT_DEFAULT = "#9598A1"; // matches slope.ts's ZERO_LINE neutral grey

export function defaultSlopeColor(): SlopeColorConfig {
  return {
    enabled: false,
    len: 1,
    flatBandPct: 0.1,
    up: { color: UP },
    down: { color: DOWN },
    flat: { color: FLAT_DEFAULT },
  };
}

export function slopeStates(
  values: Array<number | undefined>,
  len: number,
  flatBandPct: number,
): Array<SlopeState | undefined> {
  const n = Math.max(1, Math.floor(len));
  return values.map((v, i) => {
    const prev = values[i - n];
    if (i < n || v == null || prev == null || prev === 0) return undefined;
    const slope = ((v - prev) / Math.abs(prev) / n) * 100;
    if (Math.abs(slope) <= flatBandPct) return 0;
    return slope > 0 ? 1 : -1;
  });
}
```

Check `../chartTheme` exports `UP`/`DOWN` (it does — `chartTheme.ts:24-25`); if the relative path from `src/lib/indicators/` differs, fix the import (chartTheme lives at `src/lib/chartTheme.ts`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/lib/indicators/slopeColor.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/indicators/slopeColor.ts frontend/src/lib/indicators/slopeColor.test.ts
git commit -m "feat(chart): slope-state classifier and config types for slope-colored MAs"
```

---

### Task 2: Attach states in calc (MA family + VWAP/AVWAP), MTF-safe

**Files:**
- Modify: `src/lib/indicators/ma.ts` (`MaPoint` ~line 18, `computeMa` ~line 104)
- Modify: `src/lib/indicators/vwap.ts` (`AvwapExtend` ~line 35, the two templates' `calc`)
- Test: extend `src/lib/indicators/slopeColor.test.ts` (or `ma.test.ts` conventions — put MTF tests where `computeMa` is already tested: `src/lib/indicators/ma.test.ts`)

**Interfaces:**
- Consumes: `slopeStates`, `SlopeState`, `SlopeColorConfig` from `./slopeColor` (Task 1); existing `alignHtfToChart(chartTs, htfBars, values, htfMs, waitClose, formingIdx)` from `../mtf`.
- Produces: `MaPoint.slopeState?: SlopeState` and (vwap.ts) `slopeState?: SlopeState` on result points; `MaExtend.slopeColor?: SlopeColorConfig` and `AvwapExtend.slopeColor?: SlopeColorConfig`. Task 3's draw reads `result[i].slopeState`.

- [ ] **Step 1: Write the failing tests** (in `src/lib/indicators/ma.test.ts`, following its existing stub header and `vbars` fixture)

```ts
describe("computeMa slopeState", () => {
  it("attaches per-bar states when slopeColor is enabled", () => {
    const bars = vbars([100, 101, 102, 101.9, 101.9]); // adapt to vbars' actual signature
    const pts = computeMa(bars, "sma", 1, {
      slopeColor: { enabled: true, len: 1, flatBandPct: 0.1,
        up: { color: "#0f0" }, down: { color: "#f00" }, flat: { color: "#999" } },
    } as MaExtend);
    // SMA(1) === close, so states follow the closes directly.
    expect(pts[1].slopeState).toBe(1);
    expect(pts[3].slopeState).toBe(-1);
    expect(pts[4].slopeState).toBe(0);
  });

  it("attaches nothing when slopeColor is absent or disabled", () => {
    const bars = vbars([100, 101, 102]);
    const pts = computeMa(bars, "sma", 1, {} as MaExtend);
    expect(pts.every((p) => p.slopeState === undefined)).toBe(true);
  });

  it("MTF: computes states on the native HTF series, then forward-fills the STATE (anti-staircase)", () => {
    // A steadily-rising HTF EMA held across many chart bars must be `rising`
    // across the whole held span — never flat-within-bar/flip-at-boundary.
    const chartTs = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => i * 60_000); // 1m bars
    const bars = chartTs.map((t) => ({ timestamp: t, open: 1, high: 1, low: 1, close: 1, volume: 0 })) as never;
    const htfMs = 4 * 60_000;
    const pts = computeMa(bars, "ema", 9, {
      mtf: {
        timeframe: "HOUR", // any truthy value; the mtf block below is what matters
        htfStarts: [-2 * htfMs, -htfMs, 0],       // two CLOSED HTF bars before the chart + one at 0
        htfSeries: [100, 101, 102],               // steadily rising natively
        htfMs,
      },
      slopeColor: { enabled: true, len: 1, flatBandPct: 0.1,
        up: { color: "#0f0" }, down: { color: "#f00" }, flat: { color: "#999" } },
    } as MaExtend);
    // Every chart bar holding a closed HTF value whose native slope was rising
    // reads rising — the staircase artifact would make these 0.
    const held = pts.map((p) => p.slopeState).filter((s) => s !== undefined);
    expect(held.length).toBeGreaterThan(0);
    expect(held.every((s) => s === 1)).toBe(true);
  });
});
```

Adapt fixture construction to `vbars`' real signature (read `src/lib/testBars.ts` first) and to how `computeMa`'s MTF branch consumes `mtf.timeframe` — the branch at `ma.ts:112` requires `mtf?.timeframe && mtf.htfSeries && mtf.htfStarts && mtf.htfMs` all truthy. The assertions' SHAPE (rising across held spans; no flat-within-bar artifact) is the requirement.

Also add a small vwap test (in `src/lib/indicators/vwap.test.ts` if it exists, else alongside in ma.test.ts is wrong — create `vwap` cases in `slopeColor.test.ts` using the AVWAP template's `calc` with a stubbed indicator object): enabled slopeColor on AVWAP attaches `slopeState` to points from the anchor forward; disabled attaches nothing.

- [ ] **Step 2: Run to verify they fail** (`npx vitest run src/lib/indicators/ma.test.ts` — new cases fail: `slopeState` undefined).

- [ ] **Step 3: Implement**

In `src/lib/indicators/ma.ts`:
- Add to `MaPoint`: `slopeState?: SlopeState;` and to `MaExtend`: `slopeColor?: SlopeColorConfig;` (import types from `./slopeColor`).
- In `computeMa`, MTF branch: after computing `aligned`, when `ext.slopeColor?.enabled`, compute `const states = slopeStates(mtf.htfSeries, ext.slopeColor.len, ext.slopeColor.flatBandPct)` then align the STATES with the exact same call shape used for values — `alignHtfToChart(chartTs, htfBars, states as Array<number | undefined>, mtf.htfMs, true, mtf.formingIdx)` — and attach `slopeState: alignedStates[i] as SlopeState | undefined` to each returned point.
- Chart-TF branch: when enabled, `const states = slopeStates(base, ...)` (base = plotted values incl. offset) and attach per point.
- Zero work when `!ext.slopeColor?.enabled` (don't even call `slopeStates`).

In `src/lib/indicators/vwap.ts`:
- Add `slopeColor?: SlopeColorConfig;` to `AvwapExtend`.
- In `vwapFrom` (or immediately after it in both templates' `calc`), when `ext.slopeColor?.enabled`, compute states over the produced `vwap` values (`points.map(p => p.vwap)`) and attach `slopeState` per point. Prefer doing it once inside `vwapFrom` since both templates share it.

- [ ] **Step 4: Run tests** — new cases green; then the full `ma.test.ts`/`vwap` suites; then `npm run test:unit` and `npx tsc -b` (no new errors).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/indicators/ma.ts frontend/src/lib/indicators/vwap.ts frontend/src/lib/indicators/ma.test.ts frontend/src/lib/indicators/slopeColor.test.ts
git commit -m "feat(chart): calc attaches MTF-safe slope states to MA/VWAP points"
```

---

### Task 3: The draw — segment-by-state main line + sibling figure repaint

**Files:**
- Modify: `src/lib/indicators/slopeColor.ts` (add the draw factory)
- Modify: `src/lib/indicators/ma.ts` (add `draw` to both templates)
- Modify: `src/lib/indicators/vwap.ts` (add `draw` to both templates)
- Test: extend `src/lib/indicators/slopeColor.test.ts` (pure helpers only; pixels are Task 5's manual check)

**Interfaces:**
- Consumes: `result[i].slopeState` (Task 2), `IndicatorDrawParams` from klinecharts, style precedence chain `indicator.styles?.lines[i] ?? chart.getStyles().indicator?.lines[i] ?? fallback` (pattern: `slope.ts:407-410`).
- Produces: `export function makeSlopeColorDraw(mainKey: string): (params: IndicatorDrawParams<Record<string, unknown>, unknown, unknown>) => boolean`.

- [ ] **Step 1: Write the failing test for the batching helper**

Add to `slopeColor.test.ts`:

```ts
const { segmentRuns } = await import("./slopeColor"); // add to the existing awaited import

describe("segmentRuns", () => {
  it("batches consecutive same-state segments, styling each segment by its NEWER endpoint", () => {
    // states:      u  u  d  d  u        (u=1, d=-1)
    // segments:    [0-1]u [1-2]d [2-3]d [3-4]u
    const runs = segmentRuns([1, 1, -1, -1, 1], 0, 5);
    expect(runs).toEqual([
      { state: 1, from: 0, to: 1 },
      { state: -1, from: 1, to: 3 },
      { state: 1, from: 3, to: 4 },
    ]);
  });
  it("maps undefined (warm-up) to flat (0)", () => {
    expect(segmentRuns([undefined, 1], 0, 2)).toEqual([{ state: 1, from: 0, to: 1 }]);
    expect(segmentRuns([undefined, undefined, 1], 0, 3)).toEqual([
      { state: 0, from: 0, to: 1 },
      { state: 1, from: 1, to: 2 },
    ]);
  });
});
```

(First case of the second test: the only segment [0,1] takes state from endpoint 1 which is defined → 1. Second case: segment [0,1] endpoint undefined → flat 0; segment [1,2] → 1.)

- [ ] **Step 2: Run to verify FAIL** (`segmentRuns` not exported).

- [ ] **Step 3: Implement in `slopeColor.ts`**

```ts
export interface SegmentRun { state: SlopeState; from: number; to: number }

/** Batch index segments [i-1, i] (for i in (from, to)) into runs of equal
 *  state, each segment styled by its NEWER endpoint's state; undefined
 *  (warm-up) renders as flat. `from`/`to` follow chart.getVisibleRange(). */
export function segmentRuns(
  states: Array<SlopeState | undefined>,
  from: number,
  to: number,
): SegmentRun[] {
  const runs: SegmentRun[] = [];
  for (let i = Math.max(from, 1); i < to && i < states.length; i++) {
    const s: SlopeState = states[i] ?? 0;
    const last = runs[runs.length - 1];
    if (last && last.state === s && last.to === i - 1) last.to = i;
    else runs.push({ state: s, from: i - 1, to: i });
  }
  return runs;
}
```

Then the draw factory (modeled on `drawSlope`, `slope.ts:363-445` — read it first):

```ts
const DASH: Record<NonNullable<SlopeStateStyle["style"]>, number[]> = {
  solid: [], dashed: [4, 4], dotted: [1, 3],
};

/** Custom draw for slope-colored MAs. mainKey is the slope-colored figure
 *  ("ma" for EMA/MA, "vwap" for VWAP/AVWAP). Disabled → return false: the
 *  default figure rendering runs untouched. Enabled → return true (suppresses
 *  ALL default figure lines — proven contract, see drawSlope) and paint:
 *  the main line per state-run, every other figure line in its normal
 *  resolved style. Uses only xAxis/yAxis.convertToPixel + bounding, so the
 *  inset wrapper's axis substitution keeps working. */
export function makeSlopeColorDraw(mainKey: string) {
  return (params: /* IndicatorDrawParams — import type from klinecharts */): boolean => {
    const { ctx, chart, indicator, xAxis, yAxis } = params;
    const ext = (indicator.extendData ?? {}) as { slopeColor?: SlopeColorConfig };
    const sc = ext.slopeColor;
    if (!sc?.enabled) return false;

    const result = (indicator.result ?? []) as Array<Record<string, unknown> & { slopeState?: SlopeState }>;
    const { from, to } = chart.getVisibleRange();
    const overrides = indicator.styles?.lines ?? [];
    const defaults = chart.getStyles().indicator?.lines ?? [];
    const figures = (indicator.figures ?? []) as Array<{ key: string }>;
    const mainIdx = Math.max(0, figures.findIndex((f) => f.key === mainKey));
    const resolvedMainSize = overrides[mainIdx]?.size ?? defaults[mainIdx]?.size ?? 1;

    ctx.save();

    // 1. Non-main figure lines, normal styles (smoothing / envelope / bands).
    figures.forEach((f, fi) => {
      if (f.key === mainKey) return;
      const color = overrides[fi]?.color ?? defaults[fi]?.color;
      if (!color) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = overrides[fi]?.size ?? defaults[fi]?.size ?? 1;
      const st = overrides[fi]?.style ?? defaults[fi]?.style;
      const dv = overrides[fi]?.dashedValue ?? defaults[fi]?.dashedValue ?? [4, 4];
      ctx.setLineDash(st === "dashed" ? dv : st === "dotted" ? [1, 3] : []);
      let started = false;
      ctx.beginPath();
      for (let i = Math.max(from, 0); i < to && i < result.length; i++) {
        const v = result[i]?.[f.key];
        if (typeof v !== "number") { started = false; continue; }
        const x = xAxis.convertToPixel(i);
        const y = yAxis.convertToPixel(v);
        if (started) ctx.lineTo(x, y);
        else { ctx.moveTo(x, y); started = true; }
      }
      ctx.stroke();
      ctx.setLineDash([]);
    });

    // 2. Main line, per-state runs.
    const styleOf = (s: SlopeState): SlopeStateStyle =>
      s === 1 ? sc.up : s === -1 ? sc.down : sc.flat;
    const states = result.map((p) => p?.slopeState);
    for (const run of segmentRuns(states, from, to)) {
      const st = styleOf(run.state);
      ctx.strokeStyle = st.color;
      ctx.lineWidth = st.size ?? resolvedMainSize;
      ctx.setLineDash(DASH[st.style ?? "solid"]);
      let started = false;
      ctx.beginPath();
      for (let i = run.from; i <= run.to; i++) {
        const v = result[i]?.[mainKey];
        if (typeof v !== "number") { started = false; continue; }
        const x = xAxis.convertToPixel(i);
        const y = yAxis.convertToPixel(v);
        if (started) ctx.lineTo(x, y);
        else { ctx.moveTo(x, y); started = true; }
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();
    return true;
  };
}
```

Type the params against klinecharts' `IndicatorDrawParams` (import type; see `slope.ts`'s signature for the generic arguments idiom). AVWAP's `lineHidden` calc-omission means hidden figures simply have no values — the generic loop skips them naturally.

Wire it up:
- `ma.ts`: add `draw: makeSlopeColorDraw("ma"),` to `EMA_TEMPLATE` and `MA_TEMPLATE` (import from `./slopeColor`).
- `vwap.ts`: add `draw: makeSlopeColorDraw("vwap"),` to `VWAP_TEMPLATE` and `AVWAP_TEMPLATE`.

Note: `cloneTemplateFromLive` (`lib/indicators.ts:458`) copies `draw`, so per-instance clones inherit it — nothing else to register.

- [ ] **Step 4: Run tests** — `npx vitest run src/lib/indicators/slopeColor.test.ts src/lib/indicators/ma.test.ts src/lib/indicators/slope.test.ts`, then full suite + `npx tsc -b` (no new errors).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/indicators/slopeColor.ts frontend/src/lib/indicators/slopeColor.test.ts frontend/src/lib/indicators/ma.ts frontend/src/lib/indicators/vwap.ts
git commit -m "feat(chart): slope-colored draw for EMA/MA/VWAP/AVWAP main lines"
```

---

### Task 4: Settings modal — gated "Slope" tab

**Files:**
- Create: `src/indicatorSettings/SlopeColorPanel.tsx`
- Test: `src/indicatorSettings/SlopeColorPanel.test.tsx` (jsdom) + writer test in `src/indicatorSettings/panelWriters.test.ts` if that file covers writers (read it; else test the writer in the panel test file)
- Modify: `src/IndicatorSettings.tsx` (Tab union ~182, tab bar ~1580-1592, panel gating ~1685, state + live-apply, `currentConfig()` ~894-1003, dep array ~1015)

**Interfaces:**
- Consumes: `SlopeColorConfig`, `defaultSlopeColor` (Task 1); `ColorLineStylePicker` (`src/ColorLineStylePicker.tsx`, props at :25-43: `color/onColor/opacity/onOpacity/size/onSize/lineStyle/onLineStyle`); `IntInput` (`src/indicatorSettings/shared.tsx:143`); `parseColor`/`toColor` (`shared.tsx:126-141`); `InfoTip`.
- Produces:

```ts
// SlopeColorPanel.tsx
export function slopeColorConfig(
  extendData: Record<string, unknown>,
  sc: SlopeColorConfig | null,
): void; // writes extendData.slopeColor only when sc differs from defaults or is enabled; deletes otherwise
export default function SlopeColorPanel(props: {
  sc: SlopeColorConfig;
  patch: (p: Partial<SlopeColorConfig>) => void; // shallow merge; nested state styles passed whole
}): JSX.Element;
```

- [ ] **Step 1: Write the failing panel + writer tests**

`src/indicatorSettings/SlopeColorPanel.test.tsx` (top line `// @vitest-environment jsdom`; mirror `MaAvwapPanels.test.tsx`'s setup — read it first for the render/query idioms):
- renders the Enable checkbox (`.ind-check input`), Lookback `IntInput`, Flat band number input with a "%/bar" hint, and three picker rows labeled Rising / Falling / Flat;
- toggling Enable calls `patch({ enabled: true })`;
- committing Lookback calls `patch({ len: <n> })` and the input enforces min 1;
- changing the Rising color calls `patch({ up: { ...sc.up, color: <hex-or-rgba> } })`.

Writer test (same file or `panelWriters.test.ts` per its conventions):
- `slopeColorConfig(ext, null)` and `slopeColorConfig(ext, defaultSlopeColor())` leave `ext.slopeColor` absent (and delete a pre-existing one);
- an enabled config, or a disabled-but-customized one, is written verbatim.

- [ ] **Step 2: Run to verify FAIL.**

- [ ] **Step 3: Implement**

`SlopeColorPanel.tsx` — follow the house panel style (`RsiPanels.tsx` for gated `ind-check${on ? "" : " is-off"}` rows; the Pivot "Rising/Falling" connector rows at `IndicatorSettings.tsx:2523-2551` for the ColorLineStylePicker row shape). Structure:

```tsx
// The "Slope" tab: color the MA's main line by slope state (spec
// 2026-07-06-slope-colored-ma-design.md). Pure controlled panel — all writes
// go through patch(); the modal owns live-apply + persistence.
<div className="ind-row"> ... Enable ind-check + InfoTip ("Color the main line by its slope: rising, falling, or flat within the ± band.") </div>
<div className="ind-row"> Lookback: <IntInput value={sc.len} min={1} disabled={!sc.enabled} commit={(n) => patch({ len: n })} /> </div>
<div className="ind-row"> Flat band ±: <input type="number" min={0} step={0.05} ... /> <span className="ind-note">%/bar</span> </div>
<div className="ind-group">Colors</div>
{(["up","down","flat"] as const).map(...)} // Rising / Falling / Flat rows:
//   <ColorLineStylePicker color={hex} opacity={alpha} size={sc[k].size ?? 1}
//     lineStyle={sc[k].style ?? "solid"} onColor/onOpacity → patch({[k]: {...sc[k], color: toColor(hex, alpha)}})
//     onSize → patch({[k]: {...sc[k], size}}) onLineStyle → patch({[k]: {...sc[k], style}}) disabled={!sc.enabled} />
// parseColor(sc[k].color) → { hex, opacity } for the picker's split props.
```

The flat-band input: keep a string draft while focused (the `IntInput` falsy-zero trap applies to floats too — commit only keystrokes that parse via `Number()`, `>= 0`).

`slopeColorConfig`:

```ts
export function slopeColorConfig(extendData: Record<string, unknown>, sc: SlopeColorConfig | null): void {
  if (sc && (sc.enabled || JSON.stringify(sc) !== JSON.stringify(defaultSlopeColor()))) {
    extendData.slopeColor = sc;
  } else {
    delete extendData.slopeColor;
  }
}
```

`IndicatorSettings.tsx` wiring:
1. `type Tab = "inputs" | "divergence" | "slope" | "style" | "visibility";` (line 182).
2. Gate flag next to the others (~line 230): `const hasSlopeTab = isMa || isAvwap || type === "VWAP";`.
3. Tab list ternary (~1581): build the array with both gates, e.g. `[..."inputs", ...(isRsi ? ["divergence"] : []), ...(hasSlopeTab ? ["slope"] : []), "style", "visibility"]` — keep the label branch (`t === "slope" ? "Slope" : ...`) in the button text expression (~1589).
4. State: `const [slopeColor, setSlopeColor] = useState<SlopeColorConfig>(() => ((ind?.extendData as Record<string, unknown> | undefined)?.slopeColor as SlopeColorConfig | undefined) ?? defaultSlopeColor());` — place near the other extendData-derived state; confirm how sibling state (e.g. `connector`) seeds from `ind` and mirror it exactly, including any re-seed effect on `name` change.
5. Live apply (patchConnector pattern, ~1233):

```ts
  function patchSlopeColor(p: Partial<SlopeColorConfig>) {
    const next = { ...slopeColor, ...p };
    setSlopeColor(next);
    const live = getIndicator(chart, paneId, name) as Indicator | null;
    chart.overrideIndicator({ paneId, name, extendData: { ...((live?.extendData as object) ?? {}), slopeColor: next } });
  }
```

(No key inside `slopeColor` is ever removed — plain merge is safe; `slopeColorConfig` handles the persisted-side delete.)
6. Panel block (~1685 region): `{tab === "slope" && hasSlopeTab && (<SlopeColorPanel sc={slopeColor} patch={patchSlopeColor} />)}`.
7. `currentConfig()`: in the extendData assembly, call `slopeColorConfig(extendData, hasSlopeTab ? slopeColor : null);` before the final return.
8. Append `slopeColor` to the persistence effect's dependency array (line ~1015). This is mandatory — grep the array and add it at the end.
9. Cancel already restores via the original snapshot + `overrideExtend`-style rehydrate paths — verify the Cancel path re-applies `extendData` (it restores the saved config and re-applies; read `restoreOriginal`/Cancel handler and confirm `extendData.slopeColor` rides along; if Cancel only re-applies calcParams/styles, extend it the way it handles other extendData keys).

- [ ] **Step 4: Run** — new tests green; `npm run test:unit` full; `npx tsc -b` no new errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/indicatorSettings/SlopeColorPanel.tsx frontend/src/indicatorSettings/SlopeColorPanel.test.tsx frontend/src/IndicatorSettings.tsx frontend/src/indicatorSettings/panelWriters.test.ts
git commit -m "feat(settings): gated Slope tab for slope-colored moving averages"
```

---

### Task 5: Browser sanity check (verification only)

- [ ] **Step 1:** Run the worktree frontend against the existing backend: `cd frontend && VITE_API_BASE= npm run dev -- --port 5174 --strictPort` (same-origin proxy; the user's own instance owns :5173). Open http://localhost:5174 in a THROWAWAY chart tab (close it when done — app state is shared with the user's workspace).
- [ ] **Step 2:** Verify: add an EMA → Settings → Slope tab present; enable → line renders green on rises, red on falls, grey in the flat band; band/lookback edits re-color live; Style-tab smoothing line + envelope bands still render normally when enabled alongside; legend value, hover, and curve-end label unaffected; disable → byte-identical default line. Set an MTF timeframe (e.g. 4H on a 1H chart) → held spans color by the NATIVE HTF slope (no per-bar flat/flip staircase). AVWAP: place anchor, enable slope color → main curve colors, bands keep their styles. RSI/other indicators: NO Slope tab. Reload → config persists.
- [ ] **Step 3:** Close the test chart tab, kill the dev server, fix anything found (with tests where applicable), commit fixes.
