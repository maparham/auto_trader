# RSI divergence rule operands (confirmed divergences as a 0/1 event series)

## Problem

The chart's RSI indicator detects and draws **divergences** (regular + hidden,
bullish + bearish) via `detectDivergences()` (`frontend/src/lib/indicators/rsi.ts`),
but they cannot be used in a backtest/live rule. The chart-operand picker exposes RSI
as a **single output** — its value line — because `computeIndicatorRecipe`
(`backtestSeries.ts`) resolves only `computeRsi(...).val` for RSI. Divergences live in
`RsiPoint.divs` as an array of drawn **segments** (`{ kind, fromIndex, toIndex, … }`),
not a per-bar numeric series, so they are neither pickable nor comparable by a rule
operator.

A trader who wants "enter when a bullish RSI divergence confirms" has no way to express
it, even though the app already computes exactly that signal for display.

## Goal

Expose each RSI instance's **confirmed** divergences as pickable rule operands, encoded
as a **per-bar 0/1 event series** (`1` on the bar a divergence of the chosen kind
confirms, `0` otherwise). Ride entirely on the existing `kind:"series"` operand
pipeline built for the chart-operand picker — **no new operand kind, no backend change,
no rule-engine change** — so backtest ↔ live parity is automatic.

Usage: an entry rule `RSI(14): Bullish divergence > 0`, or an exit rule
`RSI(14): Bearish divergence > 0`.

## Scope

In scope:
- Extend the RSI recipe compute (`computeIndicatorRecipe`) to emit a divergence event
  series when the operand's `line` selects a divergence kind.
- Extend `indicatorOutputs("RSI")` to offer the RSI value **plus all four divergence
  kinds** (regular bull/bear, hidden bull/bear).
- Line-index encoding + labels + recipe self-containment for the new outputs.

Out of scope (unchanged):
- The `Operand` model (`kind:"series"`, `recipe`, `recipeKey`, `@tf`/`~len` contract),
  `buildSeries`, the backend series operand (`rule.py`/`schemas.py`). The backend reads
  the posted array verbatim — a 0/1 series is just numbers.
- The `ChartOperandPicker` UI, entry points, and enumeration — they already render one
  row per output from `indicatorOutputs()`; divergence outputs appear for free.
- Divergence **detection** logic itself (`detectDivergences`) — reused as-is.
- Divergences on any indicator other than RSI (RSI is the only one with divergence
  detection). No generalization in v1.
- Drawing divergence lines on the chart — already exists, untouched.

## Architecture

This is a compute + enumeration extension on top of the chart-operand picker
(`[[chart-operands-in-rules]]`, spec `2026-07-07-chart-operand-picker-design.md`). A
divergence output is **just another output line of an RSI `series` operand**. The data
flow is identical to any other picked chart operand:

```
pick "RSI(14): Bullish divergence" (line 1)
  → indicatorToRecipe("RSI", [14], extendData, line=1)   (extend carries detection params)
  → Operand{ kind:"series", seriesKey: recipeKey(recipe), label, recipe, timeframe? }
  → buildSeries → computeIndicatorRecipe(recipe, candles)
        RSI line ≥ 1 → detectDivergences → 0/1 event array
  → posted under seriesKey; backend reads it verbatim
```

### The four pieces

**1. Compute — `computeIndicatorRecipe` RSI branch (`backtestSeries.ts`)**

Today the RSI case is:
```ts
case "RSI":
  return computeRsi(candles, r.calcParams[0] ?? 14, ext as RsiExtend).map((p) => p.val ?? undefined);
```
Extend it: `line === 0` keeps the value series (unchanged). `line ≥ 1` selects a
divergence kind and emits an event series, reusing the exact detector the chart uses:
```ts
const pts = computeRsi(candles, len, ext);
const rsi = pts.map((p) => p.val);
const out: RsiPoint[] = candles.map(() => ({}));
// Detection params from the recipe; force ON exactly the chosen kind's flag.
detectDivergences(candles, rsi, out, cfgForKind(recipe.extend.divergence, kind));
return candles.map((_, i) => (out[i].divs?.some((d) => d.kind === kind) ? 1 : 0));
```
`detectDivergences` appends **only confirmed** segments to `out[i].divs` at the
right-pivot bar `i` (`toIndex`), gated by the per-kind flags — so passing a config with
just the chosen kind enabled yields exactly that kind's confirmed events. The tentative
"forming" pass the chart runs for its faint preview is **not** called here, so there is
no repaint / lookahead. The confirmation bar lags the pivot by `lookbackRight` bars; that
lag is real and identical in live.

Kind ↔ line mapping (v1): `1 = bullish`, `2 = bearish`, `3 = hiddenBullish`,
`4 = hiddenBearish` — the order of a new `DIVERGENCE_KINDS` constant. `cfgForKind`
takes the recipe's pivot/range params and enables only the chosen kind's flag, so the
compute force-detects that kind regardless of which flags the source instance had set.

**2. Line encoding — `LINE_KEYS` + `indicatorOutputs` (`backtestSeries.ts` / `chartOperand.ts`)**

