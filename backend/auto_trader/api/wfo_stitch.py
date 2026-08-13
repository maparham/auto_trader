"""Stitch per-fold out-of-sample test runs into one OOS record, compute
walk-forward efficiency, and assemble the aggregate robustness block."""
from __future__ import annotations

import datetime as dt
from statistics import median
from types import SimpleNamespace

from auto_trader.engine.metrics import compute_metrics
from auto_trader.engine.stability import robustness_score

_YEAR = 31_557_600


def annualized_rate(return_pct: float | None, span_seconds: int) -> float | None:
    if return_pct is None or span_seconds <= 0:
        return None
    return return_pct * (_YEAR / span_seconds)


def fold_wfe(is_metrics: dict, oos_metrics: dict,
             train_seconds: int, test_seconds: int) -> float | None:
    is_rate = annualized_rate(is_metrics.get("return_pct"), train_seconds)
    oos_rate = annualized_rate(oos_metrics.get("return_pct"), test_seconds)
    if is_rate is None or oos_rate is None or is_rate <= 0:
        return None
    return round(oos_rate / is_rate, 4)


def fold_excess(oos_metrics: dict | None, null_metrics: dict | None) -> float | None:
    """Strategy return minus the null baseline's return over the same test
    window. None when either side is missing: no comparison, not zero."""
    if not oos_metrics or not null_metrics:
        return None
    a, b = oos_metrics.get("return_pct"), null_metrics.get("return_pct")
    if a is None or b is None:
        return None
    return round(a - b, 4)


def stitch(fold_tests: list[dict], starting_cash: float, res_seconds: int) -> dict:
    equity: list[list[float]] = []
    scaled: list[list[float]] = []
    trades: list[dict] = []
    cum_pnl = 0.0
    factor = 1.0
    for k, ft in enumerate(fold_tests):
        seg = ft["equity"]
        for ts, eq in seg:
            equity.append([ts, eq + cum_pnl])
            scaled.append([ts, eq * factor])
        for t in ft["trades"]:
            trades.append({**t, "fold": k})
        seg_end = seg[-1][1] if seg else starting_cash
        cum_pnl += seg_end - starting_cash
        factor *= seg_end / starting_cash if starting_cash > 0 else 1.0
    # compute_metrics over the summed curve via minimal stand-ins.
    utc = dt.timezone.utc
    eq_pts = [SimpleNamespace(time=dt.datetime.fromtimestamp(ts, tz=utc), equity=eq)
              for ts, eq in equity]
    tr_objs = [SimpleNamespace(
        pnl=t["pnl"], bars_held=None,
        entry_time=dt.datetime.fromtimestamp(t["entry_time"], tz=utc),
        exit_time=dt.datetime.fromtimestamp(t["exit_time"], tz=utc),
    ) for t in trades]
    metrics = compute_metrics(tr_objs, eq_pts, cum_pnl, starting_cash, res_seconds)
    return {"equity": equity, "equity_scaled": scaled,
            "trades": trades, "metrics": metrics}


def aggregate(folds: list[dict], stitched_metrics: dict, stability: dict,
              breadth: float | None, oos_trades_total: int) -> dict:
    wfes = [f["wfe"] for f in folds if f.get("wfe") is not None]
    rets = [f["oos_metrics"].get("return_pct") for f in folds
            if f.get("oos_metrics")]
    rets = [r for r in rets if r is not None]
    nets = [f["oos_metrics"].get("net_pnl") or 0.0 for f in folds
            if f.get("oos_metrics")]
    excesses = [f.get("excess_return_pct") for f in folds]
    excesses = [e for e in excesses if e is not None]
    n = len(folds)
    block = {
        "wfe_median": round(median(wfes), 4) if wfes else None,
        "wfe_aggregate": None,  # filled by the orchestrator (needs IS totals)
        "pct_folds_profitable": round(
            sum(1 for x in nets if x > 0) / n, 4) if n else None,
        "median_fold_return_pct": round(median(rets), 4) if rets else None,
        "worst_fold_return_pct": round(min(rets), 4) if rets else None,
        "median_fold_excess_pct": round(median(excesses), 4) if excesses else None,
        "pct_folds_beating_null": round(
            sum(1 for e in excesses if e > 0) / len(excesses), 4) if excesses else None,
        "oos_sharpe": stitched_metrics.get("sharpe"),
        "oos_max_drawdown_pct": stitched_metrics.get("max_drawdown_pct"),
        "oos_profit_factor": stitched_metrics.get("profit_factor"),
        "param_stability": stability.get("overall"),
        "plateau_breadth": breadth,
        "n_folds": n,
        "oos_trades_total": oos_trades_total,
        "low_sample_folds": sum(1 for f in folds if f.get("low_sample")),
    }
    block["robustness_score"] = robustness_score(
        wfe_median=block["wfe_median"],
        pct_folds_profitable=block["pct_folds_profitable"],
        oos_sharpe=block["oos_sharpe"],
        param_stability=block["param_stability"],
        oos_max_dd_pct=block["oos_max_drawdown_pct"],
        plateau_breadth=breadth,
        oos_trades_total=oos_trades_total,
        n_folds=n,
    )
    return block
