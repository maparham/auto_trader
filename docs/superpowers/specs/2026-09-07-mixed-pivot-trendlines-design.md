# Mixed-pivot trendlines

Status: approved design, not yet implemented
Date: 2026-09-07

## Problem

TRENDLINES keeps two pivot pools and builds every line from two pivots of the
same side: resistance from bar highs, support from bar lows. A pivot of the
opposite side can never take part in a line, however exactly it sits on one.

Observed on TSLA daily. The support line `2025-11-14 (380.92) -> 2026-04-07
(337.19)` projects to **484.16** on 2024-12-18, and that bar's high is
**488.36** — 4.2 points, 0.27 ATR away. To a reader the three points are one
line. The detector cannot see the third, because it is a high on a support
line, so it draws the line only from 2025-11-14.

The workaround today is the `Extended both ways` draw mode, which extends
*every* line backwards by `Max Projection` bars whether anything anchors it
there or not. It reaches the right place for the wrong reason and clutters the
pane.

## Rule

When the option is on:

> A pivot of **either** side counts as a touch on a line if its extreme lands
> in that line's touch band. It never becomes an anchor, so it never rotates
> the line.

Which extreme: the pivot's own. A resistance pivot contributes its bar's
**high**, a support pivot its bar's **low** — the same price
`pivotPrice(pivots, side, idx)` already returns, read with the *pivot's* side,
not the line's. The touch band is the line's (`inTouchBand`), but its
asymmetry **mirrors by pivot side** (amended 2026-09-07, superseding the
original "unchanged" wording): an opposite-side extreme that *crosses* the
line is judged by Max Pierce, one that stops *short* of it by Max Touch Gap —
the same meaning each tolerance has for the line's own side, read from the
extreme's geometry. Mechanically the mixed-touch tests call `inTouchBand`
with the two tolerances swapped. On the motivating TSLA line the 2024-12-18
high crosses 0.21 ATR through the support line, so it is admitted by the
default Max Pierce with Max Touch Gap still 0.

Three things stay exactly as they are, and they are what keeps a trendline
meaning what it means:

- **Anchors.** Only same-side pivots seed a line. Geometry is untouched.
- **Pierce and break tests.** Still test the line's own side only
  (`extremeOf(side, j)`). A support line still guarantees "no bar's low went
  below me, within tolerance", over `(i1, ...]` exactly as before.
- **Seed validation.** The forward walk `(i1, i]` is unchanged.

What changes is `touches`, and where the line starts drawing.

### Backward reach

The opposite-side touch that motivates this sits *before* `i1`. Nothing in the
detector looks before `i1` today except `hasBackClearance`, so this is a new
scan, run once at seed time:

- Walk the opposite pool over `[i1 - maxProjBars, i1)`.
- For each entry, `inTouchBand(cand, j, pivotPrice(pivots, opp, j), violMult *
  atr[j], touchMult * atr[j])`.
- Every hit increments `touches` and appends to `touchIdxs`.

Bars in that window are **not** pierce-tested. That leg is geometry, not a
guarantee — on the TSLA line price falls ~60 points through it within days of
the high. `Min Back Clearance` continues to apply to its own window before
`i1`, unchanged; the two do not interact.

`maxProjBars` bounds the scan because it is already the horizon the forward
projection and `Extended both ways` use. No new bound, no new setting.

### Forward opposite-side touches

Symmetric and included: in step 2a, a newly confirmed pivot is tested against
lines of **both** sides rather than only its own. Restricting the rule to the
backward direction would be arbitrary — "a pivot on the line counts" is one
predicate or it is a special case.

## Data model

`TrendLine` gains one field:

```ts
/** Earliest touch, `i1` unless an opposite-side pivot before `i1` landed in
 * the touch band. DRAW-ONLY, like `touchIdxs`: no gate reads it, so it cannot
 * move an emitted value. */
firstTouchIdx: number;
```

