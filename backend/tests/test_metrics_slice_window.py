"""slice_window_metrics: entry-time trade attribution, window-local rebased
equity, and compute_metrics-compatible keys."""
import datetime as dt
from types import SimpleNamespace

from auto_trader.engine.metrics import slice_window_metrics


def _t(entry_h: int, exit_h: int, pnl: float):
    t0 = dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)
    return SimpleNamespace(
        pnl=pnl, bars_held=exit_h - entry_h,
        entry_time=t0 + dt.timedelta(hours=entry_h),
        exit_time=t0 + dt.timedelta(hours=exit_h),
    )


def _eq(points: list[tuple[int, float]]):
    t0 = dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)
    return [SimpleNamespace(time=t0 + dt.timedelta(hours=h), equity=e)
            for h, e in points]


T0 = dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc).timestamp()
H = 3600.0


def test_trades_attributed_by_entry_time():
    trades = [_t(1, 2, 10.0), _t(5, 6, -4.0), _t(9, 12, 7.0)]
    equity = _eq([(i, 1000.0 + i) for i in range(13)])
    m = slice_window_metrics(trades, equity, T0 + 4 * H, T0 + 8 * H, 1000.0, 3600)
    assert m["n_trades"] == 1
    assert m["net_pnl"] == -4.0
    assert m["win_rate"] == 0.0


def test_equity_rebased_to_starting_cash():
    # Run drifted to 1100 before the window; inside the window equity goes
    # 1100 -> 1150 -> 1120. Window-local drawdown must measure from the
    # rebased peak (1050), not from the run's absolute values.
    trades = [_t(5, 6, 50.0)]
    equity = _eq([(0, 1000.0), (2, 1100.0), (5, 1150.0), (7, 1120.0)])
    m = slice_window_metrics(trades, equity, T0 + 4 * H, T0 + 8 * H, 1000.0, 3600)
    # e0 (last point before window) = 1100 -> rebased points 1050, 1020.
    # Peak seeded at starting cash 1000 -> peak 1050, dd = 30/1050.
    assert abs(m["max_drawdown_pct"] - (30.0 / 1050.0 * 100)) < 1e-9


def test_empty_window_is_flat_not_error():
    m = slice_window_metrics([], _eq([(0, 1000.0)]), T0 + 10 * H, T0 + 20 * H, 1000.0, 3600)
    assert m["n_trades"] == 0
    assert m["net_pnl"] == 0.0
    assert m["sharpe"] is None
