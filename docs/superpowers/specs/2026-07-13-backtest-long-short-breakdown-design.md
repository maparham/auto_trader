# Backtest TRADES panel — Long/Short breakdown

**Date:** 2026-07-13
**Status:** Design approved, pending spec review

## Goal

In the backtest results Overview, the **TRADES** section shows one row of
aggregate stats over *all* closed trades. Add a per-direction breakdown so the
user can see how longs and shorts each contributed. Replace the single flat
stat grid with a compact **3-row table**: `ALL`, `LONG`, `SHORT`.

## Layout

Under the `TRADES` header, render a table:

- **Header row:** metric names, each with its existing ⓘ `InfoTip`. Icons
  appear **once**, on the column headers (not repeated per row).
- **Data rows:** `ALL`, `LONG`, `SHORT` — a left-hand row label followed by one
  cell per metric, computed over that direction's trades.

Columns (full set):

```
Trades · Win rate · Net P&L · Profit factor · Avg win · Avg loss ·
Avg win/loss · Largest win · Largest loss · Loss streak · Avg duration
```

All eleven metrics are derived purely from the trade list, so each splits
cleanly by leg. Equity-curve metrics (Return %, Expectancy, Drawdown, Drawdown %,
Win streak) are **not** part of this table — they stay in the Performance and
Risk & extremes sections unchanged.

The `ALL` row intentionally repeats Net P&L / Profit factor / Largest win /
Largest loss / Loss streak, which also appear in the Performance and Risk
sections above. This duplication is accepted so the comparison table is complete
and every column lines up across ALL/LONG/SHORT. The Performance and Risk
sections are left as-is.

### Column value formatting

Reuse the existing formatting from `backtestPanelData.ts` so the new cells match
the current cards exactly:

Only Net P&L carries sign tone. The per-trade magnitudes are sign-fixed (a win
is always ≥0, a loss ≤0), so colouring them is decoration — this matches the
house convention already in `metricRows` (tone reserved for sign-verdict
metrics), and keeps the ALL row consistent with the flat stat grid above.

| Column        | Format                                             | Tone (pos/neg) |
|---------------|----------------------------------------------------|----------------|
| Trades        | integer count                                       | none           |
| Win rate      | `round(win_rate * 100) + "%"`                        | none           |
| Net P&L       | signed `±nn.nn`                                      | pos/neg by sign|
| Profit factor | `toFixed(2)` or `—` when null                        | none           |
| Avg win       | `toFixed(2)`                                         | none           |
| Avg loss      | `toFixed(2)` (negative)                              | none           |
| Avg win/loss  | `toFixed(2)` or `—` when null                        | none           |
| Largest win   | `toFixed(2)`                                         | none           |
| Largest loss  | `toFixed(2)` (negative)                              | none           |
| Loss streak   | integer count                                        | none           |
| Avg duration  | `toFixed(1) + " bars"`                               | none           |

## Backend

