# Viewport-Scoped Indicator Coverage

**Date:** 2026-09-09
**Status:** Approved design, pre-implementation
**Scope:** frontend chart indicators. Two halves: (1) the MTF coverage contract
in `frontend/src/lib/mtfCoordinator.ts`, (2) the chart-timeframe trendlines
compute window in `frontend/src/lib/indicators/trendlines.ts`.

## Problem

Every MTF indicator (a pinned Trendlines, FVG, SR Levels, EMA/MA, Pivot Bands,
Slope) keeps a stash of higher-timeframe bars. The current invariant is: the
stash reaches from the live edge back to the chart's oldest loaded bar plus the
type's warmup. `extendMtfCoverage` reads `getDataList()[0].timestamp` and
`refreshMtfIndicators` refetches and recomputes any indicator whose stash falls
short.

This couples indicator cost to loaded depth, not to what is on screen. Loaded
depth used to move ~500 bars per scroll-back page; the pattern-match jump,
go-to-date, and backtest drill-in can move it by years in one click. Measured
symptom: clicking a preset pattern match on OIL_CRUDE HOUR (matches in
2019-2020) stalls for many seconds while:

- the HTF walk fetches up to 40 sequential pages (`HTF_PAGE_BARS = 900`,
  `HTF_MAX_PAGES = 40`) per pinned timeframe, and
- each pinned indicator recomputes over up to ~36k HTF bars, and
- each chart-timeframe Trendlines instance rebuilds its calc-session state
  over all ~40k+ freshly loaded chart bars (the prepend changes dataList
  identity, which invalidates the incremental session), and
- the enlarged stash is permanent for the session, so every later full refresh
  (symbol change, side change, config edit) re-pays deep-history cost.

The `coveredFromMs` stamp (commit 5415c0d0) already stopped the *recurring*
re-walk; this design removes the one-time deep-cover cost and the session
permanence.

## The new contract

> The stash covers one contiguous interval `[coveredFromMs, coveredToMs]` that
> contains the visible range plus the type's warmup on the left and a prefetch
> margin of one screenful on each side (right margin clamped to the live edge).

Properties:

- **Two-ended, monotone, never sparse.** The interval extends left when the
  view moves left past covered ground, and right when it moves right past
  `coveredToMs`. No interior holes ever exist, so the coverage guard stays a
  two-number comparison per end.
- **Detachable from the live edge.** After a deep jump the interval covers only
  the landing window; `coveredToMs` sits years behind the live edge. Scrolling
  back toward the present extends right until the interval re-docks at the
  live edge (the normal, docked state).
- **Rebase on far jumps.** When the needed interval (which always carries a
  one-screenful margin) is disjoint from the covered interval by more than one
  HTF bucket, drop the stash and cover just the needed window; overlapping or
  touching intervals union. Plain disjointness is the whole rule: the margin
  makes near-misses overlap. This is what makes a 2019 click cost a few
  hundred HTF bars instead of seven years.
- **Ask semantics preserved.** `coveredFromMs` keeps its meaning of "how far
  the last successful walk ASKED", so a config that out-asks the broker's
  history stays terminal (the OIL_CRUDE freeze fix). `coveredToMs` carries the
  same semantics on the right.
- **Recompute over the whole interval per extension.** Detector state is
  left-to-right sequential; left extensions rebuild. The interval only contains
  where the user has actually been, so cost is bounded by usage; a long organic
  scroll-back degenerates gracefully into today's behavior, which was never the
  pain.

## Trigger

One debounced (~200 ms) visible-range subscription per chart replaces the
"history grew" trigger:

- On settle, derive `neededFrom = viewFrom - screenful - warmup` and
  `neededTo = min(viewTo + screenful, liveEdge)` from `getVisibleRange()`
  timestamps. Compare against each pin's interval; extend or rebase as needed.
  Warmup is per type and per instance (existing `tlWarmup`, `srWarmup`,
  `fvgReachBack`, `pivotWarmup`, MA length + smoothing, slope reach-back).
- Existing `extendMtfCoverage` call sites (scroll-back loader, jump landing,
  quick-range cover, backtest trade cover) collapse into "poke the subscription
  now". None of them passes oldest-loaded-bar any more.
- Fresh applies (symbol change, timeframe change, config edit, template load,
  persistence rehydrate) cover the current viewport's window, not full loaded
  depth. This removes the session-permanence cost.
- The in-flight coalescing in `refreshMtfIndicators` keys on the needed
  interval instead of `oldestChartMs`.

## Fetch