RSI is currently handled apart from `LINE_KEYS` (single value line). Introduce an
explicit RSI output list so the picker and compute agree on indices. `indicatorOutputs("RSI")`
returns, per the "always all four" decision:
```
[ {0,"Value",base}, {1,"Bullish divergence"}, {2,"Bearish divergence"},
  {3,"Hidden bullish divergence"}, {4,"Hidden bearish divergence"} ]
```
Always all four, regardless of the instance's divergence on/off settings (compute
detects the chosen kind either way). This is a deliberate exception to the picker's
"mirror only what the chart draws" rule, chosen for simplicity.

**3. Labels**

Base output → `RSI(14)`. Divergence outputs → `RSI(14): Bullish divergence`,
`RSI(14): Bearish divergence`, `RSI(14): Hidden bullish divergence`,
`RSI(14): Hidden bearish divergence` (base/suffix composition already in
`chartOperandSources`).

**4. Recipe self-containment + dedup**

When building a divergence-output recipe, snapshot the **detection params**
(`lookbackLeft`, `lookbackRight`, `rangeMin`, `rangeMax`) into `recipe.extend.divergence`
— from the instance's config if present, else `RSI_DIVERGENCE_DEFAULTS` — so the operand
reproduces the exact pivots even after the chart instance changes or is deleted. The
per-kind on/off flags and style are **not** part of the divergence-output recipe (they
don't affect a single kind's detection), so two RSIs that differ only in which kinds are
toggled produce the **same** `seriesKey` for the same kind and dedupe. `recipeKey`
already folds `line` + `extend` into the hash, so `Value` and each divergence kind are
distinct series.

## Timeframe (MTF)

Divergence outputs keep the per-operand timeframe dropdown, like other RSI operands. An
HTF divergence is detected on the HTF bars and forward-filled onto the base bars by the
existing `alignHtfToChart` (closed-bar, no lookahead) — so the `1` is **held across all
of that HTF bar's base bars** (the divergence is "active" during the HTF bar).

Consequence to document in UI copy / the operand's tooltip: on a higher timeframe,
`> 0` is true for every base bar inside the confirming HTF bar (a rule may re-fire). To
fire **once** on the HTF bar's first base bar, pair it with `crossesAbove 0.5` instead
of `> 0` — the rising edge of the held signal. On the base timeframe the event occupies
a single bar, so `> 0` and `crossesAbove 0.5` behave the same.

## Warm-up

A divergence needs enough history to find two pivots within range:
`RSI length + rangeMax + lookbackLeft + lookbackRight` bars before the first valid
signal. Fold this into the existing warm-up sizing (`longestIndicatorLength` / the
backtest warm-up term) so a run's leading bars aren't silently missing divergences that
a longer history would surface. Before warm-up completes the series is `0` (no
divergence), never `undefined`, so comparisons stay well-defined.

## Data flow (unchanged downstream)

Identical to any picked chart operand — `seriesName(op)` keys the series (with `@tf` /
`~len` suffixes), `buildSeries` posts the 0/1 array under `seriesKey`, the backend reads
it verbatim and `series_name(op)` rebuilds the same key. No backend or DTO change.

## Edge cases

- **RSI with divergence turned off on the chart.** Still pickable (always all four); the
  recipe snapshots the resolved detection params (instance's or defaults) and computes
  deterministically. The operand does not require the chart to be drawing that kind.
- **Not enough bars / no divergence in range.** Series is all `0` — a valid "never
  fired," not an error.
- **Forming (tentative) divergences.** Never contribute to the operand (confirmed only),
  even though the chart may draw them faintly.
- **Instance changed/removed after adding.** Irrelevant — the recipe is a self-contained
  snapshot (unchanged property of `kind:"series"`).
- **Slope (`Δ`) on a divergence output.** Technically allowed by the operand model, but
  the slope of a 0/1 event series is not meaningful; acceptable to leave enabled (no
  special handling) — the user simply wouldn't use it.

## Testing

**Unit (vitest)**
- `computeIndicatorRecipe` RSI line ≥ 1 → an array that is `1` exactly on the `toIndex`
  of each confirmed segment of that kind (assert against a direct `detectDivergences`
  call on the same bars with only that kind enabled), `0` elsewhere.
- Each `line` (1–4) selects the correct kind; line 0 still returns the RSI value series
  (regression).
- `indicatorOutputs("RSI")` returns Value + all four divergence outputs regardless of
  the instance's divergence flags.
- `chartOperandSources` for an RSI instance → 5 outputs with labels
  `RSI(14)` / `RSI(14): Bullish divergence` / … and distinct `seriesKey`s; the
  divergence recipes carry the detection params and omit per-kind flags (dedup:
  two RSIs differing only in flags → same divergence `seriesKey`).
- MTF: an HTF divergence operand forward-fills a held `1` across the HTF bar's base bars
  (via `buildSeries` with a stub `fetchTimeframe`), and `crossesAbove 0.5` fires once on
  the first base bar.

**Component / interaction**
- Picker lists an on-chart RSI with 5 outputs (Value + 4 divergences); picking
  "Bullish divergence" yields a `kind:"series"` operand whose recipe has the divergence
  line + params.

**Regression**
- Existing RSI series-operand tests (value line, line 0) stay green — proves the value
  path is untouched.
- Backend series-operand tests unchanged (wire format identical).

## Rollout

Single additive change; no data migration (the `Operand`/`recipe` wire format is
unchanged, so saved presets keep working and simply gain access to the new outputs).