All computation stays on the backend (per the standing "backend owns business
logic" rule); the frontend only renders.

### 1. Extract a shared, leg-decomposable helper

`backend/auto_trader/engine/metrics.py` currently has `compute_metrics(...)`
which mixes trade-list metrics with equity-curve metrics (return_pct,
max_drawdown_pct) in one pass. Extract the **trade-list-only** subset into a
reusable helper:

```python
def leg_metrics(trades, res_seconds, round_trip_cost) -> dict:
    """Trade-list-derived metrics for an arbitrary subset of trades.
    Definitions match compute_metrics exactly (shared code path)."""
    ...
    return {
        "n_trades": len(trades),
        "win_rate": <wins> / len(trades) if trades else 0.0,
        "net_pnl": sum(t.pnl for t in trades),
        "profit_factor": ...,        # None when no losers
        "avg_win": ...,
        "avg_loss": ...,             # <= 0
        "avg_win_loss_ratio": ...,   # None when no losers
        "largest_win": ...,
        "largest_loss": ...,
        "max_consec_losses": ...,    # "Loss streak"
        "avg_duration_bars": ...,
    }
```

`compute_metrics` is refactored to call this helper for the trade-list portion
so the ALL numbers and the per-leg numbers come from identical code — no risk of
rounding or definition drift.

**Win-rate parity.** `win_rate` today is computed in `BacktestEngine.run()`
(not in `compute_metrics`) using a commission-aware threshold: a trade counts as
a win when `pnl > round_trip_cost`. The helper takes `round_trip_cost` and
applies the **same** threshold so per-leg win rate matches the engine's
all-trades definition.

### 2. Emit `by_leg` in the response

In `backend/auto_trader/api/routers/backtest.py` (the `/api/backtest`
endpoint), after computing trades, build:

```python
by_leg = {
    "long":  leg_metrics([t for t in result.trades if t.leg == "long"],  res_seconds, round_trip_cost),
    "short": leg_metrics([t for t in result.trades if t.leg == "short"], res_seconds, round_trip_cost),
}
```

Add an optional field to `BacktestResponse` in
`backend/auto_trader/api/schemas.py`:

```python
by_leg: dict | None = None
```

The ALL row does **not** need a new payload — the frontend reuses the existing
`summary` (n_trades, win_rate, net_pnl) and `metrics` (profit_factor, avg_win,
avg_loss, avg_win_loss_ratio, largest_win, largest_loss, max_consec_losses,
avg_duration_bars) values it already receives.

## Frontend

- `frontend/src/api.ts`: add a `LegMetrics` interface and
  `by_leg?: { long: LegMetrics; short: LegMetrics }` to `BacktestResult`.
- `frontend/src/lib/backtestPanelData.ts`: add a `legTable(res)` builder that
  returns the three rows (`ALL` from existing summary/metrics, `LONG`/`SHORT`
  from `by_leg`) as formatted cell strings + tone, reusing the existing
  per-metric formatters. Column definitions (label → InfoTip text) live here.
- `frontend/src/BacktestPanel.tsx`: render the table in the `TRADES` group in
  place of the current single stat grid.
- `frontend/src/App.css`: table styles consistent with existing
  `bt-panel-*` tokens (mono tabular-nums values, `--text-faint` uppercase
  headers, `.pos`/`.neg` tones, thin row separators).

## Semantics (explicit)

- **Loss streak per leg** = the longest run of *consecutive losing trades of that
  direction*, in chronological order, ignoring interleaved trades of the other
  direction. This is the natural result of filtering the trade list by leg
  before computing the streak. Stated in the spec and reflected in the tooltip.
- **One-sided strategies.** If a run has zero shorts (or zero longs), that row's
  ratio/rate cells that would divide by zero show `—`, matching the existing
  `avg_win_loss_ratio` null handling. Counts and sums show `0`.
- **Leg totals.** `long.n_trades + short.n_trades == summary.n_trades`; every
  trade has `leg ∈ {"long","short"}` (no flat/other leg exists in the model).

## Testing

- **Backend unit test** (`metrics.py`): a mixed set of long/short winners and
  losers → assert `leg_metrics` on the filtered lists matches hand-computed
  values, and that `long.net_pnl + short.net_pnl == metrics-level net_pnl`.
- **Edge case:** all-long run → short row all-zero / `—`, no exceptions.
- **Parity:** ALL-row win rate (from summary) equals
  `leg_metrics(all_trades, ...)["win_rate"]` — confirms the extracted helper
  didn't change the aggregate definition.
- **Frontend:** existing `backtestPanelData` tests extended to cover `legTable`
  formatting incl. the `—` null path.

## Out of scope

- Long/short split of equity-curve metrics (Return %, Expectancy, Drawdown) —
  not cleanly decomposable, deliberately excluded.
- Any change to the Performance / Risk & extremes sections.
- Live-trading panel (backtest only).