Seeded to `i1`, only ever moves backwards, and only at seed time.

`touchIdxs` keeps its existing contract — length always equals `touches`, order
irrelevant — so the touch rings the pane paints pick the new marks up for free.

## Config

`calcParams[16]`, `mixedTouches`, `1` = on, `0` = off, **default `1`**.

Parsed with the `allowZero` rule so an explicit `0` is honoured rather than
falling back to the default, then floored and clamped to `[0, 1]`. A chart
saved before this parameter existed reads `undefined` here and gets `1`, which
is intended: the option ships on.

Panel (`indicatorMeta.ts`): a checkbox under FILTERS, *"Count opposite-side
pivots as touches"*, with a tip naming the consequence — that it raises touch
counts and so interacts with `Min Touches` / `Max Touches`.

## Draw path

`lineExtent` takes `jLeft` from `firstTouchIdx` instead of `i1` for the
stopping modes:

```ts
const jLeft = mode === "extended" ? line.firstTouchIdx - cfg.maxProjBars
                                  : line.firstTouchIdx;
```

`Extended both ways` keeps its meaning, now measured from the earliest touch.
No other draw-path change: handles, clipping and the `x N` tag already read
`touches` and the drawn segment.

## Parity

`backend/auto_trader/indicators/trendlines.py` ports the same predicate,
operation for operation. Everything added here is a boolean that gates set
membership, so it carries no quotient: the backward scan reuses `in_touch_band`,
which is already cross-multiplied by the exact positive integer span.

`firstTouchIdx` is draw-only and has no Python consumer, but it is ported
anyway so the two `TrendLine` shapes stay identical — the parity suite compares
whole lines.

## Testing

- **Unit, both runtimes:** an opposite-side pivot inside the band counts; one
  outside does not; one beyond `maxProjBars` before `i1` does not; the option
  off restores today's counts exactly.
- **Invariant:** with the option on, no line's `i1`/`p1`/`i2`/`p2` differs from
  the same run with it off. Geometry must be untouched — this is the test that
  says the change is additive.
- **Acceptance (`trendlinesDxy.test.ts`):** the two hand-drawn DXY lines still
  come out. New case: the TSLA line reaches 2024-12-18 at `touchMult >= 0.3`
  and tags `x3`.
- **Parity golden:** regenerated, with the diff reviewed rather than accepted
  blind.
- **Config parsing, both runtimes:** `0` honoured as off; absent means on;
  junk falls back to on. The TS/Python `Number()` vs `float()` divergence
  already covered for the other params applies here too.

## Impact

Measured on the DXY monthly fixture (490 bars, 23 live lines) by testing every
opposite-side pivot against every line's band at the current geometry:

| Config | Lines gaining a touch | Extra touches | Lines reaching back |
|---|---|---|---|
| defaults (`touchMult` 0.75) | 9 / 23 | 15 | 9 |
| `touchMult` 0.3 | 8 / 23 | 11 | 8 |
| `touchMult` 0 | 5 / 22 | 5 | 5 |

So roughly two lines in five gain a touch at default settings. Because
`touches` feeds `isMajor`, `rankLines` and the `Max Touches` ceiling, some
`tl_*` values move. Default-on makes that a silent change for every existing
chart and for any rule reading those operands; the regenerated golden is where
that gets reviewed.

## Out of scope

- Opposite-side pivots as **anchors** (option B in the discussion). That would
  relax the pierce guarantee on the leading leg and change what a trendline
  asserts. Not this change.
- Least-squares fitting through three or more points. Lines stay defined by two
  exact anchors and never rotate.
- A separate tolerance for opposite-side touches. They reuse the line's two
  existing tolerances, mirrored by pivot side (see the Rule amendment above) —
  no new setting. A pivot that stops short of the line still answers to
  `Max Touch Gap`, so at 0 near-misses are not collected, which is the honest
  reading of that setting.
