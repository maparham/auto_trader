# Auto Fib indicator — design

**Date:** 2026-09-25
**Status:** Approved (design), pending implementation plan

## Summary

A new price-pane overlay indicator, **Auto Fib** (`AUTO_FIB`), that draws a
fib retracement between the most recent confirmed pivot high and the most
recent confirmed pivot low. It redraws itself as new pivots confirm, can show
the previous N fibs dimmed, can be pinned to a higher timeframe (MTF), and
exposes its levels as rule operands (backend port + parity golden).

Template to copy throughout: **SR Levels** (`srLevels.ts`, `srLevelsOutputs.ts`,
`sr_levels.py`), the simplest existing MTF overlay that draws levels and is
also a rule operand.

## Behavior

### 1. Pivot detection (same as Trendlines)

- Fractal pivots on wicks (`highs` for pivot highs, `lows` for pivot lows) via
  the shared `isPivotAt(values, k, pivotLen, pivotLen, kind, true)` from
  `lib/indicators/pivots.ts`, exactly as Trendlines calls it.
- A pivot at bar `k` is confirmed at bar `k + pivotLen` (no lookahead, never
  repaints).
- Optional ATR filter `minSwingAtr` (default 0 = off): a pivot only counts when
  the leg from the most recent opposite fractal pivot strictly before `k` is at
  least `minSwingAtr × ATR(14)` at `k`. Exactly Trendlines' `isSignificantSwing`:
  the opposite pool is every raw fractal pivot of the other kind (counted or
  not, Trendlines' `turns`), no earlier opposite pivot rejects, and ATR not yet
  warm at `k` rejects.
- Deliberate difference from Trendlines: with the filter off, pivots count
  from the first bar. Trendlines skips every pivot until ATR(14) is warm at
  the confirm bar; Auto Fib needs no ATR then, so it does not wait.

### 2. Anchors and direction

- State: `lastHigh = {idx, price}` and `lastLow = {idx, price}`, each the most
  recent counted pivot of its kind.
- A **pair** exists once both are set. The pair's anchors are ordered by bar
  index: `earlier` and `later`.
- Level 0 sits at the later anchor, level 1 at the earlier anchor (same as the
  drawing tool); `FibConfig.reverse` swaps them. Price of ratio `r`:
  `p0 + (p1 - p0) * r`, with `p0`/`p1` the level-0/level-1 anchor prices.
- `dir = +1` when the later anchor is the high (an up-leg, retracing down),
  `-1` when the later anchor is the low.
- Tie (a pivot high and a pivot low on the same bar `k`, an outside bar):
  the low is treated as earlier when `close[k] >= open[k]`, else the high. Deterministic, mirrored in Python.
- Every time `lastHigh` or `lastLow` changes once a pair exists, the current
  pair is pushed onto the history and a new pair starts at the confirm bar.

### 3. History (past fibs)

- Setting **Past fibs** `pastCount` (default 0, max 10): the previous N pairs
  are drawn dimmed (`pastOpacity`, a percent, default 35), no labels, no trend
  line.
- A past pair's lines span from its earlier anchor to the confirm bar where it
  was replaced. The current pair spans from its earlier anchor to the last
  bar, then `FibConfig.extend` applies (default for the indicator: `right`).

### 4. Styling

- `extendData.fib` holds a full `FibConfig` (levels with value/enabled/color,
  extend, reverse, trendLine, labels), parsed with the existing `asFibConfig`.
- The levels editor inside `DrawingSettings.tsx` (~688-800) is extracted into a
  shared component (`components/FibLevelsEditor.tsx`); the drawing tool and the
  indicator's Style tab both use it. No behavior change for the drawing tool.
- Drawing: a ctx port of the `fibonacciLine` overlay's figures (level lines,
  per-level color/width/dash, right-edge labels "ratio (price)", dashed trend
  line), reusing `fibLevelSegments` from `fibConfig.ts` for the geometry.
  The template declares `figures: []` and draws everything itself (`draw`
  returns true), like Trendlines, so `ZONE_ONLY_TYPES` needs no entry.

### 5. Params

- `calcParams`: `[pivotLen = 5, minSwingAtr = 0]`.
- `extendData`: `fib` (FibConfig), `pastCount`, `pastOpacity`, `mtf`
  (`{timeframe, waitClose?}` persisted; runtime stash session-only).
- `pastCount`/`pastOpacity` and `fib` colors are visual; `fib.levels[].value`,
  `fib.levels[].enabled` and `fib.reverse` change operands.

## MTF

Follows `applySrLevelsTimeframe` / `buildSrMtf` exactly:

- Pin in `extendData.mtf.timeframe`, "Wait for timeframe closes" via
  `mtf.waitClose`, both in the Settings panel like SR Levels.
