"""Pure backtest performance metrics, derived from the round-trip trades and the
equity curve the engine already produced. No engine re-run; no indicator math.

Winner = pnl > 0, loser = pnl < 0 (breakeven counts as neither). The engine's
commission-aware `win_rate` (pnl > round-trip cost) is reproduced by
`leg_metrics` so per-direction rows match the aggregate; `compute_metrics`
leaves win rate to the engine."""

from __future__ import annotations

from bisect import bisect_right
from collections.abc import Sequence


def _mean(xs: Sequence[float]) -> float:
    return sum(xs) / len(xs) if xs else 0.0


def _pstdev(xs: Sequence[float]) -> float:
    m = _mean(xs)
    return (sum((x - m) ** 2 for x in xs) / len(xs)) ** 0.5 if xs else 0.0


def risk_metrics(trades, equity, starting_cash, res_seconds, max_dd_pct: float | None = None) -> dict:
    """Volatility-adjusted stats from the equity curve (daily-resampled) and the
    trade list. Every ill-conditioned case (too few points, zero variance,
    non-positive equity) yields None for that stat rather than raising."""
    out = {"sharpe": None, "sortino": None, "calmar": None,
           "cagr_pct": None, "sqn": None, "exposure_pct": None}
    if equity:
        out["exposure_pct"] = round(
            sum((getattr(t, "bars_held", None) or 0) for t in trades) / len(equity) * 100, 2)

    # Daily resample: last equity point per UTC calendar day, seeded with cash.
    by_day: dict = {}
    for pt in equity:
        by_day[pt.time.date()] = pt.equity
    daily = [starting_cash] + [by_day[d] for d in sorted(by_day)]
    if all(e > 0 for e in daily[:-1]) and len(daily) >= 4:
        rets = [b / a - 1 for a, b in zip(daily, daily[1:])]
        sd = _pstdev(rets)
        if sd > 0:
            out["sharpe"] = round(_mean(rets) / sd * 252 ** 0.5, 4)
        downside = (sum(min(r, 0.0) ** 2 for r in rets) / len(rets)) ** 0.5
        if downside > 0:
            out["sortino"] = round(_mean(rets) / downside * 252 ** 0.5, 4)

    span = (equity[-1].time - equity[0].time).total_seconds() if len(equity) >= 2 else 0.0
    if span > 0 and starting_cash > 0 and equity[-1].equity > 0:
        out["cagr_pct"] = round(
            ((equity[-1].equity / starting_cash) ** (31_557_600 / span) - 1) * 100, 4)
    if out["cagr_pct"] is not None and max_dd_pct:
        out["calmar"] = round(out["cagr_pct"] / max_dd_pct, 4)

    pnls = [t.pnl for t in trades]
    sd_pnl = _pstdev(pnls)
    if len(pnls) >= 2 and sd_pnl > 0:
        out["sqn"] = round(len(pnls) ** 0.5 * _mean(pnls) / sd_pnl, 4)
    return out


def _max_consec(pnls: Sequence[float], *, positive: bool) -> int:
    """Longest run of consecutive winners (positive=True) or losers, in order."""
    cur = best = 0
    for p in pnls:
        hit = p > 0 if positive else p < 0
        cur = cur + 1 if hit else 0
        best = max(best, cur)
    return best


