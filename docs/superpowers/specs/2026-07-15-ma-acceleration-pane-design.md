# MA Acceleration pane (Slope companion) — design

Status: approved (2026-07-15)

Add an optional second sub-pane to the MA Slope indicator showing **MA
acceleration**: the rate at which each selected MA's slope is changing (the
second derivative of the MA). Acceleration is also pickable as a backtest/live
rule operand, with MTF parity.

Builds on `2026-07-11-ma-slope-multiline-design.md`,
`2026-07-13-slope-outputs-rate-only-design.md`, and
`2026-07-13-slope-threshold-line-design.md`.

## Decisions

1. **Companion pane, parent-owned.** A `Show acceleration pane` toggle in the
   Slope settings spawns a linked second sub-pane. Not a standalone indicator,
   not extra lines in the slope pane.
2. **Operands live on the PARENT Slope instance**, by extending its line-index
   encoding. The companion is a pure visual mirror and is never enumerated as an
   operand. Rules already bind to the parent instance, so no new binding surface.
3. **The companion is derived state: not independently persisted.** Only the
   parent persists `showAccel` + accel params in its `extendData`.
   Rationale is **single source of truth**, the same reason the threshold guide
   is indicator-owned rather than a separate overlay: a persisted companion would
   be a second copy of "is accel on, with what params" that can drift from the
   parent flag, and would be captured independently by named layouts, symbol
   templates, and snapshots.
   *Explicitly NOT the rationale: id re-minting. Indicator instance ids are
   stable (`mintInstanceId` only fires on a fresh add; reorder and hydrate both
   reuse saved ids). The re-mint hazard in `[[alert-chart-navigation]]` /
   `[[cross-tab-overlay-stomp]]` is about drawing/overlay ids, not indicator
   instances. Do not repeat that justification.*
4. **Fully internal pane for v1** (`INTERNAL_INDICATORS`): no styled DOM legend
   card, no independent Move up/down or remove. Values still read via
   klinecharts' native canvas legend, which the app deliberately does not blank
   for internal indicators. A styled DOM card is a noted follow-up.
5. **No separate accel units dropdown** — accel's time base follows the slope's.
6. **Not in the indicator menu.** The pane exists only via the Slope toggle.

## Math (`frontend/src/lib/indicators/slope.ts`)

The slope line is already a rate (e.g. %/hr). Acceleration is the change in that
rate over `N₂` bars, using an **absolute difference, NOT the percentage
renormalization** that `slopeWithUnits` applies:

```
accelSeries(slope, n2, barHours, perHour) =
  slope.map((v, i) => {
    const prev = slope[i - n2];
    if (i < n2 || v === undefined || prev === undefined) return undefined;
    return (v - prev) / (n2 * (perHour ? barHours : 1));
  })
```

`slopeWithUnits` divides by `|prev|`; that is wrong here because the slope
crosses zero, so `|prev slope| → 0` would produce unbounded values. This is the
key math difference and the reason accel gets its own helper rather than a second
`slopeWithUnits` pass.

- **Base series**: acceleration differentiates the **parent's slope output** —
  already unit-converted, already slope-smoothed if slope smoothing is on, and
  already MTF-resolved. It then applies its **own** optional smoothing.
  Pipeline: `MA → slope → (slope smoothing) → accel → (accel smoothing)`.
- **Time base follows the slope's units**: `perHour = (units === "pctHr")`.
  So `%/hr → %/hr per hour`; `%/bar` and `price/bar → per bar`.
- **Labels**: `Accel MA {len}`, with an InfoTip explaining "change in slope per
  hour/bar". Every new settings field gets an InfoTip (existing convention).

New/changed exports in `slope.ts`:
- `accelSeries(...)` as above.
- `accelLineSeries(candles, maType, length, n, n2, units, source, smoothing, accelSmoothing, barHours)`
  = `slopeLineSeries(...)` → `accelSeries(...)` → `smoothSeries(..., accelSmoothing)`.
  This is the ONE function both the companion's `calc` and the rule recipe call,
  so pane and rule agree by construction (the central contract of this module).
- `SlopeExtend` gains `showAccel?: boolean`, `accelPeriod?: number` (N₂, default
  3), `accelSmoothing?: SlopeSmoothing`, and `accelThreshold?: SlopeThreshold`.
- `mtf` gains `htfAccelByLine?: Array<Array<number | undefined>>`.

## Companion pane

New internal custom type `SLOPE_ACCEL`:
- `BASE_TEMPLATES.SLOPE_ACCEL` in `customIndicators.ts`, reusing `drawSlope`
  (zero line, threshold guide, color-by-direction, palette) with an accel `calc`
  and accel figure titles (`Accel {len}: `).
