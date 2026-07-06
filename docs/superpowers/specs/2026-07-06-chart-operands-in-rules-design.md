# Chart indicators & drawings as backtest/live rule operands — design

**Date:** 2026-07-06
**Status:** Approved, ready for implementation plan
**Depends on:** `2026-07-06-slope-conditions-design.md` must land first (same files; this composes with it).

## Problem

Backtest/live rules can only reference a hardcoded set of indicators. The operand model
understands exactly six indicator types (`EMA`, `SMA`, `AVWAP`, `RSI`, `VOL`, `VOLMA`) via a
`Literal`, each re-specified by hand in the rule builder. Meanwhile the user has already placed
indicators on the chart **with customized parameters** (`calcParams`, source, timeframe, AVWAP
anchor) and drawn trendlines/levels. None of that on-chart state is reachable from a rule — you
must retype an approximation of it, and anything outside the six types is impossible.

## Goal

Let the user **copy an on-chart indicator curve or drawing and paste it into a rule operand**,
carrying its exact customized parameters. The pasted operand is a **self-contained snapshot** — it
captures a recipe and stands alone thereafter (editing/deleting the chart instance does not change
the rule; the strategy stays portable across charts/instruments, matching the global-strategy
storage model).

This must reuse the existing architecture, not fight it:

- The backend does **no** indicator math; the frontend computes every series and posts it.
- The **same** `buildSeries` path is shared by backtest and live, so **live parity is automatic**.
- It composes with everything rules already do — `crosses*` operators, the Nth-time `count` exit
  modifier, AND/OR groups, per-operand higher-timeframe (MTF), and the new **slope** transform.

## Scope (v1)

**Copy-able:**

- The app's **8 custom indicator types** — `EMA`, `MA`, `LR`, `VWAP`, `AVWAP`, `PREV_HL`, `RSI`,
  `SESSIONS` — each of which already has a reachable, pure `(candles, params) → series` function.
  This is a genuine superset of today's six operands (adds `LR`, `PREV_HL`, `SESSIONS`, plain
  non-anchored `VWAP`).
- The **straight-line drawing family** — `segment`, `rayLine`, `straightLine`,
  `horizontalStraightLine` / `priceLine` — evaluated as a per-bar price series.

**Greyed out on copy, with a tooltip reason:**

- klinecharts **stock built-ins** (`MACD`, `BOLL`, `KDJ`, `SAR`, `CCI`, `DMI`, `WR`, …). klinecharts
  hides its calc (`getIndicatorClass` is private; `getSupportedIndicators()` returns names only), so
  there is no pure `(candles, params) → series` reachable without a live chart. Supporting them is a
  **bounded follow-on** (one offscreen-chart compute mechanism unlocks all built-ins at once) — out
  of v1.
- **Channels**, **fibonacci**, and **vertical lines** (a vertical line is a *time*, not a price, so
  it cannot be an operand).

**Not removed:** the six manual/typed indicator operands and the default EMA9/EMA21 crossover stay
indefinitely. The manual builder is the no-chart-needed path; the new kind sits alongside it. A rule
may freely mix a typed operand on one side and a pasted chart operand on the other.

## The gesture

**Chart side — "Copy to rule".** An explicit action (distinct from plain Cmd+C, which stays
"copy drawing to chart") available on:

- a **selected indicator curve** — via the legend / curve context menu. Because the copy is scoped to
  the *selected curve* (the app already supports click-to-select a specific curve), multi-line
  indicators resolve to exactly one line. Single-line indicators (EMA) copy their one line.
- a **selected drawing** — via the drawing context menu.

For unsupported indicator/drawing types the action is **disabled with a tooltip** explaining why
(e.g. "MACD isn't supported in rules yet"). Copying writes a **self-contained snapshot recipe** into
a dedicated in-memory "rule clipboard" (separate from the drawing-to-chart clipboard).

**Rules side — "Paste from chart".** Each operand slot (left/right) in the rule builder gains a
paste chip, enabled only when the rule clipboard holds a recipe. Pasting fills the operand and
renders a **label chip** (e.g. `EMA(9)`, `Trendline`). Clearing the operand or re-copying is how you
change it.

## The operand model (the unification)

A new operand **kind `series`**, added alongside the existing `indicator`/`price`/`const`/`entry`.

### Backend (`rule.py`, `schemas.py`)

