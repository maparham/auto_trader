# Backtest trades panel (Overview + List) with chart sync — design

**Date:** 2026-07-04
**Status:** Approved, ready for implementation plan
**Builds on:** the backtest stops/targets + multi-position work (per-side risk, independent positions).

## Problem

After a backtest runs, the only feedback is a summary chip (net P&L, trades,
win %, max-drawdown) plus fill markers + an equity sub-pane on the chart. There's
no way to inspect individual trades, see richer performance metrics, or tell one
position from another. Drawing a line per position was rejected — it crowds the
chart once there are many trades. Instead: a **bottom Strategy-Tester-style
panel** with an Overview (metrics) tab and a List-of-Trades tab, with **two-way
chart↔list highlighting** so you inspect any single position on demand while the
chart stays clean.

Backtest only. No change to live/paper trading.

## Non-goals

- No permanent per-position lines on the chart (the rejected approach).
- No Sharpe / CAGR in v1 — they need resolution-aware annualization that is easy
  to get silently wrong; deferred to a later, deliberate pass.
- No CSV export, no equity-curve interactions, no trade editing (v1).

## Architecture

The existing `POST /api/backtest` response gains two things; the panel is pure
display fed by that response.

1. **Backend computes all metrics** (single source of truth, consistent with the
   summary chip, Python-tested) in a new pure `engine/metrics.py`, from
   `trades[]` + `equity[]` + `commission` + `starting_cash`. Returned as a
   `metrics` block on the response.
2. **Exit `reason` on the Trade DTO.** `trades[]` currently lacks `reason_out`
   (only markers carry it); the List's "why closed" column needs it. The engine
   already stores it on each `Trade`; expose it in `TradeDTO`.
3. **Frontend:** a new bottom `BacktestPanel` (collapsible, two tabs) fed the run
   result via a `signals.ts` signal that `BacktestButton.run()` publishes; plus
   chart↔list two-way highlight reusing the live trade-line↔row hit-test/signal
   pattern.

**Consistency rule:** metrics that already exist on the chip (`net_pnl`,
`win_rate`, `max_drawdown`) keep their existing backend definitions; the Overview
renders the same backend numbers so the chip and Overview can never disagree.

## Metric set (v1, backend, all unambiguous)

Computed in `engine/metrics.py` from the round-trip `trades[]` + `equity[]`:

- **net P&L** (existing) and **return %** = `net_pnl / starting_cash`.
- **# trades** (existing), **win rate** (existing: a win is `pnl > 2*commission`).
- **profit factor** = gross profit / gross loss (∞ / None when no losses).
- **expectancy** = mean trade pnl.
- **avg win**, **avg loss**, **avg win/loss ratio**.
- **largest win**, **largest loss**.
- **max drawdown** (existing) and **max drawdown %** = max drawdown / peak equity
  at the trough's running peak.
- **avg trade duration** in bars (exit_time − entry_time) / resolution seconds.
- **max consecutive wins**, **max consecutive losses**.

Each metric has a defined value for the **empty-trades** case (0 / null, never a
divide-by-zero). The new aggregates classify a winner as `pnl > 0` and a loser
as `pnl < 0` (the conventional profit-factor definition; breakeven counts as
neither) — ratified 2026-07-04. The existing `win_rate` keeps its own
commission-aware definition (`pnl > 2*commission`); it is rendered straight from
the backend `summary`, so the chip and Overview never disagree on win rate.
(With commission = 0 the two thresholds are identical.)

## The panel (frontend)

A new `BacktestPanel` docked **below the chart**, collapsible, shown once a
backtest has results. Two tabs:

- **Overview tab** — a labelled metric grid rendering the backend `metrics`
  block. Values colored by sign where meaningful (green/red).
- **Trades tab** — a **sortable** table, one row per round-trip: `#`, side
  (Long/Short), entry time, entry price, exit time, exit price, P&L, P&L %
  (`pnl / (entry_price*qty)`), exit reason (rule text / SL / TP / trail / end),
  duration (bars). Click a column header to sort.

**Flexbox-scroll discipline (learned this session):** the trades table is a
scroll container inside a flex panel — the exact `.bt-body` collapse trap already
fixed. The table body gets `flex: 1; overflow-y: auto; min-height: 0`, and every
flex ancestor down to it gets `min-height: 0`, so it scrolls instead of squashing
its neighbors (or being squashed).

**Data flow:** `BacktestButton.run()` already has the `BacktestResult`; it
publishes it on a new `signals.ts` signal (`backtestResult`). `BacktestPanel`
subscribes and renders. Clearing the backtest publishes `null` (panel hides).

## Chart ↔ list two-way sync

Reuses the live **trade-line ↔ row** hit-test + signal-driven mutual-exclusivity
pattern (`positionLines.ts` / `signals.ts`). Each backtest `Trade` has a stable
id (index in `trades[]`).

- **Row → chart:** hovering a trades-row emits `highlightTrade(id)`; the chart
  highlights that trade's entry+exit markers and draws **just that one**
  position's entry→exit segment transiently (removed on un-hover). Clicking a row
  additionally **scrolls the chart** to center that trade's time range.
- **Chart → row:** hovering a backtest marker (hit-test on the chart) emits the
  same `highlightTrade(id)`; the panel highlights and scrolls the matching row
  into view.
- Only **one** trade is highlighted at a time (mutual exclusivity via the shared
  signal); `highlightTrade(null)` clears. No permanent lines ever persist.

## Build order (phases; each its own plan → SDD run)

- **Phase A — backend metrics + trade reason.** `engine/metrics.py` (pure, unit-
  tested), `reason` on `TradeDTO`, `metrics` on the response DTO, wired in
  `app.py`. Frontend `api.ts` types updated. No UI yet. Regression: existing
  backtest tests unchanged.
- **Phase B — the panel shell.** `BacktestPanel` (tabs, Overview grid, sortable
  Trades table), fed by the new `backtestResult` signal; `BacktestButton`
  publishes it; docked in `App.tsx`/`App.css` with the flex-scroll discipline.
- **Phase C — chart↔list two-way sync.** `highlightTrade` signal, marker hit-test
  → row, row hover → transient single-position line + marker highlight + scroll.

## Testing

- **Backend (`test_metrics.py`):** hand-computed cases for profit factor,
  expectancy, avg win/loss, largest win/loss, drawdown %, avg duration, max
  consecutive wins/losses; the **empty-trades** case returns zeros/nulls with no
  divide-by-zero; new-metric win/loss classification uses `pnl > 0` / `pnl < 0`.
- **Backend api test:** the `/api/backtest` response includes `metrics` and each
  trade carries `reason`.
- **Frontend:** panel renders the metric grid + trades table from a result;
  column sort reorders rows; a `backtestResult` of null hides the panel; sync —
  hovering a row emits `highlightTrade(id)`, and the marker hit-test emits the
  matching id.

## Concurrency note

Phases B/C touch `App.tsx` and `App.css`, which a concurrent session edits.
Re-read those before editing; commit with explicit pathspec; never stage the
other session's files.
