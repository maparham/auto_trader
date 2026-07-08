# Pivot Bands as a backtest rule operand

**Date:** 2026-07-08
**Status:** Approved

## Goal

Make the on-chart **Pivot Bands** indicator usable as an operand in backtest/live
rules, alongside the 7 custom indicators already supported (EMA/MA/LR/VWAP/AVWAP/
PREV_HL/RSI). Today Pivot Bands appears in the strategy-side `ChartOperandPicker`
but is greyed out with "PIVOT_BANDS isn't supported in rules yet".

## Background

Chart indicators become rule operands via a self-contained **recipe**
(`kind: "series"`, see `2026-07-06-chart-operands-in-rules-design.md`). The recipe
snapshots the indicator type, `calcParams`, output `line`, and an `extend` blob;
`buildSeries` (`backtestSeries.ts`) re-runs the SAME pure compute function the
chart uses, so the operand reproduces the exact curve. The backend reads the
precomputed array by `seriesKey` and never sees the indicator type — so adding a
type is **purely frontend**.

Pivot Bands is a natural fit: it's a two-line price-pane indicator (pivotHigh,
pivotLow step-lines), mirroring how LR and Prev H/L already expose multiple
pickable output lines. `computePivotBands` is already pure in `candles`.

## Scope

Frontend only. No backend change. No new data model. Both output lines pickable.
MTF (higher-timeframe operand) works automatically. `source` ("hl" vs a single
PriceSource) and `mode` ("last"/"avg") snapshot into the recipe `extend`.

## Changes

### 1. `backtestConfig.ts`
- Add `"PIVOT_BANDS"` to the `SeriesIndicatorType` union.
- Warm-up: special-case `operandBaseLen` for `PIVOT_BANDS` to return
  `2*N + K` (N = `calcParams[0]`, K = `calcParams[1]`, each clamped `>= 1`),
  matching the chart's established "2N+K best-effort" reach-back. NOT added to
  `SERIES_LENGTH_TYPES` (that reserves only N). Best-effort — a blank left edge is
  correct, not a bug (pivots are sparse; no fixed reach-back guarantees one).

### 2. `chartOperand.ts`
- Add `"PIVOT_BANDS"` to `SUPPORTED_INDICATORS` — flips the picker row from greyed
  to enabled (enumeration has no independent allowlist; `chartOperandSources`
  decides).
- `indicatorOutputs` case for `PIVOT_BANDS`: return two lines —
  `{lineIndex:0, "Pivot High"}` and `{lineIndex:1, "Pivot Low"}` — **neither marked
  `base`** (mirror PREV_HL), so chips read "Pivot Bands: Pivot High" / "…: Pivot
  Low". Both lines are always present (Pivot Bands has no per-line style-hide).
- `recipeLabel` special-case → `"Pivot Bands"` (else it reads `PIVOT_BANDS(5, 3)`).
- The existing `sanitizeExtend` already strips `mtf`/`lineHidden`/etc and keeps
  `mode`/`source`, so `indicatorToRecipe`'s generic branch handles the recipe
  `extend` with no change.

### 3. `backtestSeries.ts`
- `LINE_KEYS.PIVOT_BANDS = ["pivotHigh", "pivotLow"]` (figure order).
- `computeIndicatorRecipe` case for `PIVOT_BANDS`: call
  `computePivotBands(candles, Math.max(1, N||5), Math.max(1, K||3), ext)` and
  `pickLine` the selected output. **Params MUST be clamped exactly like the chart
  template** (`Math.max(1, …||default)`) — the loose `?? 0` other cases use would
  give `N=0`, breaking `isPivotAt` and diverging from the on-chart curve.

## MTF

Comes for free. `buildSeries` fetches the higher-timeframe candles, runs
`computePivotBands` on them natively (no `ext.mtf`), and forward-fills with
`alignHtfToChart(waitClose=true)` — the same path as EMA/MA. The chart's MTF
coordinator (`applyPivotBandsTimeframe`) is NOT involved in the rule path.

Known below-noise caveat: the chart coordinator computes HTF pivots passing only
`{mode}`, so if it drops `source`, an MTF operand with a non-default `source` could
differ between chart and rule. Not chased in this task.

## Testing

Add a vitest mirroring the LR/PREV_HL recipe tests:
- Both lines (`pivotHigh`, `pivotLow`) resolve to real step-line values.
- Params clamp (N=0 in the recipe still computes as N=1, parity with chart).
- One MTF case (operand on a higher timeframe forward-fills onto base bars).

Baseline: vitest 534 passing / 50 skipped must not regress.

## Out of scope

- SESSIONS operand (still deferred — no price line).
- Any backend change.
- LiveTradingPanel picker controller (already a known deferred follow-up for all
  chart operands).
