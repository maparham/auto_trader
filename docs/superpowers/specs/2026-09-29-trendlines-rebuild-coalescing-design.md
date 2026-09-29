# Trendlines rebuild coalescing

Date: 2026-09-29
Status: draft, awaiting review

## Problem

Scrolling left into history still pauses the chart when a Trendlines
instance is on it. The floor-slack fix (192ef617) stopped small scrolls from
re-stamping the floor, and big rebuilds now show the legend spinner
(f9aeafe6). What is left is the burst that follows a history load.

Measured on US100 1H, about 10k bars, one left scroll (2026-09-29, in-page
calc wrappers):

| What | Result |
|---|---|
| History prepends from the one scroll | 2 (9,481 to 9,824 to 10,168 bars) |
| Trendlines calc runs within about 1.5 s | 5 |
| Trendlines sync time | 82, 301, 28, 146 ms (about 557 ms in total) |
| RSI and EMA combined | about 115 ms |
| Trendlines runs that took the deferred path | 2 of 5 (the two cheap ones) |

Two causes:

1. **One rebuild per event.** Each prepend creates a new data list, and each
   one invalidates the session and rebuilds. The viewport pass then moves the
   floor (its debounce is 200 ms after the range settles), and that rebuilds
   again. Nothing merges these, so one gesture pays for several full
   rebuilds.
2. **The defer rule misses the expensive runs.** `calc` defers only when
   `rebuildSpan >= TL_DEFER_BARS` (2000). The floor keeps the span just under
   that, so the 82 ms and 301 ms prepend rebuilds ran synchronously, with no
   spinner painted first.

## Goal

After a history load, run at most one Trendlines rebuild per instance, and
always paint the busy spinner before it. Tick and append recalcs stay
synchronous and incremental, exactly as today.

Out of scope: moving the compute off the main thread (see Follow-up), and
the other indicators' prepend cost.

## Design

The changes are in the calc path of `frontend/src/lib/indicators/trendlines.ts`,
plus a one-line chart registration in ChartCore (see 2b).

### 1. Defer by kind, not by span

Classify each calc using what the session already knows:

- **Incremental:** `rebuildSpan(...) === 0` (same list, same config, same
  floor, bars only appended). Runs synchronously, as today.
- **Rebuild:** anything else (prepend, floor move, config change, first
  compute). Deferred whenever the list has at least `TL_DEFER_MIN_BARS` bars
  (new constant, 500). Below that a rebuild is cheap enough to run inline,
  which keeps first paint of a short chart instant.

`TL_DEFER_BARS` is removed. Deferring costs one paint (about 16 ms, capped
at 100 ms by `afterNextPaint`), which is small next to a 300 ms freeze.

### 2. Settle before computing

The deferred chain gets a trailing settle window before its paint wait:

```
calc (rebuild)  ->  mark busy, blank rows on a prepend, bump gen
                ->  wait until TL_SETTLE_MS pass with no newer calc
                ->  afterNextPaint
                ->  newest gen? compute : return current rows
                ->  clear busy
```

- `TL_SETTLE_MS` is 250, just over the 200 ms viewport-pass debounce, so a
  prepend and the floor stamp that follows it land in one window.
- Each new REBUILD calc for the instance restarts the window, so a run of
  prepends from one fast drag also collapses into one compute. A tick
  (same list, same config, same floor as the previous calc) does not restart
  it, or live ticks every 100 ms would hold the rebuild off forever.
- The window is capped at `TL_SETTLE_MAX_MS` (1000) from its first bump, so
  a continuous drag that prepends every 100 ms still computes within 1 s.
- While a rebuild is pending, the session has not seen the newest list yet,
  so `rebuildSpan` would misclassify. Calc therefore classifies a pending-path
  call by comparing its inputs (list object, config key, floor) with the
  previous calc's, kept in a per-instance WeakMap. Only when nothing is
  pending does it ask `rebuildSpan`.
- The existing generation check stays the arbiter: only the newest calc in
  the chain computes. Older links resolve with the current rows, as they do
  today.
- An incremental calc that arrives while a rebuild is pending chains behind
  it like today (the `pending` check stays first), so a live tick never
  computes on a half-updated session.

### 2b. Out of band, not a calc promise

klinecharts awaits every calc in a batch before it lays the chart out, and
holds later batches until then. A calc promise that waits out the settle
window would therefore freeze ticks and every other indicator on the chart
for that long (found in the final review; the first cut did exactly that).

So calc never returns a promise. A rebuild-kind calc returns the current rows
at once (none after a prepend) and schedules the rebuild outside klinecharts.
When it has computed, it stores the rows on the instance and asks for a
recalc through `chart.overrideIndicator({ name })`. By then the session is
built, so that calc is incremental and runs inline. ChartCore registers each
chart with `registerTrendlinesChart` so the rebuild can find its instance's
chart. A compute that throws is logged and does not ask for the recalc, or
it would retry forever; its window state is cleared either way.

Cost: after a prepend the lines stay blank, with the spinner showing, for
about 250 ms plus the compute, instead of flashing through several
intermediate states. The candles, other indicators, ticks and scrolling stay
live during the wait.

### 3. Timer hygiene

The settle wait uses `setTimeout`, not rAF, so a hidden tab still converges
(timers are throttled there, never paused). The wait is per instance, kept
in a WeakMap next to `TL_PENDING`, so removing the indicator lets it be
collected. A removed or hidden instance whose chain is still waiting simply
computes once into a result nobody reads, as the current chain already can.

## Testing

Unit tests in `trendlines.incremental.test.ts`, using fake timers:

- A prepend followed by a floor change within 250 ms computes once (count
  `buildTlState` runs through a spy, or the session's rebuild counter).
- Three prepends 100 ms apart compute once, from the newest list.
- A rebuild on a 600-bar list is deferred and marks busy; on a 400-bar list
  it is synchronous.
- An append-only calc on a 10k-bar list stays synchronous (no busy mark).
- A tick that lands during the settle window chains behind the rebuild and
  sees its result.

Live check (the same in-page probe used for the numbers above): one left
scroll on a deep 1H chart should show one Trendlines rebuild per history
load burst, and no synchronous Trendlines calc over 20 ms.

## Follow-up

If the single remaining rebuild (up to about 300 ms) is still felt, move the
rebuild into a web worker. That removes the last pause but needs the
session state to live in the worker, plus copies of the candles in and the
rows out; it gets its own spec.

The same deep scroll also logged 21 to 33 history fetches per burst in the
app's `__perf` monitor. That may be the scripted scroll, but it is worth a
separate look.
