# Sideless TRENDLINES: lines connect significant swings, high or low

Date: 2026-09-16. Supersedes the sided model in
`2026-08-17-trendlines-indicator-design.md` and the mixed-touch add-on in
`2026-09-07-mixed-pivot-trendlines-design.md`.

## Summary

Today a trendline has a side. Resistance lines are built from two swing
highs, support lines from two swing lows, and the side drives three rules:
what counts as a touch, what counts as a pierce, and when the line is broken.
A swing of the other kind can count as a touch ("mixed touches") but can never
be an anchor.

That model cannot produce the line a trader draws from the EURUSD 2021-01-04
weekly high (1.23495) through the Nov-2025 weekly low (~1.147): its second
anchor is a low, and price ran two to three ATR above it for eight months in
2025, which the pierce rule reads as a break.

This change removes the side. A trendline is a straight line through two
significant swings of either kind that enough later swings land on. Price may
cross it freely; crossings are counted and exposed, not penalised. The four
sided outputs are replaced by ranked `tl_1 … tl_N` plus `tl_nearest`.

Existing trendline instances on saved charts are NOT migrated (owner's call):
the calcParams layout is re-cut and old instances simply parse with defaults.

## Goals

- A line through any two significant pivots, high or low, in one pool.
- No broken state, no per-side anything. Max Pierce survives as a TOLERANCE
  (how far through a line a pivot may turn and still be counted, at full
  weight), never as the old sided break rule.
- Crossings counted per line, filterable, shown on the label.
- Ranked sideless outputs a rule can read.
- TS/Python parity preserved bit for bit on the goldens.

## Non-goals

- Migrating saved instances, presets or rules. Old rule tokens fall back to
  `tl_1` through the existing unknown-key path in `exprChartToken.ts`.
- Keeping the sided behaviour available behind a toggle.
- Any change to SR_LEVELS, PIVOT_BANDS or the drawing tool's manual segments.

## Algorithm

### Pivots

Unchanged fractal pivots with the same three gates (Min Pivot Length, Min
Pivot Size, Min Pivot Reach), computed for highs and for lows exactly as
today. The difference is storage: confirmed pivots of BOTH kinds go into ONE
pool in confirm order. A pool entry is `(k, price, kind)` where `price` is
`high[k]` for a swing high and `low[k]` for a swing low. `kind` is kept for
drawing (triangle direction) and MTF snapping (`htfExtremeSnap` needs to know
whether to snap to the base bars' high or low). No detector gate reads it.

Two pivots can confirm on the same bar (a bar that is both a fractal high and
a fractal low over its window). They enter the pool high first, then low, so
the order is deterministic and identical in both ports.

### Seeding

When pivot `k` confirms, it pairs with the previous `pairPivots` pool
entries, regardless of kind. Each pair `(i1, p1) -> (k, p2)` is a candidate.
Because the pool is shared, `pairPivots` reaches roughly half as far back in
time as before; the default moves from 20 to 40.

A candidate passes seeding when:

1. `k - i1 >= minSpanBars`, and every other span/slope ceiling in
   `overCeilings` holds (all side-agnostic already).
2. Retro touches: every pool entry strictly between `i1` and `k` is tested
   with the touch rule below and counted. `touches = 2 + retro`.
3. `touches` within the Touches range, gaps within the Spacing range.
4. Back clearance: with `minBackBars > 0`, the closes over
   `[i1 - minBackBars, i1)` never change side of the line (a close on the
   line is neutral). A window reaching before the first computed bar fails.
5. Crossings over `(i1, k]` are counted (rule below) and within the
   Crossings range. That is the general `(i1, i]` window of the Crossings
   section evaluated at the seed bar, where `i == k`.

The backward "before i1" mixed pass from the 2026-09-07 design is dropped: an
earlier pivot that lies on the line now forms its own, longer pair with the
same second anchor, so scanning backwards would only duplicate it.

### Touch

A pivot `(j, price)` with `j > i2` touches a line on one of two tolerances,
and which one applies is decided by the PIVOT'S KIND. A swing high tests the
line from below, so a high at or above the line has gone THROUGH it and a high
below the line stopped SHORT of it. A swing low tests from above and mirrors
that exactly: a low at or below the line pierces, a low above it stops short.

- Through, by at most `pierceMult * ATR14[j]`: a FULL touch, weight 1.
- Short, by at most `touchMult * ATR14[j]`: a HALF touch, weight 0.5.
- Anything further out on either side: not a touch.

A pierce is worth twice a gap because price cutting a line and turning there is
a stronger test of the line than price turning before it reaches it.

Both tests are cross-multiplied by the positive integer span `s = i2 - i1`, as
every gate in this detector is, with no quotient. Writing `d = (price - p1) * s
- (p2 - p1) * (j - i1)`, for a swing high the rule is `0 <= d <= pierceMult *
atr_j * s` for a pierce and `-touchMult * atr_j * s <= d < 0` for a gap; the
low case flips both signs. In code the comparison keeps the `lhs <= rhs + t`
shape rather than forming `d`, so the band edges land on the same bits in both
ports.

A touch of either weight adds its weight to `touches`, updates the touch-gap
bookkeeping and moves `lastTouchIdx` forward, so `touches` is a half-step sum
(exact in binary floating point) rather than an integer. `minTouches` /
`maxTouches`, `rankKey`, `survivalKey` and the label all read it as it is.

### Crossings

Per line, the number of times the close changes side of the line. For each
bar `j` in `(i1, i]` compute the sign of

    (close_j - p1) * s - (p2 - p1) * (j - i1)

A bar whose sign is 0 (close exactly on the line) keeps the previous sign. The
count increments on every bar whose non-zero sign differs from the last
non-zero sign. The first non-zero sign after `i1` sets the baseline and does
not count. Counted at seed time over `(i1, k]` and then incrementally per
bar for every live line, so the value at bar `i` depends only on `[0..i]`.

Crossings never invalidate a line by themselves; the Crossings range filter
is the only gate that reads them (default `0 – ∞`).

### Liveness and majority

- `isLive`: `i - lastTouchIdx <= maxProjBars`. No broken branch.
- `isMajor`: touches within range, span within range, spacing within range,
  slope within range, crossings within range. Same shape as today minus the
  broken clock.
- Back Clearance (see Seeding and Configuration) is the one gate that reads
  bars before `i1`: the close must not change side of the line over that
  window. The sided "line's own side" wording is gone.

### Dedup

`dropDuplicates` and `sharesPivot` stay, minus the side compare. `lineKey`
becomes `${t1}:${t2}`.

### Ranking

`rankKey(line) = (-touches, -span, crossings, -lastTouchIdx, i1, p1)`, where
`span` is `lastTouchIdx - i1`. Touches first, as today; longer span next; fewer
crossings ranks above more; then recency, then the first anchor's bar and
price. Two lines can still tie on all six (two anchors on the same bar at the
same price), so parity rests on a stable sort plus identical insertion order in
both ports, not on the key alone being total.

The live cap is `maxLines * MAX_LIVE_MULT` lines TOTAL (no per-side split);
lines beyond it are dropped when a new candidate is admitted, by the SURVIVAL
key below, not by `rankKey`.

### Survival vs rank

`survivalKey(line) = (crossings, -span, -touches, -lastTouchIdx, i1, p1)`,
where `span` is `lastTouchIdx - i1` as in `rankKey`. Ceiling-failed lines sort
last as before. This is the order the live cap slices on; `rankKey` is
unchanged and still fills `tl_1 … tl_N`.

They differ because they answer different questions. `rankKey` asks which
lines the user reads this bar and leads with touches. The cap asks which
lines are worth carrying, and a line is CONSTRUCTED ONCE, at its second
anchor's confirm bar, so losing the cap is permanent: at that moment the line
holds only its seed-time touches while the crowd around it has had years to
collect theirs. Leading with touches therefore evicts every long line at
birth. Measured with the touches-first order (cap sizes swept on a grid, so
each is an upper bound), the EURUSD weekly 2021-01 to 2025-11 line needed a
live cap of 400 lines to reach the last bar, the DXY monthly 2011-05 to
2021-01 line 1000, and the TSLA daily 2025-11 to 2026-04 line 1600, against
pane settings of 9, 3 and 3.

Crossings lead instead. The count already covers the whole span between the
anchors, so it means something the bar the line is born, and it does not
reward age the way touches and span do; price never having been on both sides
of a line is what a trader means by a line price respects. Under it the same
three lines need caps of 64, 224 and 128 (re-measured after the touch rule
split into Max Touch Gap and Max Pierce; the DXY line fell from 256, the TSLA
line rose from 96, and EURUSD is unchanged). Five of the six components are
integers and the sixth, `p1`, is a stored float compared only after the five
above it have tied, so both ports sort the same tuple bit for bit and parity is
structural.

Two of those three are still above `MAX_LIVE_MULT * maxLines` at the pane
default,
which is why `MAX_LIVE_MULT` is 16 rather than 4. Candidate keys built on span
(span first, or touches per span) were measured and rejected: they need caps
of 762 to 1639 on the same lines, because a shared pivot pool produces
hundreds of long pairs and span alone does not separate them.

### Emission

Per bar, take the live major lines sorted by `rankKey`:

- `tl_k` for `k in 1..maxLines` = `projectAt(rank_k, i)`, undefined when
  fewer than `k` lines qualify.
- `tl_nearest` = the projected price with the smallest `|v - close|`, ties to
  the better rank. Present whenever at least one line qualifies.

Selection for drawing is the emitted set: the top `maxLines` by rank, same
order, same cut. This replaces `selectDrawnLines`' per-side proximity walk.

Declutter and Merge act on the DRAWN set only; pinned lines are exempt; an
operand's line may be hidden when the user asks for it, and the operand still
emits.

## Causality and parity

Unchanged contract: values at index `i` depend only on inputs `[0..i]`;
every gate is a cross-multiplied boolean; division survives only in
`projectAt`; the Python port is written operation for operation from the TS
and the goldens assert equality. The crossing counter is the one new piece of
state and follows the same rule (sign of a cross-multiplied difference, no
quotient).

## Configuration

New calcParams layout. Slots are storage, the panel resections them.

| slot | key | default | panel |
|---|---|---|---|
| 0 | pivotLen | 5 | Pivots: Min Pivot Length |
| 1 | touchMult | 0 | Line Fit: Max Touch Gap (ATR) |
| 2 | minTouches | 2 | Filters: Touches min |
| 3 | minSpanBars | 20 | Filters: Span min |
| 4 | maxProjBars | 250 | Max Projection |
| 5 | maxLines | 3 | Max Trendlines |
| 6 | minSwingAtr | 0 | Pivots: Min Pivot Size |
| 7 | minSwingReach | 0 | Pivots: Min Pivot Reach |
| 8 | pairPivots | 40 | Pivots: Max Pivot Pairs |
| 9 | maxTouches | 0 (∞) | Filters: Touches max |
| 10 | maxSpanBars | 0 (∞) | Filters: Span max |
| 11 | maxSlopeAtr | 0 (∞) | Filters: Slope max |
| 12 | minSlopeAtr | 0 | Filters: Slope min |
| 13 | maxTouchSpacing | 0 (∞) | Filters: Spacing max |
| 14 | minTouchSpacing | 0 | Filters: Spacing min |
| 15 | minCrossings | 0 | Filters: Crossings min |
| 16 | maxCrossings | 0 (∞) | Filters: Crossings max |
| 17 | pierceMult | 0.25 | Line Fit: Max Pierce (ATR) |
| 18 | minBackBars | 0 | Line Fit: Back Clearance (bars) |

Removed: breakHoldBars (Break Hold), mixedTouches (Mixed toggle). Back
Clearance returns in sideless form (slot 18, default off; the sided version
shipped at 10): over the `minBackBars` closes before `i1` the close must not
change side of the line's backward extension. It is a seed-time gate, reads
only bars before `i1`, so it never repaints, and rejects when the window
reaches before the first computed bar. The old sided violMult was a BREAK rule; slot 17's
Max Pierce is not that. It never invalidates a line, it only says how far
through the line a pivot may turn and still be counted, and a pivot that does
counts double one that stops short. Presets (Clean / Balanced /
Busy) are re-baked onto the new slots with the same intent: Clean = fewer
lines, more touches, wider span; Busy = more lines, shorter span.

`maxLines` is clamped to 50 at parse time in both ports (`MAX_MAX_LINES`).
The slot was re-cut by this change, so a pane saved under the old layout reads
its Max Projection (250) into it, and each unit costs a rule operand plus
`MAX_LIVE_MULT` live lines.

The settings-pinned timeframe (`extendData.mtf.timeframe`) is unchanged.

## Outputs

`trendlinesOutputs(cfg)` / `trendlines_outputs(cfg)` return
`["tl_1", …, "tl_<maxLines>", "tl_nearest"]`. The list is config-driven, which
both registries already allow (the Python spec takes `cfg`; `exprInstances`
computes its operand list per instance).

- `exprChartToken.ts`: an unknown or missing key resolves to output[0], now
  `tl_1`. Old `tl_support` / `tl_resistance` / `tl_broken_*` tokens therefore
  read `tl_1` without error.
- `exprInstances.ts`: operand list per instance from `trendlinesOutputs(cfg)`;
  warm-up unchanged (`TL_ATR_LEN + 2 * pivotLen + minSpanBars`) for every
  output.
- `mtfCoordinator.ts`: `buildTrendlinesMtf` aligns each `tl_k` and
  `tl_nearest` array onto base bars the way it aligns the four sided arrays
  today; only key names change.

## Rendering

- One hard-coded line colour, `TL_LINE_COLOR`, replacing `TL_SUPPORT_COLOR` /
  `TL_RESISTANCE_COLOR`. The pane paints its own canvas and has no colour
  picker today; that stays as it is.
- Label at the right end: `×T ⇅C` (touches, crossings). `⇅C` is omitted when
  `C` is 0. `T` is a half-step sum, so it prints as `×3.5` when a half touch is
  in it and `×3` when it is not.
- Pivot triangles keep their direction from `kind`.
- End-handle pins, dimming, declutter and MTF alignment behave as today; the
  side-dependent branches inside them collapse to the single case.
- Declutter and Merge act on the drawn set only; pinned lines are exempt; an
  operand's line may be hidden when the user asks for it, the operand still
  emits.

## Files

**Frontend**

- `lib/indicators/trendlinesOutputs.ts`: new `TrendlinesConfig`, defaults,
  `parseTrendlinesConfig`, `trendlinesOutputs(cfg)`, `trendlinesWarmup`.
- `lib/indicators/trendlines.ts`: detector rewrite (`TrendLine` without
  `side`, shared pool, touch/crossing rules, ranking, emission), template,
  draw path, `lineKey`, dedup, MTF alignment.
- `lib/indicatorMeta.ts`: TRENDLINES inputs and tips, presets.
- `IndicatorSettings.tsx`: no change required (the boolean-in-calcParam
  branch is generic and harmless once the Mixed row is gone).
- `lib/exprChartToken.ts`, `lib/exprInstances.ts`: output list from cfg.
- `lib/mtfCoordinator.ts`: `tl_k` alignment.
- `chart/useTrendlinePins.ts`, `ChartLegend.tsx`: only if they read `side`.

**Backend**

- `auto_trader/indicators/trendlines.py`: rewrite in lockstep.
- `auto_trader/indicators/registry.py`: unchanged entry (outputs already
  config-driven).

## Testing

- Parity: regenerate `indicatorParityGolden.test.ts` goldens from the TS on
  the DXY and TSLA fixtures; `backend/tests/test_indicator_parity.py` asserts
  the Python matches.
- TS units (`trendlines.test.ts`, `trendlinesOutputs.test.ts`): shared-pool
  pairing incl. a same-bar high+low pivot, two-tolerance touch weighting by
  pivot kind, crossing
  count incl. the zero-sign and baseline rules, liveness without break,
  ranking order, `tl_k` / `tl_nearest` emission, dedup, config parsing and
  defaults. Sided tests that no longer apply are deleted, not adapted.
  `trendlines.incremental.test.ts` and `trendlines.clip.test.ts` keep their
  intent (live-bar stepping equals batch; strokes clipped to range).
- Acceptance fixture `trendlinesEurusd.fixture.json` (Capital weekly EURUSD):
  at default settings a line anchored on the 2021-01-04 high and the Nov-2025
  low is emitted, and `tl_nearest` reads it on the last bar.
- Consumers: `exprChartToken.test.ts`, `trendlines.register.test.ts`,
  `mtfCoordinator.test.ts` updated to the new names.
- Backend: `test_trendlines_indicator.py` mirrors the TS units it already
  mirrors.
- Run only the touched test files; never the whole frontend suite.

## Risks

- **Candidate volume.** Every adjacent high→low leg is a two-touch pair, so
  raw candidates roughly double. Min Span (20) drops the short legs and
  ranking places two-touch lines below anything with three. Expect the
  default to feel busier; tune Max Trendlines / Touches min after seeing it,
  not before.
- **Cost.** Seeding scans `(i1, k]` for crossings; today it scans the same
  range for pierces, so the order is unchanged. `pairPivots` 40 doubles the
  pairs per confirm; still `O(P * n)`.
- **Rank churn.** `tl_1` can change identity between bars when ranks swap.
  The sided outputs already did this via nearest-to-close; `tl_nearest` keeps
  that behaviour for rules that want proximity.
