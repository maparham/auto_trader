# Backtest trade markers on higher timeframes — design

**Date:** 2026-07-05
**Status:** Approved (design), pending implementation plan

## Problem

Backtest trade markers currently render only when the chart's timeframe is the
same as or **finer** than the timeframe the backtest ran on. On timeframes
**higher** than the backtest TF, no markers appear at all — so you cannot study
where trades happened while zoomed out. That makes reviewing results on higher
timeframes difficult.

The reason higher-TF markers are blocked today is a real anchoring problem, not
an arbitrary limitation: a marker is anchored to an **exact fill timestamp**.
On a higher TF that timestamp falls *inside* a bar, and many fills collapse onto
the same bar at the same x-coordinate, overlapping exactly. E.g. a full day of
5m fills would stack on one daily candle.

## Goal

Show backtest trade markers on higher timeframes by representing the N trades
that fall inside one higher-TF bar as a single **aggregate glyph** per bar, with
hover detail and click-to-drill-in.

## Current mechanism (baseline)

All logic lives in `frontend/src/lib/backtest.ts`.

- **Render gate** — `backtestRenderFlags(current, native)` (`backtest.ts:609-619`):
  ```ts
  const cur = RESOLUTION_SECONDS[current] ?? 0;
  const nat = RESOLUTION_SECONDS[native] ?? 0;
  return {
    drawMarkers: cur > 0 && nat > 0 && cur <= nat && nat % cur === 0,
    drawEquity: current === native,
  };
  ```
  Markers draw iff current TF is equal-or-finer AND evenly divides native.
  Equity draws iff current === native.
- **Consumer** — `renderArtifacts(chart, result, { drawMarkers, drawEquity })`
  (`backtest.ts:455-599`) early-returns before drawing markers when
  `!drawMarkers`; only creates the equity pane when `drawEquity`.
- **Marker anchoring** (`backtest.ts:504-546`): each `Marker` becomes a
  klinecharts overlay at `points: [{ timestamp: m.time * 1000, value: m.price }]`.
  klinecharts snaps that timestamp onto the containing candle — which is why the
  divisibility check matters today.
- **Rehydrate** — `rehydrateBacktest` (`backtest.ts:652`) recomputes flags via
  `backtestRenderFlags(resolution, saved.resolution)` on every TF switch/reload;
  invoked from `ChartCore.tsx:3021` in the effect keyed on `period.resolution`.
- **Data shapes** (`api.ts`):
  - `Marker { time; side: "buy"|"sell"; price; reason; leg: "long"|"short" }`
  - `Trade { side; quantity; entry_time; entry_price; exit_time; exit_price;
    pnl; leg; reason; stop_initial; stop_final; target }`
  - All times are unix **seconds**, `*1000` at draw time.
- **TF ordering** — `RESOLUTION_SECONDS` (`feed.ts:627-651`) maps each resolution
  key to duration in seconds. "Finer" = smaller seconds; "higher/coarser" = larger.

## Approach

Purely frontend, at render time. No backend change — the frontend already holds
every `Trade`/`Marker`, and "which TF am I viewing" is a client concern.
(Considered and rejected: precomputing per-TF aggregations, and returning
aggregated buckets from the backend — both add machinery for data the client
already has and a concern that is inherently client-side.)

### 1. Render flags gain a third mode

Replace the boolean `drawMarkers` with a tri-state so the higher-TF branch is
explicit:

```ts
backtestRenderFlags(current, native): { markerMode: "native" | "aggregate" | "none"; drawEquity: boolean }
```

