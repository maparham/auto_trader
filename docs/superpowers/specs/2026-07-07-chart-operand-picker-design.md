# Chart operand picker (replace copy-to-rule with an in-strategy picker)

## Problem

The current way to use an on-chart indicator/drawing as a backtest rule operand is a
two-step, chart-initiated copy/paste:

1. On the chart, hover an indicator's legend row → ⋯ → **Copy to rule** (or right-click a
   drawing → **Copy to rule**). This snapshots a self-contained recipe onto an in-memory
   `ruleClipboard` signal.
2. In the Backtest → Strategy panel, each rule operand shows a ⧉ **paste** button that
   reads the clipboard and turns the operand into a labelled `kind:"series"` chip.

Two problems with this flow:

- **No paste target in an empty rule group.** The ⧉ button lives *inside* `OperandPicker`,
  which only renders per-operand within an existing rule row. A group with no rules shows
  only the empty hint + `+ Add rule`, so there is nowhere to paste — you must add a rule
  first (non-obvious), then paste into one of its default operands. This is the reported
  "paste button missing" bug.
- **Primary-line-only for multi-output indicators.** Copy hardcodes `recipe.line = 0`
  because the chart selection model tracks the instance, not a sub-curve. Multi-output
  indicators (LR bands, Prev H/L day/week highs & lows) can only copy their primary line.

## Goal

Remove the chart-initiated copy/paste entirely. Author chart operands **from the strategy
side** via a picker that lists the focused cell's live on-chart indicators and drawings,
with **one sub-item per active output**, so the user picks exactly the curve they want —
which also fixes the multi-output limitation for free.

## Scope

In scope:
- New `ChartOperandPicker` modal.
- New `indicatorOutputs()` helper enumerating an instance's active output lines.
- Two entry points: a per-operand `+` (replacing ⧉) and a group-level `+ Rule from chart`.
- Removal of `ruleClipboard`, `useRuleClipboard`, the ⧉ paste button + `pasteFromChart`,
  and the two chart-side "Copy to rule" menu items.

Out of scope (unchanged):
- The `Operand` data model (`kind:"series"`, `recipe`, `recipeKey`, `@tf`/`~len` key
  contract), `computeSeriesRecipe` + `LINE_KEYS`, and the backend series operand. The
  compute engine already resolves any `recipe.line`; this change only alters how the
  operand is authored.
- Drawing recipes (straight-line family) — kept, reachable through the same picker.
- SESSIONS, stock built-ins, channels, fibs, Pivot Bands — remain unsupported (shown
  greyed with a reason).

## Architecture

This is a UI-layer swap. Same data model, same compute, same wire format — only the
authoring UI changes.

**Removed**
- `ruleClipboard` signal (`lib/signals.ts`) and `RuleClipboardEntry`.
- `useRuleClipboard` + the ⧉ paste button + `pasteFromChart` (`BacktestSettingsModal.tsx`).
- ChartCore's `indicatorCopyToRuleItem` menu item; Toolbar's `copyDrawingToRule` menu item
  and the "Copy to rule" entries in both menus.

**Kept / reused**
- `chartOperand.ts`: `indicatorToRecipe(indType, calcParams, extendData, line)`,
  `drawingToRecipe(name, points, candles)`, `recipeLabel`, the supported-type gates
  (`isSupportedIndicatorType`, `isSupportedDrawingName`, `*CopyDisabledReason`). The picker
  calls `indicatorToRecipe` with the chosen `line` instead of the default 0.
- `backtestConfig.ts`: `Operand`, `recipeKey`, `seriesName`. No change.
- `backtestSeries.ts`: `computeSeriesRecipe`, `LINE_KEYS`, `pickLine`. No change — already
  resolves `recipe.line` to the right output key.
- Backend `rule.py` / `schemas.py` series operand. No change.

## Components

### `ChartOperandPicker` (new modal)

Bound to the backtest panel's own chart cell/controller (the same source the current copy
path read — the focused cell's `controller.overlays` / indicator instances). Reads:
- On-chart **indicator instances** (name, `calcParams`, `extendData`, MTF `timeframe`).
- On-chart **drawings** (name, points).

