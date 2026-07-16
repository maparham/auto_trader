"""Risk-adjusted metrics: sharpe/sortino/calmar/cagr/sqn/exposure guards + values."""
import math
from datetime import datetime, timedelta, timezone
from statistics import mean, pstdev
from types import SimpleNamespace

from auto_trader.engine.metrics import compute_metrics, risk_metrics

UTC = timezone.utc
T0 = datetime(2026, 1, 1, tzinfo=UTC)


def eq(day: int, value: float):
    return SimpleNamespace(time=T0 + timedelta(days=day), equity=value)


def trade(pnl: float, bars: int = 4, day: int = 0):
    t = T0 + timedelta(days=day)
    return SimpleNamespace(pnl=pnl, bars_held=bars, entry_time=t,
                           exit_time=t + timedelta(hours=1))


def test_flat_equity_yields_none_ratios():
    equity = [eq(d, 1000.0) for d in range(5)]
    m = risk_metrics([], equity, 1000.0, 3600)
    assert m["sharpe"] is None and m["sortino"] is None
    assert m["sqn"] is None            # no trades
    assert m["cagr_pct"] == 0.0        # flat: (1)**x - 1 == 0
    assert m["exposure_pct"] == 0.0


def test_sharpe_matches_hand_formula():
    values = [1000.0, 1010.0, 1005.0, 1020.0, 1030.0]
    equity = [eq(d, v) for d, v in enumerate(values)]
    # seeded with starting_cash 1000 -> day-0 return is 0.0
    series = [1000.0] + values
    rets = [b / a - 1 for a, b in zip(series, series[1:])]
    expected = mean(rets) / pstdev(rets) * math.sqrt(252)
    m = risk_metrics([], equity, 1000.0, 3600)
    assert m["sharpe"] == round(expected, 4)
    assert m["sortino"] is not None and m["sortino"] > m["sharpe"]  # one small dip


def test_sqn_and_exposure():
    trades = [trade(10.0), trade(-5.0), trade(10.0), trade(5.0)]
    equity = [eq(d, 1000.0 + 5 * d) for d in range(10)]
    m = risk_metrics(trades, equity, 1000.0, 3600)
    pnls = [10.0, -5.0, 10.0, 5.0]
    assert m["sqn"] == round(math.sqrt(4) * mean(pnls) / pstdev(pnls), 4)
    assert m["exposure_pct"] == round(16 / 10 * 100, 2)


def test_compute_metrics_carries_risk_keys():
    values = [1000.0, 1010.0, 1005.0, 1020.0]
    equity = [eq(d, v) for d, v in enumerate(values)]
    trades = [trade(10.0), trade(-5.0), trade(15.0)]
    m = compute_metrics(trades, equity, 20.0, 1000.0, 3600)
    for key in ("sharpe", "sortino", "calmar", "cagr_pct", "sqn", "exposure_pct"):
        assert key in m
    assert m["cagr_pct"] is not None and m["cagr_pct"] > 0


def test_zero_span_and_negative_equity_guards():
    m = risk_metrics([], [eq(0, 900.0)], 1000.0, 3600)
    assert m["cagr_pct"] is None      # single point: span 0
    m2 = risk_metrics([], [eq(0, 1000.0), eq(1, -50.0)], 1000.0, 3600)
    assert m2["cagr_pct"] is None     # negative final equity