- `cur > 0 && nat > 0 && cur <= nat && nat % cur === 0` → `"native"`
  (today's per-fill arrows, unchanged behavior)
- `cur > nat` (strictly higher TF) → `"aggregate"`
- otherwise (non-dividing finer pairs, e.g. 45s native / 10s current, or unknown
  keys) → `"none"` (unchanged — still cannot anchor cleanly)
- `drawEquity` unchanged: `current === native`.

Update both call sites (`renderArtifacts` dispatch and `rehydrateBacktest`) and
the existing unit tests for the new return shape.

### 2. Bucketing (correctness-sensitive)

Do **not** bucket by `floor(time / seconds)` arithmetic — daily/weekly/derived
bars do not align to epoch multiples (per the derived-timeframes constraint).
Instead, for each fill, find the chart candle whose `[time, nextBarTime)` window
contains it, and anchor the aggregate glyph to **that candle's timestamp**. This
mirrors exactly how klinecharts already snaps an overlay, so the glyph's
x-position always lands centered on the correct bar. Bucket the `Marker`s (entry
and exit fills are separate markers) into these bars; entry and exit of one trade
may land in the same bar.

### 3. The aggregate pill (DOM, not a klinecharts overlay)

Implementation note — this diverged from the original "new overlay type" plan.
A klinecharts overlay was built first, but its event hit test on a tiny locked
figure proved unreliable: `onClick` never fired and `onMouseLeave` didn't fire
when the overlay was torn down (stranding the popover). So the pills are **DOM
elements** (`BacktestAggMarkers.tsx`), the same DOM-over-canvas pattern the legend
and curve-end labels use — native `onmouseenter`/`onmouseleave`/`onclick` are
100% reliable. `renderArtifacts` stashes the clusters on the chart's artifacts
(`getBacktestAggregate`); `ChartCore`'s redraw loop projects each cluster's
bar-high anchor to a pixel via `convertToPixel` every frame and feeds the DOM
layer (culling off-screen pills, clamping `y` so a high-anchored pill stays just
inside the pane top).

- Each pill shows **trade count + net P&L**, colored by net: green net-win / red
  net-loss / grey break-even. Anchored just above the containing bar's high.
- **Single-trade bars show just the P&L** (a "1" count badge is noise); a
  multi-trade bar prefixes the count (`N · net`).

### 4. Interaction (both shipped)

- **Hover** a pill → the shared DOM popover (`BacktestClusterPopover`, rendered
  once at App level, driven by `backtestClusterHoverSignal`) lists each trade in
  that bar: side, entry time, entry→exit price, P&L, reason. Clears on leave.
- **Click** a pill → drill in: set the cell's resolution to the backtest's
  **native** TF and zoom to that bar's trade span, where the per-fill arrows
  render. Reuses `ChartCore`'s pending-range + page-back machinery (the same path
  the quick-range buttons use).
  - **Data-availability caveat:** drilling into a trade older than the broker
    serves at the fine timeframe lands at the edge of available history rather
    than exactly on the trade (the backtest ran off the candle cache, which goes
    back further than the live fine-TF feed). Trades within the broker's fine-TF
    history — the common case — land exactly.

## Out of scope

- **Equity curve** stays native-only. A bar-indexed equity series is misleading
  once bars aggregate; only markers gain higher-TF support.
- **Dock-row sync for the aggregate glyph** (hover-glyph ↔ highlight dock rows).
  The drill-in native view already has per-trade row sync; the aggregate glyph
  does not get it in v1.

## Testing

- Unit-test `backtestRenderFlags` for all three modes across representative TF
  pairs (equal, dividing-finer, non-dividing-finer, strictly-higher, unknown key).
- Unit-test the bucketing helper: fills mapped to the correct containing bar given
  a chart bar list, including bars that hold 0 / 1 / many fills, and both
  entry+exit of one trade landing in the same bar.
- Manual/e2e: run a backtest on a lower TF, switch to a higher TF, confirm
  aggregate glyphs appear on the right bars with correct counts and net P&L;
  hover shows the fill list; (Stage B) click drills into the native TF window.

## Open decisions recorded

- Single-fill bars → keep the clean arrow (not a pill). **Decided.**
- Staging → hover-popover (Stage A) first, drill-in (Stage B) second, within one
  plan. **Decided.**
