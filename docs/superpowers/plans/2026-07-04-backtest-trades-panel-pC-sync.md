# Backtest trades panel — Phase C (chart↔list sync) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two-way highlight between the trades list and the chart — hover a row to draw *just that* position's entry→exit line and emphasize its markers; hover a chart marker to highlight its row; click a row to scroll the chart to it. One trade highlighted at a time; nothing persists.

**Architecture:** A `highlightTradeSignal: Signal<number | null>` is the single shared piece of state (the trade's index in `result.trades[]`). The panel emits it on row hover and reacts to it (highlight + scroll the row into view). The chart side (`lib/backtest.ts`) stores the run's trades per-chart, draws a transient entry→exit overlay for the highlighted trade, emphasizes its fill markers, and each marker emits the signal on mouse-enter. Clicking a row scrolls the chart to that trade's time.

**Tech Stack:** TypeScript, React, klinecharts.

## Global Constraints

- **One at a time, nothing persists:** exactly one trade highlighted; `highlightTradeSignal.set(null)` clears it and removes the transient line. No permanent per-position lines ever remain on the chart.
- **No new backend, no engine change.** Frontend only.
- **Reuse existing chart machinery:** the transient line is a locked klinecharts overlay created/removed like the existing backtest markers in `lib/backtest.ts` (see `artifactsByChart`); marker hover uses the overlay `onMouseEnter`/`onMouseLeave` hooks (as `lib/positionLines.ts` does). Do NOT invent a new event system.
- **Clear on re-run / clear / symbol change:** a new run or `clearBacktest` must also reset `highlightTradeSignal` to null and drop the transient line.
- Gate: `cd frontend && npx tsc -b` — zero NEW errors in touched files (~20 pre-existing unrelated; ignore). No dev server.
- Concurrency: `App.tsx`/`App.css` are edited by another session — re-read before editing, explicit-pathspec commits.
- Commit trailers: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` / `Claude-Session: https://claude.ai/code/session_016y32p7zCcaDA1F6c5HkHz5`.

---

## File Structure

- Modify `frontend/src/lib/signals.ts` — add `highlightTradeSignal`.
- Modify `frontend/src/BacktestPanel.tsx` — emit on row hover; react (highlight row + scroll into view); emit-and-scroll-chart on row click.
- Modify `frontend/src/lib/backtest.ts` — store trades per chart; transient line + marker emphasis driven by the signal; marker `onMouseEnter` emits; reset on run/clear.
- Modify `frontend/src/App.css` — a `.bt-trade-row.highlighted` style and the transient-line color if needed.

---

### Task 1: `highlightTradeSignal` + panel two-way wiring

**Files:**
- Modify: `frontend/src/lib/signals.ts`, `frontend/src/BacktestPanel.tsx`, `frontend/src/App.css`

**Interfaces:**
- Produces: `export const highlightTradeSignal = new Signal<number | null>(null)`.
- Panel behaviour: each trades `<tr>` (which already has `data-trade-index={row.i}`) gets `onMouseEnter={() => highlightTradeSignal.set(row.i)}`, `onMouseLeave={() => highlightTradeSignal.set(null)}`, and `onClick` = set the id AND scroll the chart (see Task 2's exported scroll helper). The panel subscribes to `highlightTradeSignal` (via `useSyncExternalStore`, same pattern it already uses for `backtestResultSignal`); the row whose `i === highlighted` gets a `highlighted` class, and when the highlight changed from *outside* (a chart hover) the row is scrolled into view (`ref.scrollIntoView({ block: "nearest" })`).

- [ ] **Step 1: Add the signal**

In `signals.ts` add (near the other backtest signal): `export const highlightTradeSignal = new Signal<number | null>(null);`

- [ ] **Step 2: Panel emit + react**

In `BacktestPanel.tsx`: import `highlightTradeSignal`. Read it with `useSyncExternalStore` into `highlighted`. On each trades `<tr>`: add `onMouseEnter`/`onMouseLeave` (set index / null), `onClick` (set index; the chart-scroll is wired in Task 2 — call the helper it exports, or leave a `// Task 2` seam and wire it there), and `className` includes `highlighted` when `row.i === highlighted`. Give the highlighted row a `ref` and, in an effect keyed on `highlighted`, if a row is highlighted, `scrollIntoView({ block: "nearest" })` it (guard so hovering within the list doesn't fight the scroll — only scroll when the highlight didn't originate from this list's own hover; simplest correct version: always `block:"nearest"`, which is a no-op when already visible).

- [ ] **Step 3: Style + gate + commit**

In `App.css` add `.bt-trade-row.highlighted { background: var(--hover-strong, var(--hover)); }` (match the trades-row class name actually used in BacktestPanel — read it).
Run `cd frontend && npx tsc -b` → no new errors.
```bash
git add frontend/src/lib/signals.ts frontend/src/BacktestPanel.tsx frontend/src/App.css
git commit -m "feat(backtest): highlight signal + panel row hover/click sync"  # + trailers
```

---

### Task 2: chart side — transient line, marker emphasis, hover-emit, click-scroll

**Files:**
- Modify: `frontend/src/lib/backtest.ts`

**Interfaces:**
- Consumes: `highlightTradeSignal` (Task 1); `result.trades` (each has `entry_time`, `entry_price`, `exit_time`, `exit_price`, `leg`).
- Produces: driven entirely by the signal — no new exported React API required, except optionally `export function scrollChartToTrade(chart, trade)` used by the panel's row `onClick` (or emit a second signal the chart subscribes to; pick the simpler given the code).

- [ ] **Step 1: Store trades + subscribe, in `runAndRender`**

In `lib/backtest.ts`:
- Extend the per-chart `BacktestArtifacts` (the `artifactsByChart` WeakMap) with `trades: Trade[]` and `highlightOverlayId: string | null` and an `unsub: (() => void) | null`.
- In `runAndRender`, after drawing markers, store `artifacts.trades = result.trades`. Subscribe to `highlightTradeSignal` (store the unsubscribe on the artifacts): on `index === null` remove the transient overlay; on a number, remove any prior transient overlay and draw a new **locked** overlay line from `(trades[i].entry_time*1000, trades[i].entry_price)` to `(trades[i].exit_time*1000, trades[i].exit_price)`, colored by win/loss (`pnl >= 0` green else red), storing its id in `highlightOverlayId`.
- In `clearBacktest` and at the top of `runAndRender` (before drawing): remove the transient overlay, call the stored `unsub` if any, and `highlightTradeSignal.set(null)` so a stale index from a prior run can't point into the new trades.

- [ ] **Step 2: Marker hover emits the signal (chart → row)**

When creating each fill marker overlay in `runAndRender`, determine which trade index that fill belongs to and attach it: a marker at `m.time` with leg `m.leg` matches the trade whose `entry_time === m.time` (opening fill) or `exit_time === m.time` (closing fill) on the same leg — build a `time+leg → tradeIndex` lookup from `result.trades` once, then for each marker set `onMouseEnter: () => highlightTradeSignal.set(idx)` and `onMouseLeave: () => highlightTradeSignal.set(null)` in the overlay's config (only when a matching index exists). (klinecharts overlays accept these handlers — see `lib/positionLines.ts`.)

- [ ] **Step 3: Click-to-scroll**

Provide the row-click scroll: `export function scrollChartToTrade(chart: Chart, entryTs: number, exitTs: number): void` that centers the chart on the trade's time span (use the chart's scroll/visible-range API — grep the codebase for how it already scrolls to a timestamp, e.g. the alert→chart navigation; reuse that call). Wire the panel's row `onClick` (Task 1 seam) to call it with the highlighted trade's times. If a clean chart handle isn't reachable from the panel, instead add a `focusTradeSignal: Signal<number|null>` that `runAndRender` subscribes to and does the scroll chart-side; pick whichever is simpler in the actual code and note which you chose.

- [ ] **Step 4: Gate + commit**

Run `cd frontend && npx tsc -b` → no new errors. Reason through: hovering a row draws one line + emphasizes; un-hover removes it; hovering a marker highlights the row; re-run/clear drops the line and resets the signal.
```bash
git add frontend/src/lib/backtest.ts   # + BacktestPanel.tsx / signals.ts only if Step 3 added focusTradeSignal
git commit -m "feat(backtest): chart transient line + marker↔row two-way sync"  # + trailers
```

---

## Self-Review

**Spec coverage:** implements Phase C — the `highlightTrade` shared signal, row→chart (transient single-position line + marker emphasis), chart→row (marker hover highlights + scrolls the row), and click-to-scroll; one-at-a-time with nothing persisted; reset on run/clear. Completes the trades-panel feature (Phases A+B+C).

**Placeholder scan:** the chart-integration steps reference existing in-repo mechanisms (overlay create/remove in `backtest.ts`, overlay mouse hooks in `positionLines.ts`, the existing scroll-to-timestamp call) rather than transcribing them, because the implementer must match those exact APIs; every behaviour and data source is named explicitly.

**Type consistency:** `highlightTradeSignal` is `Signal<number | null>` in Task 1 and consumed as such in Task 2. The trade index is `TradeRow.i` (Phase B) === the `result.trades[]` index used chart-side. `scrollChartToTrade`/`focusTradeSignal` — exactly one is chosen and both ends match.
