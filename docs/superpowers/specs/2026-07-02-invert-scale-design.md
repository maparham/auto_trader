# Invert chart scale (Option+I) — design

## What

TradingView-style "invert scale": Option+I (Alt+I) flips the focused chart upside
down — the price axis reverses so rising prices draw downward. Pressing it again
flips back. A small toolbar toggle next to the A / L price-scale buttons shows and
controls the same state.

## Decisions

- **Session-only.** Like the log-scale (L) toggle, inversion is NOT persisted;
  a reload shows the chart normal again.
- **Focused cell only.** The shortcut acts on the cell that has keyboard focus,
  same as Delete/copy/paste.
- **Candle pane only.** Sub-panes (RSI/MACD/Volume) keep their normal axis —
  matches TV. klinecharts guarantees this natively: `YAxisImp.isReverse()`
  returns the `yAxis.reverse` style only for the candle pane.

## How

- **Source of truth:** new per-cell `invertScale = Signal<boolean>(false)` on
  `ChartController` (same pattern as `autoScale`). Both the shortcut and the
  toolbar button set the signal; nothing else calls `setStyles` directly.
- **Apply:** ChartCore subscribes to the signal and calls
  `chart.setStyles({ yAxis: { reverse } })`. klinecharts' coordinate conversion
  honors `reverse`, so drawings, alert/trade lines, and all custom DOM/canvas
  overlays (selection handles, bracket, legend, curve labels) flip for free.
  Theme changes re-apply full styles via `klineStyles()`, which never sets
  `reverse`, and `setStyles` deep-merges — so inversion survives theme flips.
- **Shortcut:** in ChartCore's existing per-cell `onKeyDown` (next to
  Delete/copy/paste). Match `e.altKey && e.code === "KeyI"` with no ctrl/meta —
  on macOS Option+I is a dead key (`e.key === "Dead"`), so the physical key code
  is the reliable match. `preventDefault()` when handled.
- **Toolbar button:** next to A / L, lights up (`className="on"`) while
  inverted, tooltip "Invert scale (Option+I)". Reads/subscribes to the focused
  controller's `invertScale` signal so it stays in sync with the shortcut and
  resets correctly when cell focus moves.

## Testing

- Unit: signal toggle drives `setStyles({ yAxis: { reverse } })` (fake chart).
- Playwright e2e: press Option+I → top axis label becomes the LOW price and the
  toolbar button is lit; press again (or click the button) → restored.