`fetchHtfBars` fetches only the missing span (left gap, right gap, or the full
needed window on rebase), through the interval store `fetchHtfInterval` in
`htfBarCache` (one stored bar interval per broker/epic/timeframe/side; the old
live-edge-bucketed `fetchHtfShared` key is gone, and right-edge freshness is a
per-entry TTL revalidation that refetches from the last stored bar). Spans are
fetched with parallel window lanes (`fetchSpanParallel` in `historyPaging`,
concurrency 6): both endpoints are known up front. Failure semantics
unchanged: a failed window keeps the contiguous newest-side prefix, marks
`failed: true`, and the existing retry/backoff path handles it; only a
successful walk stamps the ask.

## Live edge, forming bar, replay

- **Docked** (interval reaches the live edge): forming-bar fold, live-tick
  refresh, and the replay bucket-crossing refresh work exactly as today.
- **Detached:** the forming fold and live-tick refresh are skipped for that
  stash; the live edge is off screen and its bars are not in the interval.
  Re-docking resumes them. `refreshFormingBar` gains a cheap docked check.
- **Replay:** no dedicated pre-cover turned out to be needed. Session entry
  re-runs the load effect's `refreshMtfIndicators` (now viewport-derived), the
  no-lookahead clamp cuts fetched bars at the cursor as before, and the
  existing bucket-crossing refresh re-covers as the cursor advances, each time
  against the then-current view. The cursor path, `mtfBucketMs` grid, and the
  clamp are unchanged.

## Chart-timeframe trendlines compute window

The trendlines calc session gets a compute-window floor:

- The same viewport settle stamps `extendData.tlFloorTs` (the view's left end,
  which already carries the screenful margin, minus `tlWarmup(cfg)` in chart
  bars) via `stampTrendlinesFloors`, which triggers a recalc.
- `buildTlState` starts from the bar at `tlFloorTs` instead of bar 0. The
  floor moves left whenever the view outruns it; it rebases RIGHT only after
  the wanted floor drifts more than `FLOOR_REBASE_SCREENS` (4) view-widths
  past the stamp, so ordinary scrolling never churns rebuilds while a return
  to the live edge after a deep jump drops the deep-history compute cost. Each
  floor move rebuilds from the new floor; the per-tick incremental right edge
  is untouched.
- After a deep jump, the prepend-invalidated rebuild runs over the landing
  window instead of the full loaded list.

Only Trendlines gets this in v1; it is the only chart-TF type with an observed
cost. EMA-style full-left warmup semantics make compute-scoping per-type work,
deliberately out of scope.

## Accepted behavior changes

1. **Pop-in.** Fling-scrolling left shows candles whose indicator lines land a
   beat later, matching how candles themselves stream in. One screenful of
   prefetch margin, no more.
2. **Geometry refinement.** Trendlines, SR Levels, and FVG are best-effort over
   covered history: a line anchored to a pivot left of the interval does not
   exist until coverage reaches it, and extending coverage can add or adjust
   visible lines. Same semantics as today's shallow-broker-history case, now
   routine.
3. **Parity.** Backend rule/alert/backtest evaluation is server-side over its
   own window and never reads this stash; no change.

## Consumer audit (must hold at review time)

- `calc` alignment (`alignHtfToChart` and per-type calc branches): aligns by
  timestamp; chart bars outside the interval get no values. Verified paths
  render blanks, not errors.
- Draw paths (trendlines lines, SR levels, FVG boxes): already cull by
  timestamp mapping; must tolerate an interval not reaching either edge.
- `refreshFormingBar` / companions (`syncAccelCompanion`,
  `syncPivotBarsSinceCompanion`): docked check added; companions mirror the
  parent stash and inherit the interval.
- Replay (`useReplay`): eager pre-cover at start; cursor clamp unchanged.
- Rule clipboard / IndicatorSettings: call `refreshMtfIndicators` with no
  oldest; they now cover the current viewport, which is strictly cheaper.
- Persistence: still saves only `mtf.timeframe`; rehydrate covers the viewport.

## Testing

- `mtfCoordinator.test.ts`: interval extends left and right; rebase on
  disjoint jump and on gap > factor; detached stash skips the forming fold and
  re-docks; `covered()` guard on both ends; failed-walk retry unchanged;
  out-asked-broker remains terminal; shared-walk dedup still holds.
- `trendlines.test.ts`: windowed `buildTlState` equals the full-span state over
  the shared window suffix; floor move rebuilds; per-tick incremental path
  byte-identical to today.
- Manual acceptance: OIL_CRUDE HOUR with mixed pinned + chart-TF Trendlines
  instances; a preset pattern-match click into 2019 lands with indicator work
  well under a second, and returning to live re-docks with no stall.

## Out of scope

- Viewport-scoping other chart-TF indicator computes (EMA warmup semantics
  need per-type care).
- Rendering-side culling (chart-draw-perf follow-ups).
- Any backend change.