The backend never computes and never needs the recipe. The `series` operand carries only:

- `seriesKey: str` — the payload key its precomputed array lives under.
- `label: str` — human label, used only for exit-reason rendering.

`series_name(op)` returns `op.seriesKey` **verbatim** (then applies the slope/`~len` and `@tf`
suffixes if present — see Slope composition). The frontend is the sole authority for both the key
and the array, so they cannot drift. The existing router validation ("every rule-referenced series
name must be present in `series`") already covers it — no new validation branch.

`_operand_values` reads a `series` operand from `self.series[series_name(op)]`, exactly like an
`indicator` operand. `_operand_name` / `_reason` render it as its `label`.

The existing six-type `Literal` on `OperandDTO.indicator` is **unchanged** — the manual builder keeps
using it. `OperandDTO` gains the `series` variant fields.

### Frontend (`backtestConfig.ts`)

The frontend operand for this kind carries `seriesKey` + `label` **plus the recipe**, because the
frontend must recompute the series and the recipe must persist in the (global) strategy config:

```ts
// indicator recipe
| { kind: "series"; seriesKey: string; label: string;
    recipe: {
      source: "indicator";
      indicatorType: "EMA" | "MA" | "LR" | "VWAP" | "AVWAP" | "PREV_HL" | "RSI" | "SESSIONS";
      calcParams: number[];          // positional, as on the chart
      line: number;                  // which output line (0 for single-line)
      timeframe?: string;            // MTF, if the chart instance was MTF
      anchor?: number;               // AVWAP anchor epoch-ms
      priceSource?: "close" | "open" | "high" | "low" | "hl2" | "ohlc4"; // if the type takes a source
    };
    slope?: { len: number };         // composes with slope (see below)
  }
// drawing recipe
| { kind: "series"; seriesKey: string; label: string;
    recipe: {
      source: "drawing";
      drawingKind: "segment" | "rayLine" | "straightLine" | "horizontalStraightLine" | "priceLine";
      anchors: Array<{ timestamp: number; value: number }>; // absolute, snapshotted at copy time
    };
    slope?: { len: number };
  }
```

`seriesKey` is a **deterministic hash of the recipe** (plus slope/timeframe suffixing), so two
identical pasted operands dedup into one entry in the posted `series` map. `collectSeriesOperands`
is extended to collect `series` operands.

## Series computation (`backtestSeries.ts`)

Extend the existing pure, headless `computeRaw`/`buildSeries` path — the **same one backtest and live
share** (`liveEngine.ts` injects `realBuildSeries`), which is what makes live parity automatic.

### Indicator recipe

Dispatch on `recipe.indicatorType` to the matching pure function:

| Type | Pure function |
|---|---|
| EMA / MA | `maSeries` (`mtf.ts`) — EMA vs simple selected by type |
| LR | `computeLr` (`indicators/lr.ts`) — needs `export` |
| VWAP / AVWAP | `vwapFrom` (`indicators/vwap.ts`); AVWAP uses `recipe.anchor` |
| PREV_HL | `computePrevHl` (`indicators/prevHl.ts`) — needs `export` |
| RSI | `computeRsi` (`indicators/rsi.ts`) |
| SESSIONS | standalone in `indicators/sessions.ts` |

`calcParams` map to each function's named params through the existing `indicatorMeta.ts` table
(positional index → meaning). MTF (`recipe.timeframe`) reuses `alignHtfToChart` (closed-bar, no
lookahead), exactly as typed indicator operands do today. The AVWAP anchor path is already mirrored
between chart and `computeRaw`.

**Naming trap handled for free:** the recipe carries the chart's own type name (`"MA"` = simple,
`"EMA"` = exponential), and `computeRaw` dispatches on it directly. The old MA↔SMA `Literal`
collision (chart `"SMA"` = *smoothed*, backtest `"SMA"` = *simple*) never arises because we do not
route through that `Literal`.

*Export work required:* `computeMa`, `computeLr`, `computePrevHl` are pure but module-private today;
they (or their already-exported dependencies) must be exported for `backtestSeries.ts` to call.

### Drawing recipe (trendline → series) — specified, not left to implementation

Anchors are snapshotted as **absolute `{timestamp, value}`** at copy time (any `dataIndex`-anchored
point is resolved to a timestamp then). This sidesteps the known dataIndex-vs-timestamp corruption
across TF switches.

