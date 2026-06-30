# Visible Range Selector (TradingView-style quick date-range bar)

**Date:** 2026-06-30
**Status:** Design approved, pending spec review

## Summary

Add a TradingView-style quick date-range bar to each chart cell: a row of range
buttons (`1D 5D 1M 3M 6M YTD 1Y All`) plus a calendar "go to date" icon. Each
range button switches the cell's interval to a paired resolution **and** fits the
visible window to that period (anchored to the latest bar). The calendar icon
opens a date picker that scrolls the chart to the chosen date without changing
the interval.

This mirrors TradingView's bottom-of-chart range bar.

## Behavior

### Range buttons → interval + window

Each button pairs a window with an interval. Clicking it:

1. Switches the **focused cell's** interval to the paired resolution (if not
   already on it), and
2. Fits the visible window to the period, anchored to the latest bar / now.

| Button | Window                | Interval | `feed.ts` resolution |
|--------|-----------------------|----------|----------------------|
| 1D     | last 1 day            | 1m       | `MINUTE`             |
| 5D     | last 5 days           | 5m       | `MINUTE_5`           |
| 1M     | last 1 month          | 30m      | `MINUTE_30`          |
| 3M     | last 3 months         | 1h       | `HOUR`               |
| 6M     | last 6 months         | 4h       | `HOUR_4`             |
| YTD    | Jan 1 this year → now | 1d       | `DAY`                |
| 1Y     | last 1 year           | 1d       | `DAY`                |
| All    | full history (capped) | 1d       | `DAY`                |

All six resolutions exist in `frontend/src/lib/feed.ts` `PERIODS` and none are
`liveOnly`, so no fallback mapping is needed.

- If the cell is **already** on the target interval, skip the reload and fit the
  window immediately.
- The active button is **highlighted**. The highlight clears when the user
  manually zooms/scrolls or changes the interval themselves (TV behavior).

### Calendar "go to date" icon

- Opens a small date-picker popover.
- Choosing a date scrolls the chart so that date is in view, keeping the current
  interval (no preset applied).
- If the chosen date predates loaded history, trigger the existing scroll-back
  load first, then scroll to it.

## Placement & visibility

- A thin bottom strip rendered inside `.chart-wrap` in `ChartCore.tsx`, **below**
  klinecharts' time axis. `.chart-wrap` becomes a flex column so `containerRef`
  shrinks by the bar's height — the bar never overlaps candles.
- **Hover-revealed:** hidden by default, fades in when the cursor is near the
  bottom of the cell.
- Disabled when the cell has no chart yet.

## Architecture & data flow

### New component

`frontend/src/ChartRangeBar.tsx` — presentational only. Props:

- `activeKey: RangeKey | null`
- `onPick(key: RangeKey): void`
- `onGoToDate(date: Date): void`
- `disabled?: boolean`

Rendered inside `ChartCore`'s return as a sibling after the `containerRef` div
(around `ChartCore.tsx:3422`).

### Interval switch — reuse existing path

The range button does **not** invent a new reload. It requests the same
focused-cell `period` change the top Toolbar interval picker already performs
(period lives in cell state, lifted to `ChartGrid`/`App`). Consequences that fall
out for free:

- Data reload at the new resolution uses the existing `fetchRecent` path.
- The Toolbar interval picker reflects the new interval ("keeps in sync").
- Persistence via existing layout storage is unchanged.

### Window fit — reuse `chartSync.ts`

Window fitting calls `applyVisibleRange(chart, fromTs, toTs)` from
`frontend/src/lib/chartSync.ts` (the existing "no klinecharts setVisibleRange"
helper). Because `applyVisibleRange` triggers the existing `onRange` broadcast, a
window change propagates to sibling cells when "Sync date range" is on. The
interval switch stays **local** to the focused cell.

### Pending-fit handshake

Switching interval reloads data asynchronously, so the window fit must wait for
the new-resolution data to land:

- A `pendingRangeRef` on the cell records the requested `RangeKey`.
- When new data lands (the existing post-`applyNewData` point near
  `ChartCore.tsx:2236`), apply the window fit, then clear the ref.
- If the interval is unchanged, fit immediately (no ref needed).
- Rapid clicks: a newer pick overwrites the ref, so only the latest wins.

### Pure helper (unit-tested)

`rangeWindow(key, lastBarTs, now) → { fromTs, intervalKey }` — all window math:
1D/5D/1M/3M/6M/YTD/1Y/All, including the All cap and the YTD year boundary. This
is the isolated, testable core.

## History depth & cap

- A fit needs `fromTs` covered by loaded bars. If not covered, page back using
  the existing scroll-back path (`setLoadDataCallback`, `fetchRange`,
  `PAGE_BARS=500`) with the existing `loadingRef`/`exhaustedRef` guards, until
  covered or exhausted, then fit.
- **Cap:** `All` is bounded to **~5 years of daily bars (≈1300 bars)** so a deep
  instrument can't trigger a long chain of broker calls. `1Y`/`YTD` are naturally
  bounded.
- If history is shorter than the requested window, fit what exists (no crash).
- Show a brief loading state on the active button while paging back.

## Edge cases

- Few bars available (new/just-opened market): fit what exists.
- Cell not focused / no chart yet: bar disabled.
- Rapid clicks: latest pick supersedes pending-fit.

## Testing

- **Unit:** `rangeWindow` helper — all eight keys, All cap, YTD year boundary.
- **E2E (Playwright, matching existing chart e2e):**
  - Click each button → interval picker updates + visible range roughly matches.
  - Hover near bottom reveals the bar.
  - Calendar jump scrolls to the chosen date.

## Out of scope (YAGNI)

- Wiring backend `candle_cache.py` into `/api/candles` — separate effort; this
  feature uses the broker path as today.
- Custom from–to range picker (chose TV "go to date" instead).
- Persisting the active-button highlight across reload — interval persists via
  existing layout storage; the highlight is transient.

## Key files

- `frontend/src/ChartCore.tsx` — cell component; mount bar in return (~3422),
  pending-fit at data-land (~2236).
- `frontend/src/ChartRangeBar.tsx` — **new** presentational bar.
- `frontend/src/lib/chartSync.ts` — `applyVisibleRange` (window fit).
- `frontend/src/lib/feed.ts` — `PERIODS` resolutions, `fetchRange` scroll-back.
- `frontend/src/ChartGrid.tsx` / `App` — focused-cell `period` change path.
