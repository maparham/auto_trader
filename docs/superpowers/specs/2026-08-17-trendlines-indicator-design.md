# TRENDLINES: automatic major trendlines as an indicator

**Date:** 2026-08-17
**Status:** Approved

## Summary

Add a `TRENDLINES` custom indicator that finds the major sloping support and
resistance lines on a chart automatically, draws them, and exposes the nearest
one on each side as a rule operand.

The structure is the one `SR_LEVELS` already ships: confirmed fractal pivots
feed incremental state that is mutated **only at pivot-confirm bars**, so the
value at bar `i` depends only on bars `[0..i]` and nothing repaints. Where
`SR_LEVELS` clusters pivots into horizontal zones, `TRENDLINES` pairs pivots
into sloping lines and keeps the ones price never cut through.

Motivating case, used as the acceptance fixture: on DXY monthly the three lines
a human draws are the 2002-03 to 2007-08 bear resistance, the 2011-05 to 2021-01
secular bull support (which projects to 98.74 against a 99.19 spot, i.e. under
test today), and the 2022-09 to 2025-01 bear resistance. The detector must
surface those three.

## Goals

- Find sloping lines that *contain* price rather than slice through it, without
  a human picking anchors.
- Never repaint: a line that appears at bar `i` was derivable from bars `[0..i]`
  alone, so a backtest reading `tl_support` sees what the chart showed live.
- Expose nearest trendline support and resistance, plus their broken
  counterparts during a hold window, as rule operands with a Python twin that
  is bit-for-bit identical.
- Give the user control over whether lines stop at their last touch or project
  forward, without that choice silently changing strategy behaviour.

## Non-goals

- ~~**Multi-timeframe.**~~ SHIPPED (2026-08-19), and the retrofit the deferral
  feared never came due: the compute signature is untouched on both sides. The
  detector runs on whatever candles it is handed, so the higher timeframe is a
  question of WHICH candles, answered outside it — by the coordinator on the
  chart (`applyTrendlinesTimeframe`) and by the evaluator's pinned-`IndicatorRef`
  branch in a backtest. The lines stay in HTF bar indices right up to the pixel;
  see `TrendlinesMtf` for the three things converting them earlier would break.
- **Multi-scale in one instance.** One `pivotLen` per instance. Two scales means
  two instances, exactly as EMA and AVWAP already work.
- **Channels.** Parallel lines off the opposite pivot pool are a separate
  project.
- **Slope as an operand.** Tempting for regime rules, but it is a second thing
  to port and parity-test and nothing here needs it.

## Algorithm

State is per side. The high pool feeds resistance lines, the low pool feeds
support lines; the two are symmetric with the comparison direction flipped.
They are **separate pools**, unlike `SR_LEVELS`, which shares one pool because a
horizontal level can flip role and a directional line cannot.

A line is defined by two anchor pivots and never rotates once defined:

```
Line = { i1, p1, i2, p2, touches, lastTouchIdx, brokenIdx | null }
```

Later touches move `lastTouchIdx`, which extends the line's *coverage*. They do
not move `i2`/`p2`, so the geometry a line was born with is the geometry it
dies with.

### Per bar

**Every** bar, before any confirm-bar work, each live unbroken line is tested
against that bar with the same predicate that decides validity: a bar whose
extreme pierces the projected line by more than `violTol` sets
`brokenIdx = i`.

This runs per-bar and not only at confirm bars, because a line is almost always
broken by an ordinary bar. Restricting the test to pivots leaves a hole: a
support line that price closes straight through is no longer at or below the
close, so the nearest-support selection skips it, and it came from the low pool
so `tl_resistance` never considers it. It would vanish from all four outputs
without ever being marked broken, and `tl_broken_support` — the whole point of
the break-and-retest lifecycle — would never fire.

It is still causal: bar `i` is tested against a line whose anchors both precede
`i`. It is also a per-bar boolean gate, so it uses the cross-product form.

One predicate, deliberately: a line dies the moment any bar pierces it beyond
tolerance, whether or not that bar is a pivot, and whether that happens between
the anchors or long after. Validity and breakage are the same rule applied over
different ranges.

### Per confirm bar

