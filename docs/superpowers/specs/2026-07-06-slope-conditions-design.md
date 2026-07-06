# Slope conditions for backtest/live rules — design

**Date:** 2026-07-06
**Status:** Approved, ready for implementation plan

## Problem

Rules today compare the *value* of an indicator or price (e.g. `EMA_9 crossesAbove EMA_21`, `close gt EMA_50`). There's no way to condition on the *slope* of a curve — "EMA is rising", "EMA rising faster than 0.1%/bar", "fast EMA slope > slow EMA slope". Slope/momentum is a common and useful entry/exit gate that the current operand model can't express.

## Goal

Let any indicator or price operand be marked as a **slope**, so its per-bar value becomes the rate of change of the underlying curve. This single feature covers all three uses the user asked for:

- **Direction** — `slope(EMA_9) gt 0` (rising) / `lt 0` (falling).
- **Numeric threshold** — `slope(EMA_9) gt 0.1` (rising faster than 0.1 %/bar).
- **Slope vs slope** — `slope(EMA_9) gt slope(EMA_21)` (acceleration / momentum).

It must compose with everything rules already do: the `crosses*` operators, the Nth-time `count` exit modifier, AND/OR groups, and higher-timeframe (MTF) operands. Live trading must inherit it with no live-specific work.

## Definition

Slope is measured in **percent per bar** over a lookback of `N` bars:

```
slopePctPerBar[i] = (v[i] − v[i−N]) / |v[i−N]| / N × 100
```

where `v` is the underlying series (the indicator or price the operand names).

Rationale for each choice:

- **Percent, not raw points** — a threshold that works on EUR/USD also works on gold. Raw price/bar is instrument-dependent and non-portable; presets stay meaningful across symbols. Direction is simply the sign, so `> 0` / `< 0` are scale-free too.
- **`÷ N`** — dividing by the lookback means changing `N` smooths the measure *without* rescaling the threshold. A user who set `gt 0.1` can widen the window without re-tuning the number. This is deliberate.
- **`|v[i−N]|`** (absolute denominator) — keeps the sign of the slope equal to the direction of change even if the base series can go non-positive. (All current bases — EMA/SMA/AVWAP/price/RSI/VOL/VOLMA — are non-negative, but abs is future-safe.)
- **Denominator is the operand's own past value** — slope-of-RSI is "% change in RSI per bar," not RSI points. Internally consistent, and what makes slope-vs-slope comparisons behave.

**Null / warm-up:** the slope value is `null` (no value) when `v[i]` or `v[i−N]` is missing, or when `v[i−N] == 0`. A slope series therefore needs `N` extra bars of warm-up beyond the base indicator; the config's warm-up/history calculation must account for `+N`.

**Default lookback:** `N = 1` (bar-to-bar change; most responsive), editable per operand.

## Model change

Slope is a **transform flag on the operand**, not a new operand kind and not a new indicator type. This keeps the operand model flat and reuses every existing seam.

`backtestConfig.ts` — add an optional field to the `indicator` and `price` operand variants only:

```ts
| { kind: "indicator"; indicator: IndicatorKind; length?: number; anchor?: number; timeframe?: string; slope?: { len: number } }
| { kind: "price"; field: PriceField; slope?: { len: number } }
```

- `slope` absent ⇒ the operand behaves exactly as today (byte-for-byte compatible with existing presets).
- `slope: { len: N }` ⇒ the operand's value is the %/bar slope of the underlying, over `N` bars.
- `const` and `entry` cannot be sloped: a constant's slope is 0; entry price is flat for the trade's life (slope 0). The UI does not offer the toggle for them; the backend never sees `slope` on those kinds.

The backend `Operand` (`rule.py`) mirrors the field: `slope_len: int | None = None` (or an equivalent), decoded from the DTO.

## Series key (`seriesName`) — lockstep contract

A sloped operand keys a **distinct** series so a curve and its slope never collide, and two different lookbacks are distinct series.