def _leg_metrics_core(pnls: list[float], durations: list[float], round_trip_cost: float) -> dict:
    """Trade-list metrics from raw pnls and per-trade durations (in bars). Shared
    by leg_metrics (engine Trade objects) and leg_metrics_from_dicts (stored
    dicts) so ALL / LONG / SHORT never drift."""
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p < 0]
    gross_loss = -sum(losses)
    profit_factor = (sum(wins) / gross_loss) if gross_loss > 0 else None
    avg_win = _mean(wins)
    avg_loss = _mean(losses)
    avg_win_loss_ratio = (avg_win / -avg_loss) if avg_loss < 0 else None
    n = len(pnls)
    n_wins = sum(1 for p in pnls if p > round_trip_cost)
    return {
        "n_trades": n,
        "win_rate": n_wins / n if n else 0.0,
        "net_pnl": sum(pnls),
        "expectancy": sum(pnls) / n if n else 0.0,
        "profit_factor": profit_factor,
        "avg_win": avg_win,
        "avg_loss": avg_loss,
        "avg_win_loss_ratio": avg_win_loss_ratio,
        "largest_win": max(wins) if wins else 0.0,
        "largest_loss": min(losses) if losses else 0.0,
        "max_consec_losses": _max_consec(pnls, positive=False),
        "max_consec_wins": _max_consec(pnls, positive=True),
        "avg_duration_bars": _mean(durations),
    }


def leg_metrics(trades, res_seconds, round_trip_cost) -> dict:
    """Trade-list-derived metrics over an arbitrary subset of trades (e.g. one
    leg). Definitions match `compute_metrics`, which shares this code path, so
    ALL / LONG / SHORT rows never drift. `win_rate` uses the engine's
    commission-aware threshold (pnl > round_trip_cost). Streaks are computed
    within the given list, so a per-leg loss streak ignores interleaved trades
    of the other direction."""
    pnls = [t.pnl for t in trades]
    durations = [
        (t.exit_time - t.entry_time).total_seconds() / res_seconds for t in trades
    ] if res_seconds else []
    return _leg_metrics_core(pnls, durations, round_trip_cost)


def leg_metrics_from_dicts(trades: list[dict], res_seconds, round_trip_cost) -> dict:
    """leg_metrics over stored TradeDTO dicts. entry_time/exit_time are epoch
    seconds (or None); duration is their difference over the bar length."""
    pnls = [t["pnl"] for t in trades]
    durations = [
        (t["exit_time"] - t["entry_time"]) / res_seconds
        for t in trades
        if res_seconds and t.get("entry_time") is not None and t.get("exit_time") is not None
    ]
    return _leg_metrics_core(pnls, durations, round_trip_cost)


def compute_metrics(trades, equity, net_pnl, starting_cash, res_seconds,
                    financing_total: float = 0.0) -> dict:
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

    risk = risk_metrics(trades, equity, starting_cash, res_seconds, max_dd_pct=max_dd_pct)

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
        "financing_total": financing_total,
    } | risk


def window_metrics(trades, bounds: Sequence[int]) -> tuple[list[dict], dict]:
    """Slice one continuous run's trades into the given sub-windows and score
    how evenly the P&L was earned. `bounds` is an ascending list of epoch
    seconds (N+1 boundaries for N windows). A trade belongs to the window its
    ENTRY falls in ([from, to), last window closed on the right); entries
    outside the bounds clamp into the nearest edge window. Aggregates are all
    higher-is-better; a zero-trade window has pnl 0 and counts as not
    profitable. std is the population std over window pnls (k = 1 penalty)."""
    n = len(bounds) - 1
    pnls = [0.0] * n
    counts = [0] * n
    for t in trades:
        ts = t.entry_time.timestamp()
        idx = min(max(bisect_right(bounds, ts) - 1, 0), n - 1)
        pnls[idx] += t.pnl
        counts[idx] += 1
    windows = [
        {"from": bounds[i], "to": bounds[i + 1], "pnl": round(pnls[i], 5), "trades": counts[i]}
        for i in range(n)
    ]
    mean = sum(pnls) / n
    std = (sum((p - mean) ** 2 for p in pnls) / n) ** 0.5
    ordered = sorted(pnls)
    mid = n // 2
    median = ordered[mid] if n % 2 else (ordered[mid - 1] + ordered[mid]) / 2
    agg = {
        "worst_window_pnl": round(min(pnls), 5),
        "median_window_pnl": round(median, 5),
        "pct_windows_profitable": round(sum(1 for p in pnls if p > 0) / n, 4),
        "mean_window_pnl_minus_std": round(mean - std, 5),
    }
    return windows, agg