Renders a list:
- **Indicator instance** = one row, labelled by its exact params via `recipeLabel`
  (`EMA(200)`, `Prev H/L`, etc. — extend `recipeLabel`/label source as needed to include
  the instance's distinguishing params).
  - **Multi-output** (LR, Prev H/L, EMA-with-smoothing) → expandable to sub-items, one per
    active output from `indicatorOutputs()`.
  - **Single-output** (RSI, VWAP, AVWAP, plain EMA/MA) → selects on click, no expand.
- **Drawing** = one row, single output, selects on click.
- **Unsupported** instance → greyed + disabled, tooltip = `indicatorCopyDisabledReason` /
  `drawingCopyDisabledReason`.

On select of output `line` for instance `X`:
```
recipe = X is drawing
  ? drawingToRecipe(name, points, candles)          // single line
  : indicatorToRecipe(indType, calcParams, extendData, line).recipe
label  = base label (recipeLabel) + output suffix when the instance is multi-output
         e.g. "Prev H/L: Day High", "LR: Upper"; single-output → just "EMA(200)"
operand = { kind:"series", seriesKey: recipeKey(recipe), label, recipe,
            ...(timeframe ? {timeframe} : {}) }      // timeframe from instance MTF
```
`recipeKey` still hashes only the recipe (which includes `line`), so distinct outputs of
the same instance are distinct series and identical picks dedupe. The modal returns the
operand to whichever entry point opened it.

### `indicatorOutputs(indType, extendData, calcParams)` (new, in `chartOperand.ts`)

Returns the instance's **active** outputs as `Array<{ lineIndex: number; label: string }>`,
derived from `LINE_KEYS` (backtestSeries.ts) plus the instance's config. `[]` for
unsupported types.

Per type (v1):
- `EMA` / `MA`: `[{0,"EMA(n)"}]`, plus `{1,"Smoothing"}` when the instance's `extendData`
  enables the smoothing line.
- `LR`: `[{0,"Regression"}]`, plus `{1,"Upper"}` and `{2,"Lower"}` when bands are enabled.
- `VWAP` / `AVWAP`: `[{0,"VWAP"}]`.
- `RSI`: `[{0,"RSI(n)"}]`.
- `PREV_HL`: the active subset of
  `[rollingHigh, rollingLow, dayHigh, dayLow, weekHigh, weekLow, anchorHigh, anchorLow]`
  (line indices per `LINE_KEYS.PREV_HL`) that the instance's period config renders —
  e.g. `Prev H/L(1d,1w)` → Day High, Day Low, Week High, Week Low.

The label maps to a human string; the `lineIndex` is the index into that type's
`LINE_KEYS` array (or the EMA/MA base/smoothing convention `computeIndicatorRecipe` uses),
so `computeSeriesRecipe` reads the same output the user saw on the chart.

## Entry points

### Per-operand `+` (replaces ⧉) — `OperandPicker`

A small chart-icon `+` button on each operand slot (where ⧉ used to be). Opens
`ChartOperandPicker`; on select, calls `onChange(operand)` so the slot becomes the series
chip. Chip rendering + ✕-to-clear (back to a normal `const` operand) is unchanged. Present
on every operand, including freshly-added rules.

### Per-rule swap sides — `RuleGroupEditor` rule row

A `⇄` icon button in each rule's actions cluster (`bt-rule-actions`, alongside the
eye / trash / kebab), tooltip "Swap sides (same condition)". It swaps the two operands
**and flips the operator** so the rule's truth value is preserved:
```
setRule(i, { ...rule, left: rule.right, right: rule.left, op: OP_REVERSE[rule.op] })
```
Reuses the existing `OP_REVERSE` map (gt↔lt, gte↔lte, crossesAbove↔crossesBelow, crosses
self-mirrors) — the operand-swap mirror is exactly that mapping, so `A > B` becomes the
equivalent `B < A`. Independent of the picker work, but shares the rule-row surface.

### Group-level `+ Rule from chart` — `RuleGroupEditor`

A button in the footer next to `+ Add rule`, and surfaced in the **empty-state** area (next
to / replacing the current empty hint affordance). Opens the same picker; on select,
appends a new rule:
```
{ left: <series operand>, op: "gt", right: { kind:"const", value: 0 }, ... }
```
ready to edit. This makes an empty group usable with no pre-step (the original bug).

## Data flow (unchanged downstream)

```
pick output line L for on-chart instance X
  → indicatorToRecipe(X.indType, X.calcParams, X.extendData, L)   (or drawingToRecipe)
  → Operand{ kind:"series", seriesKey: recipeKey(recipe), label, recipe, timeframe? }
  → seriesName(op) keys the series (with @tf / ~len suffixes)
  → computeSeriesRecipe(recipe, candles) posts the array under seriesKey
  → backend reads it verbatim; series_name(op) rebuilds the same key
```

`timeframe` is inherited from the instance's MTF setting; the operand's existing TF
dropdown still lets the user override it after adding.

## Edge cases

- **Panel epic ≠ focused chart.** Bind the picker to the backtest panel's own cell (as the
  copy path did), so the listed indicators match the strategy's instrument.
- **No indicators on the chart.** Picker shows an empty state ("No indicators on this chart
  — add one from the chart toolbar").
- **Instance changes/removed after adding.** Irrelevant — the recipe is a self-contained
  snapshot (unchanged property of `kind:"series"`).
- **Multi-instance / duplicate labels.** Rows are keyed by instance id; identical
  recipes still dedupe downstream via `recipeKey`.

## Testing

**Unit (vitest)**
- `indicatorOutputs()`: EMA → `[base]` / `[base, smoothing]`; LR → regression (+bands when
  enabled); Prev H/L(1d,1w) → day/week highs & lows only (no anchor/rolling rows unless
  active); RSI/VWAP → single; unsupported → `[]`.
- `indicatorToRecipe(..., line>0)` → `computeSeriesRecipe` returns the correct non-primary
  output line (the old `line:0` limitation, now exercised end-to-end).
- Group-level add seeds `{ left: series, op:"gt", right: const 0 }`.
- Swap sides: `A gt B` → `B lt A` (operands swapped, operator flipped, truth preserved);
  `crosses` self-mirrors; a full round-trip swap returns the original rule.

**Component / interaction**
- Empty group → `+ Rule from chart` → pick → a runnable rule appears (regression for the
  reported bug).
- Per-operand `+` → chip; ✕ → normal operand.
- Unsupported instance renders greyed + disabled with reason.

**Removal / regression**
- `ruleClipboard`, `useRuleClipboard`, the ⧉ button, and both "Copy to rule" menu items
  are gone.
- Existing series-operand backtest tests (frontend compute + backend) stay green — proves
  the data model and wire format are untouched.

## Rollout

Single change; no data migration (the `Operand`/`recipe` wire format is unchanged, so any
saved presets with existing `kind:"series"` operands keep working). Per repo convention
(no-legacy), the old copy/paste path is deleted outright rather than deprecated.
