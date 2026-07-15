# Volume-weighted MA types (VWMA + EVWMA)

Date: 2026-07-15
Status: approved

## Goal

Let the MA, EMA, and MA-Slope indicators optionally use volume-weighted
moving-average math. Two new MA kinds:

- **VWMA**: classic rolling volume-weighted average,
  `sum(price x vol, n) / sum(vol, n)`.
- **EVWMA**: LazyBear's elastic volume-weighted MA (TradingView "EVWMA_LB").
  With `nbfs = sum(volume, n)`:
  `v[i] = v[i-1] * (nbfs - vol[i]) / nbfs + vol[i] * price[i] / nbfs`.

Plus the script's **envelope**: optional upper/lower bands that plot the same
MA applied to `high` and `low`.

Out of scope (deliberately):

- The script's "Use Cumulative Volume" mode (curve would depend on how much
  history is loaded).
- New indicator-menu entries. The kinds surface as a Type dropdown on
  existing indicators.
- Native rule operands / Python parity. VWMA/EVWMA reach rules only as
  chart-operand copies (`kind:"series"`), which the browser computes and
  ships; the backend is untouched.

## 1. Math kernel (`frontend/src/lib/mtf.ts`)

Widen `maSeries`'s kind union from `"ema" | "sma"` to
`"ema" | "sma" | "vwma" | "evwma"` and implement both beside `ema`/`sma`.
Every consumer (MA templates, Slope, MTF coordinator, rule recipes) already
goes through `maSeries`, so one implementation gives chart/rule/MTF parity by
construction. `maSeries` already receives full `KLineData` bars, so volume is
available.

Semantics:

- **VWMA**: undefined for the first `n-1` bars and wherever the window's
  volume sum is 0 (follow the `vwap.ts` guard: emit nothing rather than
  garbage on volumeless instruments, whose bars report volume 0).
- **EVWMA**: undefined until the volume window is full. The recursion seeds
  from the source price at the first full-window bar, NOT Pine's `nz -> 0`
  (which draws a near-zero ramp at the left edge of history). Like EMA,
  values near the left edge shift slightly as more history loads; accepted.
  A zero-volume bar naturally holds the prior value
  (`prev * (nbfs - 0)/nbfs + 0 = prev`). If `nbfs` is 0 the bar is undefined
  and the recursion re-seeds at the next usable bar.
- Price comes from the existing `source` option via `priceOf`. `offset` and
  the smoothing sub-MA keep working unchanged. The smoothing sub-MA type
  stays `sma`/`ema` only (`MaOptions.smoothing` is not widened).

## 2. MA / EMA indicators (`ma.ts`, settings modal)

- `MaExtend` gains `maType?: "ema" | "sma" | "vwma" | "evwma"`. Default is
  the template's own kind (EMA template -> ema, MA template -> sma), so
  existing instances and presets are untouched.
- `computeMa` resolves the kind as `ext.maType ?? templateKind`.
- The EMA/MA settings modal gains a Type dropdown (EMA / SMA / VWMA / EVWMA).
- Legend and figure titles follow the chosen type: a flipped instance must
  not keep reading "EMA". Figure titles are per-instance, so the settings
  apply path updates them alongside extendData (regenerateFigures only sees
  calcParams, so the apply path sets figures explicitly or recreates the
  instance, whichever the existing apply flow supports).

### Envelope

- An "Envelope" toggle in the same settings, default off, available for any
  type (the math is uniform: same MA over `high` and `low`).
- Two extra band figures (`bandHi`, `bandLo`) on the MA/EMA templates,
  undefined on every bar when the toggle is off (figure list stays static,
  same trick as `smoothingMa`).
- Defaults: red above, green below (the script's colors); style-editable
  like other lines.
- Bands mirror the base line only: they ignore `offset` and the smoothing
  sub-MA, matching the script.
- Not shown under MTF in v1, same rule as the smoothing MA today (the MTF
  path carries a single precomputed base series).

## 3. Slope indicator (`slope.ts`)

- `SlopeExtend.maType` widens to the 4-kind union.
- The Slope "MA Type" dropdown in `indicatorMeta.ts` gains VWMA and EVWMA.
- Every `ext.maType === "sma" ? "sma" : "ema"` coercion becomes a real 4-way
  mapping. Known sites (the silent fall-back-to-EMA ternaries are the main
  bug hazard):
  - `slope.ts` `slopeShared`
  - `mtfCoordinator.ts` (`SlopeConfig.maType` + the refresh dispatch)
  - `backtestSeries.ts` `computeIndicatorRecipe` (SLOPE case)
  - `IndicatorSettings.tsx` apply path
  - `chartPainters.ts` curve-label pill (`ext.maType === "sma" ? "SMA" :
    "EMA"` must become a label map so VWMA/EVWMA pills read correctly)
- Slope, the accel companion pane, "Show MAs on chart", thresholds, and
  smoothing all work unchanged on top of the new base series.

## 4. Rules / backtest / live

- Chart operands only. `computeIndicatorRecipe`'s EMA/MA case reads `maType`
  from extendData instead of hardcoding the kind from the indicator type;
  the SLOPE case uses the widened mapping.
- `recipeKey` already hashes extendData, so a VWMA and an EMA of the same
  length do not dedup.
- `chartOperand.ts` labels should reflect the chosen type where they name
  the MA kind.
- No change to the native `IndicatorKind` union, `backtestConfig`'s operand
  schema, or any Python.

## 5. MTF

- The coordinator computes `maSeries` on fetched HTF bars, which carry
  volume (`fetchRangeStrict` returns full `KLineData`), so VWMA/EVWMA on a
  higher timeframe works through the existing path.
- `MaConfig.kind` and `SlopeConfig.maType` widen. The
  `type === "EMA" || type === "MA"` refresh gates keep matching because menu
  types do not change.

## 6. Edge cases

- Volumeless instruments (tick candles, brokers reporting 0): whole curve is
  undefined, no crash, no fallback to price.
- A single zero-volume bar inside an otherwise normal window: VWMA excludes
  nothing (sum just gains 0), EVWMA holds the prior value.
- Warm-up: both kinds start at bar `n-1` at the earliest, consistent with
  SMA's warm-up handling, so slope/accel warm-up scaling behaves as today.

## 7. Testing

- Unit tests for `vwma`/`evwma` in the kernel: hand-computed fixtures,
  zero-volume window, warm-up boundary, zero-volume bar holds value, seed
  behavior at the first full window.
- A slope-on-evwma test through `slopeLineSeries`.
- A recipe test asserting the on-chart curve and the rule series match for a
  VWMA instance (parity by construction, verified anyway).
- In-app verification on a real chart: flip an EMA instance to EVWMA, check
  legend label, envelope bands, an MTF case, and a Slope on VWMA including
  its accel pane.
