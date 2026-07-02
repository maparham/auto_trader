# Scale price chart only

## Problem

When an overlay indicator is added to the candle pane and its values reach
beyond the currently visible candles, klinecharts expands the candle-pane price
axis to fit them. The candles get shorter and the chart becomes harder to read.

`YAxisImp.calcRange` (`node_modules/klinecharts/dist/index.esm.js:10294`)
computes the candle pane's min/max over the visible candle high/low **and** every
visible indicator figure. There is no public klinecharts option to change the
scale source, so the fix requires a patch (the repo already patches this exact
function to skip invisible indicators).

## Goal

Give each chart a TradingView-style **"Scale price chart only"** toggle: when on,
the candle-pane y-axis fits the candle OHLC only; overlays no longer expand it and
may clip off-screen. Default on. Persist per chart cell.

## Design

### 1. Range mechanism (klinecharts patch)

Extend the existing `patches/klinecharts+9.8.12.patch` on `YAxisImp.calcRange`:

- Read the flag once, above the `indicators.forEach` loop:
  `var scalePriceOnly = chart._scalePriceOnly === true;`
- Hoist `var inCandle = this.isInCandle();` above the loop (it is currently
  computed after it). `this` is not the axis inside the `function (indicator)`
  callback, so the flag/`inCandle` must be read outside it.
- At the top of the callback, after the `!indicator.visible` guard, add
  `if (scalePriceOnly && inCandle) { return; }`.

Skipping the indicator entirely for range purposes means it contributes nothing
to `min`/`max`, `specifyMin`/`specifyMax`, `shouldOhlc`, or `indicatorPrecision`.
The candle high/low still drives the range via the existing
`shouldCompareHighLow` branch, and precision falls back to the price precision —
both correct for the candle pane.

`calcRange` is the sole auto-range source: it is called only from
`AxisImp.buildTicks` when `_autoCalcTickFlag` is true. Manual price-axis scaling
sets that flag false and bypasses `calcRange`, so the toggle only affects
auto-fit mode — which is the intended scope.

### 2. Flag carrier

The flag lives on the `ChartImp` instance as `chart._scalePriceOnly` (boolean).
`parent.getChart()` inside the patch returns the same `ChartImp` object that
`init()` returns to app code, so app code sets it directly on the controller's
`chart`.

### 3. Persistence

- Default **on** (`true`).
- Persist per cell via `persist.ts` using the existing `ns(scope, suffix)`
  pattern: add `loadScalePriceOnly(scope): boolean` (default `true`) and
  `saveScalePriceOnly(scope, value)` under suffix `scalePriceOnly`.
- Cloned layouts carry the setting automatically: `copyScopeContent` deep-copies
  every `auto-trader.<scope>.*` key by prefix scan, and the new key lives under
  that prefix — no code change needed there.
- Symbol templates intentionally do NOT carry it. A template captures an explicit
  field list (indicators/configs/drawings/avwap); scale-price-only is a per-cell
  viewing preference (like `autoScale`), not part of a symbol's indicator/drawing
  setup, so it stays with the cell rather than following the symbol.

### 4. Wiring

- New `readonly scalePriceOnly = new Signal<boolean>(true)` on the
  `ChartController`, initialized from `loadScalePriceOnly(scope)`.
- On chart init in `ChartCore`, set `chart._scalePriceOnly = scalePriceOnly.value`
  before the first render / before indicators are added.
- Toggle action: flip the signal → `saveScalePriceOnly(scope, next)` →
  `chart._scalePriceOnly = next` → force a range recompute by re-applying the
  current y-axis type (`chart.setStyles({ yAxis: { type } })`, the same path the
  auto-fit double-click uses).

### 5. UI

In `ChartCore.onContextMenu`, the price-axis column currently returns early to
leave native behavior. Instead, when the right-click is over the axis column,
open a `ContextMenu` with a single item, **"Scale price chart only"**, showing a
checkmark icon when on. Clicking it runs the toggle action.

## Testing

Repro the reported case: zoom into a tight recent range, add a long moving
average whose current value sits outside the visible band.

- Flag **on** (default): candles keep their height; the MA may run off the top or
  bottom.
- Flag **off**: the axis expands to include the MA and candles shrink (today's
  behavior).

Also verify the flag persists across reload per cell and travels with a cloned
layout.