- Treated as internal, which excludes it from `reorderablePanes` and the DOM
  legend in lockstep.

  **`INTERNAL_INDICATORS` cannot express this as-is.** It is a `Set<string>` of
  fixed instance NAMES (`EQUITY_INDICATOR = "EQUITY"`), tested with
  `.has(ind.name)`. Our companion's name is dynamic (`${parentId}__accel`), so a
  Set can never match it. Replace the membership test with a single exported
  predicate, preserving the one-definition-no-drift intent of the comment at
  `lib/indicators.ts:167-171`:

  ```ts
  export const ACCEL_SUFFIX = "__accel";
  export const isInternalIndicator = (name: string): boolean =>
    INTERNAL_INDICATORS.has(name) || name.endsWith(ACCEL_SUFFIX);
  ```

  Apply it at exactly TWO of the three existing call sites: `lib/indicators.ts:193`
  (`reorderablePanes`) and `ChartLegend.tsx:824` (legend rows). Legend and reorder
  keep filtering on the SAME predicate, so their orders still agree.

### Visibility: the companion is NOT internal for the visibility sweep

`applyIndicatorVisibility` (`lib/indicators.ts:479`) **keeps its existing
`INTERNAL_INDICATORS.has(name)` test** and must NOT switch to
`isInternalIndicator`. The distinction is real: EQUITY is app-owned and has no
user visibility intent; the accel pane does — it must follow its parent.

If the companion were skipped by this sweep, the sidebar's master "Hide
indicators" switch and the per-resolution visibility model would hide the Slope
and leave a stray acceleration pane on screen.

Instead the companion is processed as a normal indicator, and
`syncAccelCompanion` copies the parent's `userVisible` and `visibility` model
into the companion's `extendData`. The sweep then computes the identical
`visible` result for both, with no extra coupling.

The per-indicator eye toggle (`useIndicatorCommands.ts:81-90`) writes
`userVisible` to the parent and calls `saveIndicatorVisible`; it must also
mirror `visible` + `userVisible` onto the companion. Cheapest correct option:
call `syncAccelCompanion` after the toggle. The plan should prefer a mirror-only
path over a full remove/recreate here if it proves visibly janky (a pane
teardown on every eye click).
- NOT in `SUPPORTED_INDICATORS` (`chartOperand.ts`) → never an operand.
- NOT in the indicator menu / `INDICATOR_META` user catalogue.

### Lifecycle invariant

> The companion is derived, ephemeral, and always spawned/torn down **by the
> parent**. It is never independently recreated by the reorder loop from an empty
> config, and never enters the persisted instance list.

One helper, `syncAccelCompanion(chart, scope, epic, parentId)`:
1. Remove any existing companion for `parentId` (found by scanning panes for id
   `${parentId}__accel`), wherever it currently is.
2. If the parent's `showAccel` is on, create it fresh **immediately after the
   parent's pane**, copying the parent's `calcParams` + accel params into its
   `extendData`.

Called from exactly two places:
- **`applyIndicator`** (`lib/indicators.ts`) — the single creation choke point.
  All recreate paths route through it: hydrate (:586), reorder-recreate (:245),
  fresh add (:554), plus paste, templates, and snapshots. One call there covers
  every path.
- **`applySlope`** (`IndicatorSettings.tsx`) — the live toggle and param edits.
  As with existing Slope settings, `extendData` must be written to the live
  indicator BEFORE the coordinator call, or the recompute reads stale values.

Parent removal: `removeIndicatorById` removes the companion alongside the parent.

**Pane ordering**: because `syncAccelCompanion` runs inside the parent's
`applyIndicator`, and reorder recreates parents in desired order (each appended
at the bottom), panes land as `[P1, A1, P2, A2, …]` — each companion directly
below its parent. The remove-then-create step is what prevents a stale companion
being stranded when its parent moves.

## Operand encoding

Today, with `K = slopeLengths(calcParams).length`: `line < K` = raw slope of
`lengths[line]`; `line >= K` = smoothed slope of `lengths[line-K]`. The decode is
a **fixed block scheme** that always resolves (smoothing off degenerates to
identity rather than returning undefined, so a saved rule never silently dies);
only the picker hides blocks that aren't meaningful.

Extend to four fixed blocks — `block = Math.floor(line / K)`, `j = line % K`:

| Block | Lines | Meaning |
|---|---|---|
| 0 | `0 … K-1` | raw slope of `lengths[j]` (unchanged) |
| 1 | `K … 2K-1` | smoothed slope of `lengths[j]` (unchanged) |
| 2 | `2K … 3K-1` | acceleration of `lengths[j]`, no accel smoothing |
| 3 | `3K … 4K-1` | acceleration of `lengths[j]`, accel-smoothed |