A pivot at bar `k` confirms at bar `c = k + pivotLen` (shared `isPivotAt`,
`strict = true`). At `c`, in this exact order:

1. **Append** the pivot to its pool.
2. **Test it against every existing line on that side**, in stored order. For a
   resistance line: a pivot high above the line by more than `violTol` sets
   `brokenIdx = c` (if not already broken); a pivot high inside the band counts
   as a touch and moves `lastTouchIdx`.
3. **Seed candidates** by pairing the new pivot with each of the previous
   `MAX_PAIR_PIVOTS` (20) same-side pivots. A candidate is valid only if **no
   bar in `(i1, c]`** violates it, excluding the anchor bars themselves. Bars,
   not just pivots: that containment rule is what separates a real trendline
   from a line through two arbitrary points. The range runs to the confirm bar
   `c` rather than stopping at `i2`, because the bars between the second anchor
   and the confirm bar are real bars that could already have pierced the line —
   validating only `(i1, i2)` would let a line be born already broken.
   Valid candidates start at `touches = 2` plus every pool
   pivot strictly between the anchors that falls in the band. Counting those
   retroactively is not lookahead: every one of them confirmed before `c`.
   `lastTouchIdx` is seeded to `i2` and only ever moves forward.
4. **Prune** lines whose `lastTouchIdx + maxProjBars < c`, and broken lines
   whose `brokenIdx + breakHoldBars < c`.
5. **Rank and cap.** Live state retains `MAX_LIVE_MULT (4) * maxLines` lines per
   side, by rank; the rest are dropped. `maxLines` itself governs the DRAWN set.
   The two differ so a line that is temporarily outranked is not destroyed and
   can return when it gains a touch.

Pairing against the last 20 pivots rather than all of them caps the run at
`O(P * 20)` instead of `O(P^2)`.

`MAX_PAIR_PIVOTS` bounds how far back a line can reach, so **a long line needs a
proportionally large `pivotLen`**. Checked against the fixture at
`pivotLen = 5`: 7 low pivots separate the 2011-05 and 2021-01 anchors and 2 high
pivots separate line A's, both comfortably inside the window. On intraday data a
decade-spanning pair would never be inside a 20-pivot window, which is a real
limit and the reason multi-scale is one instance per scale rather than one
instance doing everything.

### Dedup

Lines are keyed by their exact anchor pair `(i1, i2)`; a duplicate pair is
skipped. Near-duplicate lines with different anchors are **not** merged. An
epsilon-based merge would be one more boolean gate that has to agree across two
runtimes for the output sets to match; the ranking and the `maxLines` cap
already suppress the visual clutter that a merge would fix.

### The two tolerances

Tolerance is `ATR(14)` sampled **at each tested bar `j`**, times a multiplier.
Per-bar rather than once at the confirm bar (which is what `SR_LEVELS` does):
still causal, since `j <= i2 <= c`, and far more defensible across a line
spanning a decade of changing volatility. `SR_LEVELS`' confirm-bar choice was
for a point cluster, not a span.

- `violMult` — how far a wick may pierce before the line dies.
- `touchMult` — how close a pivot must sit to count as a touch.

They are different numbers on purpose. With one shared value, a pivot landing
0.1 beyond the line invalidates what would otherwise be a three-touch line.

The touch band is deliberately **asymmetric**. For resistance:

```
line - touchTol  <=  pivotHigh  <=  line + violTol
```

A symmetric band with `touchTol > violTol` is self-contradictory: the far edge
of the "touch" zone would already be a violation.

### Selection for the operands

Membership is gated, selection is nearest:

- A line is **major** when `touches >= minTouches` and
  `span = lastTouchIdx - i1 >= minSpanBars`. There is deliberately **no
  `maxLines` cap on the operand path** (see Risks).
- Among live unbroken majors covering bar `i`, `tl_support` takes the line whose
  projected price is nearest **at or below** the bar's close, and
  `tl_resistance` the one nearest **above** it. Ties break by rank. Same
  semantics as `SR_LEVELS`' nearest support and resistance, which is the more
  actionable reading.

