# MA Slope indicator — design

**Date:** 2026-07-10
**Status:** Approved (brainstorming)
**Scope:** Frontend only

## Summary

A new sub-pane chart indicator, `SLOPE` (menu title **"MA Slope"**), that computes
an EMA or SMA and plots **its slope** as a line oscillating around zero. It is also
registered as a **chart-operand type** so the exact plotted line can be picked as a
backtest/live rule operand — riding the existing `kind:"series"` recipe path, so
backtest + live parity is automatic with **zero backend changes**.

This is distinct from the existing `slope()` transform ([[slope-conditions]]), which
slopes any operand in `%/hr` only. The MA Slope indicator bundles MA + slope + a
choice of units + a timeframe into one named, pickable, visual object.

## User-facing behavior

### Chart visual

- Sub-pane indicator (`IndicatorSeries.Normal`), precision 4 (display only — slope
  values are often small fractions, so 4 dp reads better than 2; the raw `.slope`
  value the draw + rule operand consume is full-precision regardless).
- One `slope` figure line, **two-color**: green when slope > 0 (MA rising), red when
  slope < 0 (MA falling), with a **zero reference line**. The two-color split at zero
  crossings is done in a small `draw` callback (mirrors the RSI gradient-draw pattern).

### Settings (all user-editable, via the standard Inputs tab)

| Input | Meaning | Default |
|-------|---------|---------|
| **MA type** | EMA or SMA | EMA |
| **MA length** | bars for the moving average | 9 |
| **Slope period N** | bars over which slope is measured; `N=1` = adjacent-bar slope | 3 |
| **Units** | `%/hr`, `%/bar`, or `price/bar` | `%/hr` |
| **Source** | close / open / hl2 / … (reuse existing MA source field) | close |
| **Timeframe** | MTF selector (blank = chart TF); MA computed on that TF, aligned to chart bars | blank |

## Math

1. Compute the MA with the existing `maSeries()` helper (parity with the real EMA/SMA
   indicator, including MTF).
2. Slope the MA series over `N` bars. Let `ma[i]` be the MA at bar `i`, `prev = ma[i-N]`:
   - `%/bar`  = `(ma[i] - prev) / |prev| / N * 100`
   - `%/hr`   = `(ma[i] - prev) / |prev| / (N * barHours) * 100`  — **reuses the exact
     `slopeOf()` formula in `backtestSeries.ts`** so the chart and the `%/hr` rule value
     agree byte-for-byte.
   - `price/bar` = `(ma[i] - prev) / N`
   - `barHours` = the operand-timeframe's hours-per-bar (`RESOLUTION_SECONDS/3600`).
3. First `N` (+ MA warm-up) bars are `undefined`.

## Rule operand wiring (path b)

Register `SLOPE` as the 9th supported chart-operand type, mirroring the existing 8
([[chart-operands-in-rules]]):

- Add `"SLOPE"` to `SUPPORTED_INDICATORS` in `chartOperand.ts`.
- `indicatorOutputs()` exposes the single slope line (line index 0). Must mirror
  `computeIndicatorRecipe`/the template exactly.
- `computeSeriesRecipe()` in `backtestSeries.ts` computes the **identical** slope array
  from the recipe (same `maSeries` → same slope math → same units), so the recipe value
  matches the plotted line. Because live's `liveEngine.ts` injects this same
  `buildSeries`, **live parity is automatic**.
- **Timeframe** hoists to the operand level via the existing `@tf` suffix mechanism
  (like `indicator`), not nested in the recipe.
- The operand's numeric value **follows the indicator's Units setting** (see divergence
  note below).

No backend changes: `series` operands fall through to the existing series-read in
`rule.py`, and the existing `series_name` D4 key check covers the new key.

## Two flagged behaviors (decided)

1. **Units convention divergence (intentional).** The existing `slope()` transform is
   always `%/hr`. The MA Slope operand can additionally be `%/bar` or `price/bar`. So two
   slope-unit conventions can appear side by side in a rule set. This is deliberate — the
   MA Slope indicator is the units-flexible path. Documented here so it isn't a surprise.

2. **Double-slope (allowed, not guarded).** The Δ slope toggle in the operand picker is
   not hidden for `series` operands, so a user could apply `slope()` to an already-slope
   MA Slope operand (a second derivative / "slope acceleration"). Decision: **leave it
   available** — it's a valid transform and special-casing a hide adds fragility. Noted
   as expected behavior.

## Files touched

- **New** `frontend/src/lib/indicators/slope.ts` — `SlopePoint`, `SlopeExtend`
  (maType, units), `computeSlope()`, `SLOPE_TEMPLATE`, and the two-color/zero-line `draw`.
- `frontend/src/lib/customIndicators.ts` — add `"SLOPE"` to the type union + register.
- `frontend/src/lib/indicatorMeta.ts` — menu title/desc + input field definitions.
- `frontend/src/lib/chartOperand.ts` — add to `SUPPORTED_INDICATORS`, label, and
  `indicatorOutputs()` case.
- `frontend/src/lib/backtestSeries.ts` — add the `SLOPE` case to `computeSeriesRecipe()`
  (reusing `maSeries` + `slopeOf`/unit math).

## Out of scope (v1)

- Degrees / angle units (like the slope drawing tool).
- Colored-MA-overlay variant (slope-tinted MA on the price pane).
- Custom settings-modal panel beyond the auto-generated Inputs tab (add only if the
  generic numeric/select fields prove insufficient).

## References

- [[slope-conditions]] — the `slope()` transform, `slopeOf()`, `%/hr` formula, warm-up,
  MTF-before-forward-fill trap.
- [[chart-operands-in-rules]] — `kind:"series"` recipe path, `computeSeriesRecipe`,
  `indicatorOutputs()` parity contract, ChartOperandPicker.
- [[backtest-timeframes]] — the `@tf` operand-level suffix contract.