Line value at a candle timestamp `t`, from two anchors `(t0,v0)`, `(t1,v1)`:

```
price(t) = v0 + (v1 − v0) · (t − t0) / (t1 − t0)
```

Extrapolation **per tool**:

- `segment` — defined only for `t ∈ [t0, t1]`; `null` outside.
- `rayLine` — forward only from the first anchor: defined for `t ≥ t0`; `null` before.
- `straightLine` — defined for all `t` (extends both directions).
- `horizontalStraightLine` / `priceLine` — flat constant series at `anchors[0].value` for all `t`.

## Slope composition

Slope (see the slope spec) is a **transform flag** on the operand, not a new kind — so the new
`series` kind **also carries the optional `slope?: { len }`** field, and "slope of my chart's EMA" or
"slope of my trendline" works with no extra machinery.

- Series key with slope: `<seriesKey>~<slopeLen>[@<timeframe>]` — the slope suffix precedes the
  timeframe suffix, matching the slope spec's fixed ordering. Both `seriesName` and `series_name`
  apply it identically.
- `slopeOf` is applied on the native series **before** `alignHtfToChart` for MTF operands (the slope
  spec's MTF trap applies here too).
- A sloped `series` operand always keys a series (it already does — `series` operands always key
  one), and the backend reads it from `self.series`.

## UI (`BacktestSettingsModal.tsx`)

- **OperandPicker** gains a **"Paste from chart"** affordance per slot, enabled when the rule
  clipboard is non-empty. A pasted operand renders as a labelled chip with a clear (✕) control; it
  reads back to an editable/empty operand on clear.
- The existing per-operand **timeframe** dropdown and the slope **Δ** toggle apply to pasted
  operands too (a pasted operand already carries its own MTF timeframe from the chart; the dropdown
  reflects/overrides it consistently with typed operands).
- Chart-side: a **"Copy to rule"** menu item on selected curves and selected drawings; disabled +
  tooltip for unsupported types.

## Live trading

Live builds series through the **same** `buildSeries` and evaluates through the shared
`RuleStrategy` via `/api/strategy/evaluate`. Because the `series` kind is added to the shared
`Operand`/`OperandDTO` and to `computeRaw`, live inherits it with **no live-specific code**. This
mirrors how slope and MTF already achieve live parity.

## Scope / non-goals

- **v1 coverage:** the 8 app-custom indicator types + the straight-line drawing family. No stock
  built-ins, channels, fibs, or vertical lines.
- **Snapshot only** — no live-link mode (a pasted operand does not track the chart instance).
- **Manual typed operands are kept**, not removed or migrated.
- Stock built-ins are a **bounded follow-on** (offscreen-chart compute), deliberately deferred.
- **Sequencing:** implement after the slope work is committed and green — it modifies the same files
  (`rule.py`, `schemas.py`, `backtestConfig.ts`, `backtestSeries.ts`, `liveEngine.ts`,
  `BacktestSettingsModal.tsx`).

## Testing

- **`backtestConfig.test.ts`** — `seriesName` for a `series` operand returns `seriesKey` verbatim;
  with slope → `seriesKey~N`; with slope + tf → `seriesKey~N@HOUR`; `collectSeriesOperands` includes
  `series` operands and dedups identical recipes; deterministic `seriesKey` hashing is stable.
- **`backtestSeries.test.ts`** — each of the 8 indicator recipes computes the same array as the
  chart template for the same `calcParams` (spot-check EMA/MA/RSI/LR/PREV_HL/VWAP/AVWAP/SESSIONS);
  drawing recipes: `price(t)` correctness and per-tool extrapolation (`segment` null outside range,
  `rayLine` null before `t0`, `straightLine` all-t, horizontal = flat); MTF drawing/indicator +
  slope compose (slope diffed on native candles then forward-filled, not 0-within-bar/spike).
- **`test_rule_strategy.py`** — backend reads a `series` operand from `self.series`; `_reason`
  renders its `label`; a `series` operand composes with `crosses*`, `count`, AND/OR.
- **`test_api_strategy_evaluate.py`** — round-trip a `series` OperandDTO; the key-lockstep check
  passes for a plain, an MTF, and a sloped `series` operand.
- Baseline to keep green: vitest, pytest, tsc (23 pre-existing tsc errors unrelated).
