"""Pure backtest performance metrics, derived from the round-trip trades and the
equity curve the engine already produced. No engine re-run; no indicator math.

Winner = pnl > 0, loser = pnl < 0 (breakeven counts as neither). The engine's
commission-aware `win_rate` (pnl > round-trip cost) is reproduced by
`leg_metrics` so per-direction rows match the aggregate; `compute_metrics`
leaves win rate to the engine."""

from __future__ import annotations

from collections.abc import Sequence


def _mean(xs: Sequence[float]) -> float:
    return sum(xs) / len(xs) if xs else 0.0


def _max_consec(pnls: Sequence[float], *, positive: bool) -> int:
    """Longest run of consecutive winners (positive=True) or losers, in order."""
    cur = best = 0
    for p in pnls:
        hit = p > 0 if positive else p < 0
        cur = cur + 1 if hit else 0
        best = max(best, cur)
    return best


def leg_metrics(trades, res_seconds, round_trip_cost) -> dict:
    """Trade-list-derived metrics over an arbitrary subset of trades (e.g. one
    leg). Definitions match `compute_metrics`, which shares this code path, so
    ALL / LONG / SHORT rows never drift. `win_rate` uses the engine's
    commission-aware threshold (pnl > round_trip_cost). Streaks are computed
    within the given list, so a per-leg loss streak ignores interleaved trades
    of the other direction."""
    pnls = [t.pnl for t in trades]
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p < 0]

    gross_loss = -sum(losses)  # positive magnitude, 0.0 when no losers
    profit_factor = (sum(wins) / gross_loss) if gross_loss > 0 else None

    avg_win = _mean(wins)
    avg_loss = _mean(losses)  # <= 0
    avg_win_loss_ratio = (avg_win / -avg_loss) if avg_loss < 0 else None

    n = len(trades)
    n_wins = sum(1 for p in pnls if p > round_trip_cost)

    durations = [
        (t.exit_time - t.entry_time).total_seconds() / res_seconds for t in trades
    ] if res_seconds else []

    return {
        "n_trades": n,
        "win_rate": n_wins / n if n else 0.0,
        "net_pnl": sum(pnls),
        "profit_factor": profit_factor,
        "avg_win": avg_win,
        "avg_loss": avg_loss,
        "avg_win_loss_ratio": avg_win_loss_ratio,
        "largest_win": max(wins) if wins else 0.0,
        "largest_loss": min(losses) if losses else 0.0,
        "max_consec_losses": _max_consec(pnls, positive=False),
        "avg_duration_bars": _mean(durations),
    }


def compute_metrics(trades, equity, net_pnl, starting_cash, res_seconds) -> dict:
    # Trade-list metrics come from the shared helper so they match the per-leg
    # breakdown exactly; win_rate is the engine's and not recomputed here.
    leg = leg_metrics(trades, res_seconds, round_trip_cost=0.0)
    pnls = [t.pnl for t in trades]

    # Max drawdown as a percent of the running peak (peak seeded at starting cash).
    peak = starting_cash
    max_dd_pct = 0.0
    for pt in equity:
        peak = max(peak, pt.equity)
        if peak > 0:
            max_dd_pct = max(max_dd_pct, (peak - pt.equity) / peak * 100.0)

    return {
        "return_pct": (net_pnl / starting_cash * 100.0) if starting_cash else 0.0,
        "profit_factor": leg["profit_factor"],
        "expectancy": _mean(pnls),
        "avg_win": leg["avg_win"],
        "avg_loss": leg["avg_loss"],
        "avg_win_loss_ratio": leg["avg_win_loss_ratio"],
        "largest_win": leg["largest_win"],
        "largest_loss": leg["largest_loss"],
        "max_drawdown_pct": max_dd_pct,
        "avg_duration_bars": leg["avg_duration_bars"],
        "max_consec_wins": _max_consec(pnls, positive=True),
        "max_consec_losses": leg["max_consec_losses"],
    }
