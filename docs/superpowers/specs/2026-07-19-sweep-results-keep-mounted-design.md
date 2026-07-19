# Sweep results: keep the table mounted across the Backtest↔Sweep switch

## Problem

After a large sweep, switching to the Sweep results table (during or after the
run) makes the app "almost freeze" for a moment. The user framed this as a data
size problem needing lazy loading.

## Diagnosis

The row count is not the bottleneck:

- Rows are already **virtualized** (`useVirtualRows` in `SweepResults.tsx`) — only
  ~80 `<tr>`s render regardless of set size.
- A `SweepRow` is lightweight (a combo dict + ~12 metric numbers + optional
  window slices); thousands of them are a few MB, not a memory problem.
- The heatmap already has display tiers + a collapsed opt-in for large grids.

The freeze is a **one-time remount cost**. `SweepResults` is rendered under
`{btMode === "sweep" && …}` in `BacktestSettingsModal.tsx`'s `resultsBody`, so
flipping Backtest→Sweep **unmounts and remounts it from scratch**. That single
commit synchronously:

1. re-runs the full derived cascade over every row — `withPlateau`, sort,
   best-per-column, `maxAbs`, and the heatmap index (memoized state is thrown
   away on unmount, so it all recomputes), and
2. mounts the Tooltip/InfoTip-heavy DOM subtree.

Lazy-loading / paging rows does not help: the data is already in the browser (no
fetch to defer), and the expensive passes are **global** — sort, best-per-column
highlight, heatmap aggregate, and plateau scoring each need the whole set, not
just the visible window. You cannot decide "what to display" without scanning
everything.

## Design

Stop gating `SweepResults` on `btMode`. Mount it whenever `sweepState` exists;
hide it with CSS when the active mode isn't sweep.

`BacktestSettingsModal.tsx`, `resultsBody`:

```tsx
const resultsBody = (
  <>
    {btMode === "backtest" && <BacktestPanel />}
    {sweepState ? (
      <div
        className="sweep-panel"
        style={{ display: btMode === "sweep" ? undefined : "none" }}
      >
        {sweepState.cancelled ? (…) : sweepState.error ? (…) : null}
        <SweepResults
          rows={sweepState.rows}
          axes={ranAxes.length ? ranAxes : sweepAxes}
          onApply={applySweepComboStable}
          onRefine={refineSweepAxes}
          progress={sweepProgress}
        />
      </div>
    ) : (
      btMode === "sweep" && (
        <div className="bt-results-empty">No sweep results yet…</div>
      )
    )}
  </>
);
```

The flip becomes a `display` toggle. No unmount → the memoized derived cascade and
the DOM survive, so switching back is instant instead of a blocking
recompute + remount.

## Correctness notes

- **Idle cost while hidden:** `SweepProgress`'s 1s interval only runs while a
  sweep is *running* (progress is null after completion), so a hidden, finished
  table has no timer. Virtualization listeners stay attached but idle (cheap).
- **Re-measure on show:** the virtualization `ResizeObserver` fires when the
  panel goes from `display:none` back to a real size, so the visible window
  re-measures. Even if it did not, the last measured window is still valid
  (layout unchanged).
- **Stable axes:** post-run `ranAxes` is populated and stable, so the
  kept-mounted instance won't thrash while hidden in backtest mode.

## Scope / non-goals

- Only the **Backtest↔Sweep mode switch** is kept-mounted.
- **Layout flip** (docked column ↔ stacked) and **results-collapse** still
  remount — pre-existing "remount-on-flip accepted", out of scope.
- `BacktestPanel` stays conditionally rendered (switching *to* backtest was never
  the complaint; its mount is cheap).
- No lazy-loading / pagination, no backend changes.
- The **first** mount when a large set first lands is not addressed here (would
  be the separate "defer the global passes off first paint" option). Deferred
  unless it proves annoying in practice.

## Test

In `BacktestSettingsModal.test.tsx`: with a populated `sweepStateSignal`, assert a
stable node inside `SweepResults` **stays mounted** (same element / not
re-created) across a `btMode` flip, rather than being unmounted.