Blocks 0/1 keep their exact current meaning, so **every saved rule keeps its
meaning**. Blocks 2/3 always decode; the picker offers block 2 only when
`showAccel` is on, and block 3 only when accel smoothing is active.

### The four lockstep sites

`2026-07-13`'s rate-only re-encoding flipped the evaluator and picker but NOT the
warm-up, silently under-warming smoothed-slope backtests (fixed in 753df77).
These sites encode the same meaning and MUST change together, as one atomic unit:

1. `chartOperand.ts` `indicatorOutputs` — picker rows + labels.
2. `backtestSeries.ts` `computeIndicatorRecipe` SLOPE case — evaluator.
3. `backtestConfig.ts` `operandBaseLen` — warm-up reach-back:
   - block 0: `len + n`
   - block 1: `len + n + smLen`
   - block 2: `len + n + n₂` (+ `smLen` when slope smoothing is on, since accel
     differentiates the smoothed slope)
   - block 3: block 2 `+ accelSmLen`
   (`operandBaseLen` keeps its `Math.max` — that is reach-back sizing, not the
   value path. The value path stays UNCLAMPED, `Number(x)||9`, everywhere.)
4. `mtfCoordinator.ts` — K-agreement; must derive lengths via `slopeLengths`
   identically, including `.slice(0, 5)`.

Live is unaffected by the warm-up change (fixed window, not `longestWarmupBars`).

**Known, pre-existing, out of scope**: the block scheme is K-sensitive — changing
the number of MA lengths re-aliases saved line indices. This is inherited from
the current 2-block encoding, not introduced here.

## MTF

The rule path is already correct by construction: `buildChartOperandSeries` runs
the recipe on native HTF candles, then `alignHtfToChart`. Accel therefore
differentiates HTF slope on HTF bars.

The visual path needs the matching change. `applySlopeTimeframe`
(`mtfCoordinator.ts`) stashes `htfSeriesByLine` (slope on native HTF bars); when
`showAccel` is on it must ALSO compute accel on **native HTF bars** and stash
`htfAccelByLine`, which the companion aligns.

> **Trap**: differentiating the already-aligned slope is WRONG. Alignment
> forward-fills one HTF value across the chart bars in a bucket, so an aligned
> diff reads zero inside a bucket and spikes at boundaries — and it would diverge
> from the rule value. This is the same slope-before-forward-fill trap recorded
> in `[[slope-conditions]]`. Always: compute on native HTF, THEN align.

Same `inferBarHours(htf)` on both routes, matching the existing slope MTF path.

## Settings UI (`IndicatorSettings.tsx`, SLOPE branch)

Appended to the existing Slope settings, each with an InfoTip:
- `Show acceleration pane` toggle (`showAccel`).
- `Acceleration period` N₂ (default 3).
- `Acceleration smoothing` type + length (reuses the slope smoothing control).
- Acceleration threshold guide: toggle + level + `ColorLineStylePicker`
  (mirrors the existing slope threshold block, drawn by the reused `drawSlope`).

All accel fields are disabled/hidden when `showAccel` is off. All write to the
live indicator's `extendData` BEFORE the coordinator call.

## Testing

- `slope.test.ts`: `accelSeries` math — undefined for the first `n₂` bars,
  undefined propagation through gaps, no `|prev|` normalization (verify a
  zero-crossing slope produces a finite accel), per-hr vs per-bar denominators.
- Parity: companion `calc` values === recipe values for blocks 2/3 on the same
  candles (mirrors the existing slope parity tests).
- `backtestConfig.test.ts`: warm-up reach-back per block, including slope
  smoothing feeding block 2.
- MTF: accel computed on native HTF then aligned != diff of aligned slope
  (locks the trap above).
- Register/template test using the `vi.mock("klinecharts", …)` + top-level
  `await import` pattern — the vitest node env exports `IndicatorSeries` /
  `LineType` as `undefined`, so any module evaluating a template at load throws.
- Lifecycle: toggle on → companion pane exists below parent; toggle off →
  removed; parent removed → companion removed; reorder → companion follows
  parent; reload → companion respawned from the parent's persisted `showAccel`
  and absent from the saved instance list.
- Visibility mirroring: hiding the Slope (per-indicator eye AND the sidebar
  master "Hide indicators" switch) also hides the accel pane; a resolution the
  Slope's visibility model hides on hides the accel pane too. This is the
  regression the `INTERNAL_INDICATORS`-vs-`isInternalIndicator` split guards.

## Follow-ups (not v1)

- Styled DOM legend card for the accel pane (needs the legend/reorder predicate
  split described in `INTERNAL_INDICATORS`).
- Accel-vs-threshold as a rule operand (the slope threshold guide is likewise
  still visual-only, structured for this).
