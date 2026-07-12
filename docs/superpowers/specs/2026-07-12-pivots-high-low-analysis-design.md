# Pivots High/Low Analysis indicator — design

**Date:** 2026-07-12
**Status:** Approved (design)

Port of the LuxAlgo *"Pivots High/Low Analysis & Forecast"* Pine study into our
klinecharts shell, as a candle-pane overlay indicator, plus exposure of its
computed values as backtest/live rule operands.

## Goal

Give the user a swing-to-swing pivot analysis on the chart — where each new
confirmed pivot high/low is marked, connected back to the previous same-type
pivot, and annotated with how far (Δ%) and how long (Δt) the swing was — and
make the underlying pivot levels/metrics usable as rule operands in backtests
and live trading.

## Scope

**In scope**

- On-chart visuals: pivot markers, Δ connector lines (dotted level + double
  arrow), on-chart Δ%/Δt labels.
- Forward-carried previous-high / previous-low level lines (toggle, default on).
- Editable pivot-high / pivot-low colors; `Length` param.
- Four rule operands: Pivot High, Pivot Low, Δ%, Δt — confirmed-only,
  forward-filled, backtest/live parity.

**Out of scope** (explicitly cut from the original)

- The dashed *forecast* lines (estimated future pivot position from the running
  average bar-spacing).
- The corner *dashboard table* (E[Δt] / E[Δ%]).

## Pivot definition

A fractal pivot with strength `Length` (default **50**): bar `p` is a pivot high
if its high is the maximum of the window `[p − Length, p + Length]`, pivot low if
its low is the minimum. This is the same fractal notion the existing Pivot Bands
indicator uses (`isPivotAt()` in `frontend/src/lib/indicators/pivots.ts`); reuse
it.

Because a pivot depends on `Length` bars to its right, it is only **confirmed** at
bar `p + Length`. The original Pine plots markers at the swing bar via
`offset=-length`; we do the same for *visuals*, but the *operand value* only
becomes available at the confirmation bar (see Operands).

## Component 1 — the indicator

New module `frontend/src/lib/indicators/pivotAnalysis.ts`, following the
Sessions / MA-Slope custom-`draw` pattern. Registered as CustomIndicatorType
`PIVOT_ANALYSIS` (menu label **"Pivots High/Low Analysis"**), overlay on the
candle pane.

### calc

A single pure compute function (shared by the chart, backtest, and live — see
Operands) walks the candles once and produces, per bar, a result object. It
detects confirmed pivots and, for each, records relative to the **previous
same-type pivot**:

- pivot type (high/low) and price,
- previous pivot's bar index and price,
- `Δ% = (price − prevPrice) / prevPrice · 100`,
- `Δt = p − prevIndex` (bars between the two swing bars),
- forward-carried "current level" fields (last confirmed high, last confirmed
  low) for the previous-H/L lines and the price operands.

The first pivot of each type has a marker but no connector/Δ (no prior pivot).

The per-bar result carries both:
- **event fields** at the swing bar `p` (marker + connector geometry + Δ text),
  used only for drawing; and
- **forward-filled level fields** that update at the confirmation bar `p + Length`
  and hold until the next confirmation — used by the previous-H/L lines and the
  operands. This split is what keeps visuals swing-anchored while operands stay
  lookahead-free.

### draw (custom canvas, returns `true` to suppress default figures)

Over the visible range (with a small left/right margin so connectors entering
the viewport still render), using `xAxis.convertToPixel` / `yAxis.convertToPixel`
like MA Slope:

- **Marker** — filled circle at `(p, price)` in the high/low color.
- **Dotted level segment** — horizontal, at the *previous* pivot's price, from `p`
  back to the previous pivot's bar (high/low color).
- **Double-arrow** — vertical line at `p` from previous price to current price,
  **blue `#2157f3`** if the new pivot is higher than the prior same-type pivot,
  **red `#ff1100`** if lower. (This up/down coloring is fixed, matching the
  original.)
- **Δ label** — text block `Δ% : x.xx` / `Δt : n`, drawn above highs, below lows.
- **Previous-H/L lines** (when the toggle is on) — two forward-carried horizontal
  lines tracking the most recent confirmed pivot high and pivot low, each
  extending rightward from its confirmation bar until the next same-type pivot
  replaces it, drawn in the high/low colors.

### Settings (indicatorMeta.ts inputs)

- `Length` — number, default 50 (`calcParam[0]`, min 1).
- `Pivot High color` — color, default `#ff1100` (extendData).
- `Pivot Low color` — color, default `#0cb51a` (extendData).
- `Show previous H/L lines` — boolean, default **true** (extendData).

## Component 2 — rule operands (backtest + live)

Wire the indicator into the chart-operand pipeline exactly as MA Slope / Pivot
Bands do, so its values are selectable in the ChartOperandPicker and computed
identically in backtest and live (`buildSeries` → `computeIndicatorRecipe`).

Touch-points:

- `chartOperand.ts` — add `PIVOT_ANALYSIS` to `SUPPORTED_INDICATORS`, add a human
  label, and an `indicatorOutputs()` case enumerating the four outputs.
- `backtestSeries.ts` — `LINE_KEYS.PIVOT_ANALYSIS = ["pivotHigh", "pivotLow", "deltaPct", "deltaT"]`
  and a `computeIndicatorRecipe()` dispatch case calling the shared compute
  function, then `pickLine(...)`.
- `customIndicators.ts` — export the module + add the template to
  `BASE_TEMPLATES`.

### The four outputs

Each is forward-filled (step series), `undefined` before the first pivot
confirms:

| Output | Value carried forward |
|--------|-----------------------|
| **Pivot High** | last confirmed pivot-high price |
| **Pivot Low** | last confirmed pivot-low price |
| **Δ%** | last swing's % change vs the prior same-type pivot |
| **Δt** | bars between the last two same-type pivots |

### No lookahead — confirmed-only

Critical invariant: a pivot's value first appears at its **confirmation bar**
(`p + Length`), never at the swing bar. Bar `i` only reflects pivots confirmed up
to and including `i`. This matches the Pivot Bands forward-fill (values keyed by
`i + N`) and guarantees backtest results can't use information that wasn't yet
available live. Backtest and live use the same shared compute function, so they
agree bar-for-bar.

MTF: not required for the first cut, but the shared-compute + `LINE_KEYS` shape
leaves the door open to the same HTF `alignHtfToChart(waitClose=true)` treatment
Pivot Bands uses, if wanted later.

## Testing

- Unit test the shared compute function: fractal detection, connector Δ%/Δt
  values, confirmation-lag forward-fill (value absent until `p + Length`), first
  pivot has no connector.
- Registration test (mirrors the slope test): the template registers and exposes
  the expected `LINE_KEYS` / operand outputs.
- Manual chart verification (Playwright/browser): markers, arrows, labels, and
  previous-H/L lines render on a real instrument; toggle hides the lines; colors
  apply.

## Files touched

- **new** `frontend/src/lib/indicators/pivotAnalysis.ts` — compute + template + draw
- `frontend/src/lib/customIndicators.ts` — export + BASE_TEMPLATES
- `frontend/src/lib/indicatorMeta.ts` — title/description/inputs
- `frontend/src/lib/chartOperand.ts` — supported set + label + outputs
- `frontend/src/lib/backtestSeries.ts` — LINE_KEYS + dispatch
- **new** test file(s) under `frontend/src/lib/indicators/` (and a registration test)
