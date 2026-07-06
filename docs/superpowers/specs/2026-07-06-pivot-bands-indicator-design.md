# PivotBands indicator — design

**Date:** 2026-07-06
**Status:** Approved (design), pending implementation plan

## Summary

A new price-pane overlay indicator, **PivotBands**, that plots two step-lines:
a **pivot-high line** and a **pivot-low line**. Each line tracks confirmed
fractal swing points and carries a value forward between swings, reading as a
dynamic support/resistance channel that only moves when a new swing confirms.

Scope for this iteration: **chart visual only**. It is a klinecharts custom
indicator like MA/EMA — not (yet) a backtest/live rule operand. Rule-operand
integration is deferred follow-up work.

## Behavior

### 1. Pivot detection (fractal)

A bar `i` is a **pivot high** if `high[i]` is strictly greater than the highs
of the `N` bars immediately before and the `N` bars immediately after it. A
**pivot low** is the mirror (strictly lower than the `N` lows on each side).

- One parameter: **Strength = N** (default **5**).
- This is the standard TradingView "Pivot High/Low" definition.

The codebase already contains this fractal test inside
`frontend/src/lib/indicators/rsi.ts` (`isPivot(i, "low"|"high")` in
`detectDivergences`). To avoid two definitions of "pivot," extract a small
shared helper (e.g. `frontend/src/lib/indicators/pivots.ts`) exposing something
like `isPivotHigh(dataList, i, n)` / `isPivotLow(dataList, i, n)`, and have both
RSI divergence detection and PivotBands use it. This is a targeted refactor in
service of the feature, not unrelated cleanup.

### 2. Confirmation / no lookahead

A fractal pivot at bar `i` cannot be known until `N` bars later, because it
depends on the `N` bars to its right. PivotBands respects this:

- A pivot at bar `i` becomes **confirmed at bar `i+N`**.
- The relevant line **holds its previous value across bars `i … i+N-1`**, then
  **steps to the new value at bar `i+N`**.
- Consequence: the most recent `N` bars can never contain a confirmed pivot, so
  each line stays flat at the right edge until enough bars close. This is
  expected fractal behavior, not a bug.

This guarantees the curve never uses information unavailable in real time, which
keeps it honest and safe if the indicator is later promoted to a rule operand.

### 3. What the line holds — user option (Mode)

A **Mode** dropdown controls the held value. Both lines use the same mode but
compute independently over their own pivots.

- **Last pivot** (default) — carry the single most recent confirmed pivot-high
  price forward until the next pivot high confirms; mirror for lows. A pure
  swing-level channel. (Equivalent to K = 1.)
- **Average of last K** — hold the average of the most recent **K** confirmed
  pivot-high prices, re-stepping each time a new pivot high confirms; mirror for
  lows. Parameter **K** (default **3**).

The **K** field is only meaningful in "Average" mode. In the settings modal it
is shown/enabled only when Mode = Average (greyed/hidden otherwise).

### 4. Parameters & styling

- `calcParams = [N, K]` — Strength and (average) window.
- **Mode** stored in `extendData` (e.g. `{ mode: "last" | "avg" }`), following
  the existing pattern where complex/non-numeric config lives in `extendData`
  (as MA does for source/smoothing/MTF).
- Two independently styleable lines (color / width / dash), matching how MA
  exposes multiple line styles. Default colors: pivot-high line red-ish, pivot-
  low line green-ish; both solid.
- Precision follows the instrument (same as MA / price-series indicators).

## Architecture & files

Follows the established custom-indicator pattern (see the Explore report and
existing `ma.ts`):

1. **`frontend/src/lib/indicators/pivots.ts`** (new) — shared fractal helpers
   `isPivotHigh` / `isPivotLow`. Refactor `rsi.ts` to use them.
2. **`frontend/src/lib/indicators/pivotBands.ts`** (new) — the indicator
   template: `shortName`, `series: Price` (candle-pane overlay), `precision`,
   `calcParams: [5, 3]`, two `figures` (`pivotHigh`, `pivotLow`),
   default line styles, and a `calc(dataList, ind)` that:
   - scans for confirmed pivots using the shared helper,
   - for each confirmed pivot, records the stepped value at bar `i+N` (last or
     avg-of-last-K per Mode),
   - carries each line's value forward across bars, returning
     `{ pivotHigh?, pivotLow? }` per bar (keys omitted before the first
     confirmation so the lines start blank on the left).
3. **`frontend/src/lib/customIndicators.ts`** — add `"PIVOT_BANDS"` to
   `CustomIndicatorType`, add its template to `BASE_TEMPLATES` (registration is
   automatic via the existing loop).
4. **`frontend/src/lib/indicatorMeta.ts`** — add input defs: Strength (number,
   calcParam[0]), Mode (select, extend `mode`), K (number, calcParam[1], shown
   only when mode = avg). Add menu/label metadata so it appears in the indicator
   dropdown like other custom indicators.
5. **Settings modal** (`IndicatorSettings.tsx`) — no structural change expected;
   it renders from `indicatorMeta`. Verify the conditional visibility of K works
   (may need a small "show when" predicate if the meta layer doesn't already
   support conditional inputs — confirm during implementation).

No backend changes. No `backtestSeries.ts` / `seriesName` changes (deferred).

## Data flow

`calc(dataList, ind)` is called by klinecharts with the full loaded candle list
whenever data changes. It returns one point per bar. klinecharts draws the two
line figures from those points; blanks (omitted keys) render as gaps. Styling
and visibility come from the saved `SavedIndicatorConfig` on the instance id,
restored on reload via the existing `applyIndicator()` path — no new persistence
work.

## Testing

- **Unit (vitest):** test the `calc` output on a small synthetic candle series
  with known pivots:
  - a pivot high at bar `i` produces a step in `pivotHigh` at bar `i+N`, not
    before (no-lookahead assertion);
  - "Last pivot" mode carries the last pivot value; "Average of K" mode holds
    the mean of the last K pivots and re-steps correctly;
  - fewer than K pivots so far → average over however many exist (or blank until
    K exist — decide in plan; default: average over available, matching "moving
    average" intuition);
  - the trailing `N` bars stay flat (no confirmed pivot in the tail).
- **Fractal helper:** unit-test `isPivotHigh/Low` incl. strict-inequality and
  boundary (near array ends) behavior; assert RSI divergence output is unchanged
  after the refactor (regression).
- **Manual (browser):** add PivotBands to a chart, eyeball the step channel,
  toggle Mode, change N and K, restyle lines, reload to confirm persistence.

## Out of scope (deferred)

- Backtest / live **rule operand** integration (series-name contract, param
  encoding on both sides).
- Alternative pivot detection (ATR / % swing / ZigZag).
- Break/retest signals, fills/bands between the two lines, alerts.
