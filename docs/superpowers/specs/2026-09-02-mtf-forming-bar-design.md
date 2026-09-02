# MTF forming-bar calculation ("Wait for timeframe closes")

**Date:** 2026-09-02
**Status:** Implemented (frontend), 2026-09-02
**Scope:** Frontend only. Backend indicators, expr evaluator, and backtests are untouched.

## Problem

An indicator pinned to a higher timeframe (e.g. Trendlines on 1D over a 1H
chart) computes on **closed HTF bars only** (`applyTrendlinesTimeframe`'s
closed filter in `mtfCoordinator.ts`; `alignHtfToChart(waitClose=true)` in
`mtf.ts`). The newest usable HTF bar therefore sits up to a full HTF period
behind the newest chart candle, so lines/series visibly end before the last
bar, and live operands read values that are up to one HTF bar stale.

TradingView's "Wait for timeframe closes" checkbox, when **unchecked**, feeds
the still-forming HTF bar into the HTF study so values extend to the newest
LTF bar, repainting when the HTF bar closes. This design adds that option —
minus TV's historical-repaint lookahead.

## Decisions (made with the user)

1. **Calculation-affecting, not draw-only.** The forming HTF bar participates
   in the per-indicator compute (it can seed touches, breaks, gaps, etc.).
2. **All six MTF pins**: MA/EMA, Pivot Bands, SR Levels, Trendlines, FVG,
   Slope.
3. **Operands too, live only.** Live rule evaluation reads the frontend calc
   output, so it sees forming-bar values automatically. Backtests run in the
   backend (`align_htf_to_base`, closed-bar) and are deliberately unchanged;
   live and backtest may diverge intra-HTF-bar by design.
4. **Approach A** (client-side fold, below), default **checked** (= today's
   behavior; unchecking opts into the fold).

## Semantics

- **No historical lookahead.** Alignment for all *closed* HTF bars keeps
  waitClose semantics exactly as today: a chart bar never reads a closed HTF
  bar before that bar's close. Only the **forming** bar is admitted, and only
  from its open, for the chart bars it spans. History never changes meaning.
- **Repaint on HTF close is inherent and accepted.** A line the forming bar
  "broke" un-breaks if the bar closes back inside; values settle at the HTF
  close. This is the TV contract for the unchecked box.
- **Replay** gets the same semantics: the fold input is clamped to chart
  candles at/before the cursor, folded into the bucket containing the cursor.
- **Parity is unaffected.** The pure computes (`computeTrendlines`, the MA
  math, etc.) are not modified — only which bars they are fed and how the
  result is aligned. The TS/Python parity goldens keep passing unchanged.

## Architecture (Approach A: client-side forming-bar fold)

### New shared module `frontend/src/lib/mtfForming.ts`

Pure functions, no chart dependency:

- `foldFormingBar(chartBars, formingOpenMs, htfMs, seed?)` → one synthetic
  KLineData: o = seed's open (or first folded candle's open), h/l = max/min
  across seed + folded candles, c = latest close, timestamp = formingOpenMs.
  Folds every chart candle with `timestamp >= formingOpenMs` (and
  `<= cursorMs` under replay). Chart candles are the pane's own price side, so
  the fold is side-consistent with the HTF fetch by construction.
- `formingOpenMs(closedStarts, htfMs, fetchedFormingBar?)`: the fetched
  partial bar's own timestamp when the fetch returned one (authoritative for
  calendar-bucketed TFs — weeks, months, year — whose spans are not nominal),
  else `lastClosedStart + htfMs`.

### Coordinator changes (`mtfCoordinator.ts`)

- Each `apply*Timeframe` already has the closed HTF bars and its pure compute.
  When the pin's `waitClose` flag is **false**, it additionally stashes what
  the fold needs on `extendData.mtf`:
  - the full closed HTF candle array the compute ran on (session-only, a few
    hundred bars — a truncated tail would let a recompute disagree with the
    stashed series, e.g. trendlines seeded from older pivots), and the fetched
    forming partial bar as the fold seed;
  - a `waitClose: boolean` field (absent = true, today's behavior).
- A new `refreshFormingBar(chart, epic)` entry point: for every pinned
  indicator with `waitClose === false`, fold the forming bar from the chart's
  dataList, append to the stashed closed bars, re-run that indicator's pure
  compute, and rewrite `extendData.mtf` with the recomputed series where the
  **last entry is the forming bar**, flagged (`formingIdx` or equivalent) so
  alignment can treat it specially. Throttled to ~1/s per chart; HTF series
  are a few hundred bars, so full recompute (including trendlines) is cheap.
- Trigger: the live newest-candle update path (`useLiveMarketData`) calls
  `refreshFormingBar` on each update of the newest chart candle; replay's
  cursor-advance path calls it with the cursor.
- When the forming bucket **closes** (detected because a folded bucket's close
  ≤ newest candle time), fall through to the existing full `apply*` refresh so
  the bar graduates from folded to fetched-closed.

### Alignment (`mtf.ts`)

`alignHtfToChart` keeps waitClose semantics for all bars except the flagged
forming entry, which is usable from its **open**. Implemented as a small
extension (e.g. optional `formingIdx` parameter or a wrapper) — the closed-bar
loop is untouched, and existing callers/tests are unaffected.

### Draw path

No per-indicator draw changes expected: once the forming bar is the last
entry, trendlines' `lastIdx` becomes the forming HTF bar and `toChart`'s
extrapolation carries line ends to the newest chart candle; the other
indicators' series simply extend. Verify visually per indicator.

## UI & persistence

- Checkbox **"Wait for timeframe closes"** (TV's exact label) in
  `IndicatorSettings.tsx`, in the Calculation group directly under the
  Timeframe picker, rendered only when a non-"chart" timeframe is selected.
- Per indicator instance. Persisted as `extendData.mtf.waitClose` alongside
  `timeframe` (the only two mtf fields persisted; series stay session-only,
  matching the existing rule).
- **Default: checked** — existing panes and new pins behave exactly as today.

## Error handling

- Broker down / fetch failed: the fold only ever runs on top of a stashed
  closed series; with nothing stashed it does nothing (existing retry machinery
  owns recovery).
- No chart candles inside the forming bucket yet (fresh bucket, first tick not
  landed): fold yields just the seed, or nothing — series falls back to
  closed-bar values, never blanks.
- Pin below chart / alias timeframes: same guards as today (`nominalBarHours`);
  the fold derives the bucket from the fetch's own forming bar where possible.

## Testing

- `mtfForming.test.ts`: fold across bucket boundary; seed + newer candles;
  calendar-TF bucket open taken from the fetched partial bar; replay cursor
  clamp; empty-bucket edge.
- `mtf.test`: forming entry admitted from open, closed entries still waitClose,
  no change when no forming entry is flagged.
- Per-indicator coordinator tests: with `waitClose: false` the stashed series
  gains exactly one forming entry that (a) updates when the newest chart candle
  changes, (b) disappears when the box is re-checked, (c) graduates to a closed
  entry after the bucket closes.
- Trendlines-specific: a forming bar that pierces a line marks it broken on
  screen and in the operand series, and the break reverts if a later fold pulls
  the extreme back inside.

## Out of scope

- Backend/backtest forming-bar simulation (explicitly deferred).
- TV's historical repaint (chart bars inside *closed* HTF bars reading that
  bar's final value from its open) — rejected as lookahead.
- Draw-only extension modes (already exist via `extend` modes; unchanged).