**`minSpanBars` is what suppresses noise, not `minTouches` and not `maxLines`.**
An incremental detector's newest line is always its shortest and freshest, and
since the operand picks the *nearest* line rather than the best one, a scrap
that gets in can win the operand outright. `minSpanBars` is the defence.

This paragraph originally credited a top-`maxLines` rank cap with that job.
Measured against the fixture, that cap was actively harmful (see Risks): it
discarded the line nearest-selection would have chosen. `maxLines` now sizes
live state via `MAX_LIVE_MULT` and governs the DRAWN set only.

That is why `minTouches` defaults to **2**, i.e. the anchors alone, rather than
demanding a third confirming touch. Requiring 3 systematically excludes
freshly-formed two-anchor lines, which are the most tradeable ones — and it
excludes one of this spec's own fixture lines. Verified against the live DXY
data: line C's only intervening pivot (2023-10, 106.952) sits 5.503 from a
projected 112.455, against a touch tolerance of 2.589 at that bar. It is a
two-touch line and always will be. Lines A and B do earn third touches (1.6 and
1.1 clear respectively). `minTouches` therefore gates nothing at its default and
exists for users who want only heavily-confirmed lines; `minSpanBars` and
`maxLines` carry the load.

Coverage of a line is `[i1, lastTouchIdx + maxProjBars]`. A low-pool line is
support whatever its slope: a descending line under a downtrend's lows is
genuine support, so the pool a line came from decides its side, not its sign.

## Causality and parity

Both properties are load-bearing and both are tested (see Testing).

**Causality.** Every state mutation happens at a confirm bar, and every bar a
candidate is validated against precedes its confirm bar. Backward extension is
render-only and is never readable by an operand, because a line emitting values
before its first anchor existed is lookahead by definition.

**Parity.** `core.py`'s contract is that identical operation order is what makes
the parity suite exact. This indicator is the hardest case that contract has
faced so far. In `SR_LEVELS`, a tolerance comparison landing differently shifts
a level's price slightly. Here, validity is a **boolean that gates set
membership**: a 1-ULP disagreement does not drift a number, it deletes a line
and changes the entire output set from that bar forward.

So the side test is evaluated as a cross-product, never as a slope:

```
violated  <=>  (high[j] - p1) * (i2 - i1)  >  (p2 - p1) * (j - i1) + tol[j] * (i2 - i1)
```

`(i2 - i1)` is an exact positive integer, so multiplying through preserves the
inequality and removes one rounding source entirely. The touch test uses the
same cross-multiplied form.

The rule to keep: **divisions are fine where the output is a number that can
drift harmlessly; they are not fine where the output is a boolean that gates
set membership.** Division survives only in emitting the projected price.

Ranking is fully deterministic with no reliance on sort stability, matching
`rankClusters`: touches desc, then span desc, then `lastTouchIdx` desc, then
`i1` asc, then `p1` asc. The last key is the first anchor's price, a stored
value — not a projected one — so ranking never depends on which bar it runs at.

## Configuration

`calcParams`, in this order. Mirrored by the backend's
`parse_trendlines_config`.

| # | Param | Default | Meaning |
|---|-------|---------|---------|
| 0 | `pivotLen` | 5 | Bars each side of a swing; also the confirm lag. |
| 1 | `violMult` | 0.25 | Pierce tolerance as a multiple of ATR(14). |
| 2 | `touchMult` | 0.75 | Touch tolerance as a multiple of ATR(14). |
| 3 | `minTouches` | 2 | Touches before a line is major (2 = anchors only). |
| 4 | `minSpanBars` | 20 | Minimum span before a line is major. |
| 5 | `maxProjBars` | 250 | How far past its last touch a line stays live. |
| 6 | `breakHoldBars` | 30 | How long a broken line keeps drawing and emitting. |
| 7 | `maxLines` | 3 | Lines DRAWN per side (and, via `MAX_LIVE_MULT`, how many are retained in live state). It does not *slice* the operand path, but it does *bound* it: see below. |

All validate on `> 0` except `violMult`, which validates on `>= 0`. Zero is a
meaningful setting there — exact containment, no pierce allowed at all — and it
is the value that reproduces a hand-drawn convex hull. It is not a "filter off"
switch the way FVG's `minSize = 0` is; it is the strictest setting rather than
the loosest. Both runtimes must test it, because silently coercing it back to
the default swaps strict containment for tolerant containment with no error.

