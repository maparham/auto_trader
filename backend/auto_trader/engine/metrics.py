"""Pure backtest performance metrics, derived from the round-trip trades and the
equity curve the engine already produced. No engine re-run; no indicator math.

Winner = pnl > 0, loser = pnl < 0 (breakeven counts as neither). The engine's
commission-aware `win_rate` is separate and not recomputed here."""

from __future__ import annotations

from collections.abc import Sequence


def _mean(xs: Sequence[float]) -> float:
    return sum(xs) / len(xs) if xs else 0.0


def compute_metrics(trades, equity, net_pnl, starting_cash, res_seconds) -> dict:
    pnls = [t.pnl for t in trades]
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p < 0]

    gross_loss = -sum(losses)  # positive magnitude, 0.0 when no losers
    profit_factor = (sum(wins) / gross_loss) if gross_loss > 0 else None

    avg_win = _mean(wins)
    avg_loss = _mean(losses)  # <= 0
    avg_win_loss_ratio = (avg_win / -avg_loss) if avg_loss < 0 else None

    # Max consecutive winners / losers over the trade sequence.
    max_w = max_l = cur_w = cur_l = 0
    for p in pnls:
        if p > 0:
            cur_w += 1; cur_l = 0
        elif p < 0:
            cur_l += 1; cur_w = 0
        else:
            cur_w = cur_l = 0
        max_w = max(max_w, cur_w)
        max_l = max(max_l, cur_l)

    # Max drawdown as a percent of the running peak (peak seeded at starting cash).
    peak = starting_cash
    max_dd_pct = 0.0
    for pt in equity:
        peak = max(peak, pt.equity)
        if peak > 0:
            max_dd_pct = max(max_dd_pct, (peak - pt.equity) / peak * 100.0)

    durations = [
        (t.exit_time - t.entry_time).total_seconds() / res_seconds for t in trades
    ] if res_seconds else []

    return {
        "return_pct": (net_pnl / starting_cash * 100.0) if starting_cash else 0.0,
        "profit_factor": profit_factor,
        "expectancy": _mean(pnls),
        "avg_win": avg_win,
        "avg_loss": avg_loss,
        "avg_win_loss_ratio": avg_win_loss_ratio,
        "largest_win": max(wins) if wins else 0.0,
        "largest_loss": min(losses) if losses else 0.0,
        "max_drawdown_pct": max_dd_pct,
        "avg_duration_bars": _mean(durations),
        "max_consec_wins": max_w,
        "max_consec_losses": max_l,
    }