**Suffix ordering is fixed** and must be identical on both sides (the endpoint's D4 check compares the frontend-declared keys against the backend-derived keys and will fail on any mismatch):

```
<base>[~<slopeLen>][@<timeframe>]
```

The slope suffix comes **before** the timeframe suffix. Examples:

- `EMA_9` → sloped(N=3) → `EMA_9~3`
- `EMA_9@HOUR` → sloped(N=3) → `EMA_9~3@HOUR`
- a sloped `close` price → `close~1` (see next section)

Both `seriesName` (`backtestConfig.ts`) and `series_name` (`rule.py`) apply the suffix in this exact order.

### Sloped price keys a series (asymmetry to call out)

A plain `price` operand has **no** series today — the backend reads it straight off the candle. A **sloped** price cannot be read off a single candle (it needs `v[i−N]`), so:

- **A sloped operand ALWAYS keys a series, regardless of base kind.** `seriesName` returns non-null for a sloped price; `collectSeriesOperands` now also collects sloped price operands so `buildSeries` computes them.
- In the backend `_operand_values`, **any sloped operand reads from `self.series`** (by its `seriesName` key), including sloped price — it no longer falls through to the `getattr(candle, field)` branch.
- A plain (non-sloped) price is unchanged: no series, read off the candle.

## Series computation (`backtestSeries.ts`) — the MTF trap

The one place this can go subtly wrong: **for a higher-timeframe operand, slope must be computed on the native HTF candles, BEFORE forward-fill.**

`buildSeries` currently does, per operand: `computeRaw(op, tfCandles)` then (for HTF) `alignHtfToChart(...)` which forward-fills the coarse value across the base bars. The slope step slots **between** those two:

```ts
const raw = computeRaw(op, tfCandles);            // native-tf indicator/price values
const derived = op.slope ? slopeOf(raw, op.slope.len) : raw;
// base tf:
out[name] = toNullable(derived);
// htf:
out[name] = toNullable(alignHtfToChart(baseTimestamps, htf, derived, htfMs, true));
```

If slope were instead derived from the *stored, already-forward-filled* base array (`out[name]`), an HTF slope would read 0 inside each HTF bar and spike at every boundary — garbage. Deriving before alignment gives a true HTF slope, forward-filled with the same no-lookahead (closed-bar) rule as the raw indicator.

`slopeOf(raw: Array<number | undefined>, n: number): Array<number | undefined>` implements the formula above, emitting `undefined` for the warm-up gap and wherever the base is `undefined` or the denominator is 0.

## Backend evaluation (`rule.py`)

- `series_name` appends the `~<len>` suffix (before `@tf`) when the operand is sloped, matching the frontend.
- `_operand_values` reads any sloped operand from `self.series[series_name(op)]` — the `(now, prev)` pair is just `arr[i], arr[i-1]` of the slope series. This makes `slope(EMA_9) crossesAbove 0` (slope crossing up through zero) work with no special-casing.
- `_operand_name` / `_reason` render a sloped operand as `slope(<base>,<N>)` — e.g. `slope(EMA_9,3)` — so exit reasons stay legible.

The engine still does no indicator math: slope is computed frontend-side and posted like any other series. The backend only gains the key-suffixing and the "sloped ⇒ always read from series" rule.

## UI (`OperandPicker` in `BacktestSettingsModal.tsx`)

- A compact **"Δ" toggle button** next to the length field on indicator and price operands. Off ⇒ plain operand. On ⇒ reveals a small **N** number field (default 1, min 1) and the operand now means its slope. Hidden for `const` and `entry`.
- When one side of a rule is a slope and the **other side is a Number (`const`)**, show a **"%/bar"** hint next to that number input, so the user knows `0.1` means 0.1 %/bar rather than an absolute price.
- Slope composes with the existing per-operand **timeframe** dropdown (slope of an HTF EMA) and with all operators/count/AND-OR — no other UI changes.

## Live trading

Live builds its series through the **same** `buildSeries` (`liveEngine.ts` imports and calls `realBuildSeries`), and evaluates through the shared `RuleStrategy` via `/api/strategy/evaluate`. Adding `slope` to the shared `Operand` type therefore makes slope work in live with **no live-specific code**. This is verified, not assumed.

## Scope / non-goals

- Slope on **indicator and price only**. Not on `const` or `entry`.
- Only the **linear %/bar** definition. No angle-in-degrees (chart/zoom dependent, ill-defined headlessly), no linear-regression slope, no acceleration (2nd derivative) — a sloped-slope is out of scope; if wanted later it's a separate operand transform.
- No new operators. Slope reuses `gt/lt/gte/lte/crosses*`.

## Testing

- **`backtestConfig.test.ts`** — `seriesName` suffix + ordering (`EMA_9~3`, `EMA_9~3@HOUR`, `close~1`); `collectSeriesOperands` now includes sloped price; warm-up length accounts for `+N`.
- **`backtestSeries.test.ts`** — `slopeOf` numeric correctness (known series → known %/bar), null/warm-up handling, `v[i−N]==0` → null; **MTF: sloped HTF operand is diffed on native candles then forward-filled** (the anti-regression test for the trap — assert the slope is *not* 0-within-bar/spike-at-boundary).
- **`test_rule_strategy.py`** — backend reads a sloped series (incl. sloped price from `self.series`, not the candle); `slope(EMA) crossesAbove 0`; slope-vs-slope; `_reason` renders `slope(...)`.
- **`test_api_strategy_evaluate.py`** — round-trip DTO with `slope`; the D4 key-lockstep check passes for a sloped MTF operand.
- Baseline to keep green: vitest, pytest, tsc (23 pre-existing tsc errors unrelated).