`MAX_PAIR_PIVOTS = 20` and `TL_ATR_LEN = 14` are internal constants, not user
inputs.

`maxProjBars` and `breakHoldBars` are two separate clocks and must stay
separate. Line A on DXY is geometrically valid forever and projects to **-43**
today; without a projection cap the operand emits that number.

### The extend option

A `select` on `source: "extend"`, field `extend`, default `"ray"` — the same
seam `SR_LEVELS` uses for `showMidline`:

- **Ray** (default) — the line keeps going to the right edge.
- **Segment** — the line stops at its last touch.
- **Extended** — also drawn back before the first anchor.

It is **render-only**. The operands always project forward to `maxProjBars`, so
switching to Segment declutters the chart without silently breaking a strategy
that reads `tl_resistance`. Because it changes drawing only, it stays out of
`calcParams` and needs no Python port and no parity test. A user who wants the
*values* to stop projecting sets `maxProjBars`.

## Outputs

Add `"TRENDLINES"` to `EXPR_INSTANCE_TYPES` (today `SLOPE`, `ATR`, `FVG`) and
follow the FVG shape: fixed output *names* rather than lengths, so the operand a
user inserts from the legend and the series the backend computes cannot drift
apart.

| Output | Meaning |
|--------|---------|
| `tl_support` | Projected price of the nearest live unbroken major support line. |
| `tl_resistance` | Same, resistance. |
| `tl_broken_support` | Projected price of the most recently broken support line, during its `breakHoldBars` window. |
| `tl_broken_resistance` | Same, resistance. |

All four are prices, matching FVG's all-price convention, so a break-and-retest
rule is `close crosses below tl_broken_support` with no flags and no state in
the rule. All four are `undefined` when no line qualifies, as `SR_LEVELS`'
support and resistance already are.

Warm-up floor, shared by all four outputs:
`TL_ATR_LEN + 2 * pivotLen + minSpanBars`. ATR must be warm, two pivots must
confirm, and they must span the minimum. Unlike `fvgWarmup()`, this takes the
parsed config.

## Rendering

Drawn in the template's `draw` callback, not as overlay objects. That keeps it a
toggleable indicator rather than dozens of entries in the user's saved drawing
set.

Each live line draws from `i1` to `min(lastTouchIdx + maxProjBars, right edge)`,
subject to the extend option: solid while unbroken, dashed and faded during the
break-hold window. Touch count as a small end label, so the reason a line
outranked another is visible at a glance. Colors from `chartTheme`, never
hardcoded.

## Files

**Frontend**

- `lib/indicators/trendlinesOutputs.ts` — new leaf: output names,
  `TrendlinesConfig`, `parseTrendlinesConfig`, `trendlinesWarmup`. **No
  klinecharts import**, so `exprInstances.ts` stays node-testable. This is the
  same split, for the same reason, as `fvgOutputs.ts` and `slopeOutputs.ts`.
- `lib/indicators/trendlines.ts` — `computeTrendlines`, `TRENDLINES_TEMPLATE`,
  the `draw` callback; re-exports every name from the leaf so importers are
  unaffected.
- `lib/customIndicators.ts` — add to `CustomIndicatorType` and `BASE_TEMPLATES`.
- `lib/indicatorMeta.ts` — menu entry, the eight numeric inputs with tips, and
  the extend select.
- `lib/exprInstances.ts` — add to `EXPR_INSTANCE_TYPES` and its two branches.

**Backend**

- `backend/auto_trader/indicators/trendlines.py` — `parse_trendlines_config`,
  `trendlines_outputs`, `trendlines_series`, `trendlines_warmup`, ported
  operation-for-operation per `core.py`.
- `backend/auto_trader/indicators/registry.py` — one `IndicatorSeriesSpec`
  entry.

## Testing

Beyond ordinary unit coverage of pairing, pruning and ranking, three tests carry
the design:

1. **Violation-gate boundary.** A bar exactly at `line + violTol`, and one a
   single ULP beyond. This is precisely where a slope-and-project implementation
   diverges between runtimes, so it is the test that earns the cross-product
   form.