- `applyAutoFibTimeframe` fetches HTF bars through `fetchHtfBars`, folds the
  forming bar when not waiting for closes, runs the same compute on HTF bars,
  and stashes `htfFibPairIdx` (per HTF bar, the index of the pair active on
  it) plus `htfFibPairs` (`{hiTs, hiPrice, loTs, loPrice, dir}`).
- In `calc`, `htfFibPairIdx` goes through `alignHtfToChart` like every other
  MTF series, so waitClose, the forming bar and same-timeframe pins behave as
  elsewhere. A pair starts on the first chart bar that reads its index and
  ends where the next index begins. Each anchor maps to the chart candle
  inside its HTF bar whose high (high anchor) or low (low anchor) is closest
  to the anchor price (SR's `snapFirst` rule, same fallbacks). Calc runs on
  every tick, so start/end come from one forward pass over the aligned index
  series, and only the last 11 pairs (the most `pastCount` can draw) are
  snapped; older pairs keep the unsnapped first-bar index.
- Coordinator wiring: warmup const, a `refreshFormingBar` branch, a
  `refreshMtfIndicatorsUncoalesced` branch with the `covered(warmup)` guard,
  and the new `htf*` stash keys in `MTF_RUNTIME_KEYS`.
- Warmup (fetch depth): `14 + 2 * pivotLen + 200` HTF bars plus the shared
  `HTF_WARMUP_BARS`. No `pastCount` multiplier (Trendlines freeze lesson);
  past fibs older than the fetched span are simply not drawn.

## Rule operands

- Outputs: `high`, `low`, `dir`, plus one output per **enabled** level in
  `extendData.fib.levels`, in level order. Name from the ratio: `f`, then `m`
  when negative, then `|value|` rounded to 4 decimals (ties away from zero)
  with trailing zeros dropped and `.` → `_` (0 → `f0`, 0.618 → `f0_618`,
  1.618 → `f1_618`, -0.236 → `fm0_236`). Duplicate names keep the first;
  `|value| >= 1e6` gets no output (still drawn).
- Consequence (accepted): disabling or editing a level invalidates rules that
  referenced it; validation reports the unknown output as today.
- Per bar, every output reads the pair active at that bar (latest counted
  pivots confirmed at or before it). Before the first pair: `None`.
- Frontend: `autoFibOutputs.ts` (leaf, no klinecharts import): output names,
  `parseAutoFibConfig(calcParams, extendData)`, warmup; `autoFib.ts` imports
  the parser back. Wired into `exprInstances.ts` and `exprChartToken.ts`.
- Backend: `indicators/auto_fib.py` with `parse_auto_fib_config`,
  `auto_fib_outputs`, `auto_fib_series`, `auto_fib_warmup`, a private
  `_is_pivot_at` copy (as each module keeps), and an `IndicatorSeriesSpec` in
  `registry.py` with `timeframe=lambda cfg: cfg.timeframe`. A shared case in
  `lib/expr/corpus.json` pins validation on both stacks.
- Operand warmup: `14 + 2 * pivotLen + 200` (ATR warm-up, one pivot window,
  and a bounded 200-bar reach for the latest high and low, which can be old).

## Registration points

`customIndicators.ts` (re-export, type union, `BASE_TEMPLATES`,
`OVERLAY_INDICATORS`), `indicatorMeta.ts` (inputs/title/desc),
`IndicatorSettings.tsx` (MTF block, apply routing, style block with the shared
levels editor, past-fib inputs, MTF InfoTip list), `mtfCoordinator.ts`,
`mtfRuntime.ts`. Add menus, legend timeframe badge and
`indicator.add` pick it up automatically. Agent `indicator.set` timeframe
pinning stays Trendlines-only (out of scope).

## Testing

- `autoFib.test.ts`: pair formation, ordering/dir, outside-bar tie, `reverse`,
  ATR filter, history spans and `pastCount` cap, no lookahead (a pivot only
  appears at `k + pivotLen`).
- `autoFibOutputs.test.ts`: output naming, enabled-only, duplicates, parse
  defaults.
- MTF test (in the style of `trendlinesMtf.test.ts` / SR's): HTF pair snaps to
  the chart candle holding the extreme; nothing shows before the HTF confirm
  bar closes.
- Parity: an `AUTO_FIB` entry in `indicatorParityGolden.test.ts` and
  `test_auto_fib` in `backend/tests/test_indicator_parity.py`, including an MTF
  case through `alignHtfToChart`.
- Existing drawing-tool fib tests still pass after the editor extraction.

## Out of scope

- Pivot source options (body/close); wicks only, like Trendlines.
- Zigzag-style leg selection.
- Agent `indicator.set` timeframe pinning for Auto Fib.
- The pre-existing gap where SR/FVG/PivotBands `htf*` keys are missing from
  `MTF_RUNTIME_KEYS`.