2. **Causality.** For every `i`, computing over `bars[0..i]` must equal the
   full-series output at `i`. This is the property that protects backtests from
   lookahead, and a trendline detector is the likeliest indicator in this
   codebase to break it by accident.
3. **DXY acceptance fixture.** The 470 DXY monthly bars frozen as JSON; assert
   the detector surfaces the three hand-drawn lines: resistance 2002-03 (119.61)
   to 2007-08 (82.132), support 2011-05 (72.696) to 2021-01 (89.203), resistance
   2022-09 (114.687) to 2025-01 (109.879). This is what makes "reliably" a thing
   that can fail a build.

Plus `trendlinesParityGolden.test.ts` and a JSON case file, mirroring
`slopeParityGolden`.

## Risks

**RESOLVED DURING IMPLEMENTATION: line A is not an acceptance criterion.** This
section originally required the detector to find all three hand-drawn lines.
Measured against the real fixture that was wrong in two independent ways, and
the acceptance test is what caught it.

*Its stated anchors are not pivots.* The fixture reads 2002-01 120.51, 2002-02
120.4, 2002-03 119.61, 2002-04 118.7 — a monotonic decline, so 2002-03 is not a
local high at any lookback, strict or otherwise. The anchors came from an upper
convex hull over BARS, which may anchor anywhere; the algorithm pairs fractal
PIVOTS. Those are different sets and this spec never reconciled them. Any future
work here starts from that distinction, not from the value of `pivotLen`.

*And the trend itself is dead.* The classic pair a trader would draw, the
2001-07 peak (121.02) to the 2005-11 high (92.63), are both pivots at every
lookback tested, and that line is pierced by only 0.765 x ATR at 2002-02, so
`violMult >= 0.77` would admit it geometrically against the 0.25 default. But
price rose back through it in early 2009, so it is correctly marked broken and
retires after `breakHoldBars`. It is a COMPLETED historical trend, which is
exactly why it was drawn by hand as a segment rather than a ray. A live-lines
list is right to omit it.

The acceptance test therefore expects lines B and C, both found with exact
anchors and prices, and separately pins the pivot arithmetic that puts line A
out of reach, so the limitation is a tested fact rather than a silent gap.

**Nearest-selection must not be preceded by a rank cap.** Taking the top
`maxLines` by rank and then selecting nearest-to-close discards the very line
nearest-selection would have chosen. Against the fixture that emitted
`tl_resistance` 121.187, a 2009-to-2017 artifact, while the live post-2022 line
projected 106.616. The pattern was borrowed from `SR_LEVELS`, where it is safe
because a HORIZONTAL level 500 bars old is still at the same price; a SLOPING
line projected 250 bars produces a number unrelated to price. `maxLines`
therefore governs the DRAWN set.

**But `maxLines` still bounds the operands indirectly, and the distinction is
easy to overstate.** Removing the rank slice from the emit path does not make
the parameter operand-neutral: live state is pruned to
`MAX_LIVE_MULT * maxLines` per side by rank, and the emit path selects from that
pruned array. Measured on the fixture at otherwise-default config, `maxLines` 2
against 3 changes the emitted value on 113 bars, including bars where
`tl_resistance` is undefined at 2 and 134.60 at 3, so a rule that fires stops
firing. `maxLines` 6 against 3 differs on 158 bars. Any user-facing copy must say
"does not slice", never "does not change".

**Breaks are detected on wicks, so `tl_broken_*` can fire on a spike.** Validity
and breakage share one predicate, which is what keeps the algorithm and the port
simple, but it means a single wick through a line retires it where a trader
watching closes would not consider it broken. `violMult` is the cushion, and
raising it is the documented response. Splitting the predicate — wicks between
the anchors, closes after — is the obvious alternative and was rejected because
it doubles the number of boolean gates that must agree across two runtimes,
which is the exact failure mode this design is built to avoid.

**Lines anchor where price actually held, not at the highest bar.** A user who
expects a line drawn from the obvious peak will otherwise read the containment
rule as a bug. The indicator's description text says so explicitly.
