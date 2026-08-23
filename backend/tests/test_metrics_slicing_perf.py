"""Equivalence guard for the bisect/epoch-array fast path in
slice_window_metrics: the optimized implementation must reproduce the original
scan-everything semantics exactly, with or without precomputed arrays. The
reference below IS the pre-optimization implementation's selection logic."""
import datetime as dt
from types import SimpleNamespace

from auto_trader.engine.metrics import slice_window_metrics

T0 = dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)
T0S = T0.timestamp()
H = 3600.0


def _t(entry_h: float, exit_h: float, pnl: float):
    return SimpleNamespace(
        pnl=pnl, bars_held=int(exit_h - entry_h),
        entry_time=T0 + dt.timedelta(hours=entry_h),
        exit_time=T0 + dt.timedelta(hours=exit_h),
    )


def _eq(points):
    return [SimpleNamespace(time=T0 + dt.timedelta(hours=h), equity=e)
            for h, e in points]


def _reference(trades, equity, from_ts, to_ts, cash):
    """The old selection logic: linear scans with per-element .timestamp()."""
    w_trades = [t for t in trades if from_ts <= t.entry_time.timestamp() < to_ts]
    e0 = cash
    for pt in equity:
        if pt.time.timestamp() >= from_ts:
            break
        e0 = pt.equity
    w_equity = [(pt.time, pt.equity) for pt in equity
                if from_ts <= pt.time.timestamp() < to_ts]
    return w_trades, e0, w_equity


# Entry-unordered on purpose: the engine orders trades by EXIT time, so a short
# exit can precede an earlier long entry. The trades path must stay a linear
# filter, never a bisect.
TRADES = [_t(2, 3, 5.0), _t(1, 4, -2.0), _t(4, 4.5, 1.0),
          _t(3.5, 9, 8.0), _t(8, 12, -1.0), _t(11, 20, 3.0)]
EQUITY = _eq([(i, 1000.0 + 3 * i) for i in range(21)])

# Windows covering: boundary equality (from/to landing exactly on points),
# straddling trades, a window before all data, after all data, empty middle
# gap, and the full range.
WINDOWS = [
    (T0S + 4 * H, T0S + 8 * H),      # from/to exactly on an equity point + trade entry
    (T0S + 3.5 * H, T0S + 11 * H),   # straddled by trades on both edges
    (T0S - 10 * H, T0S),             # entirely before the data
    (T0S + 30 * H, T0S + 40 * H),    # entirely after the data
    (T0S + 4.25 * H, T0S + 4.75 * H),  # no equity point, one trade entry inside
    (T0S, T0S + 21 * H),             # full range
]


def _cases():
    for w_from, w_to in WINDOWS:
        yield TRADES, EQUITY, w_from, w_to
    yield [], [], T0S, T0S + 5 * H  # empty run


def test_matches_reference_selection_without_arrays():
    for trades, equity, w_from, w_to in _cases():
        got = slice_window_metrics(trades, equity, w_from, w_to, 1000.0, 3600)
        ref_trades, ref_e0, ref_eq = _reference(trades, equity, w_from, w_to, 1000.0)
        assert got["n_trades"] == len(ref_trades), (w_from, w_to)
        assert got["net_pnl"] == round(sum(t.pnl for t in ref_trades), 5)
        # Drawdown depends on the exact rebased equity slice, so it pins both
        # the e0 derivation and the window slice bounds.
        offset = 1000.0 - ref_e0
        peak, max_dd = 1000.0, 0.0
        for _, e in ref_eq:
            peak = max(peak, e + offset)
            max_dd = max(max_dd, peak - (e + offset))
        assert got["max_drawdown"] == round(max_dd, 5), (w_from, w_to)


def test_precomputed_arrays_change_nothing():
    trade_ts = [t.entry_time.timestamp() for t in TRADES]
    eq_ts = [pt.time.timestamp() for pt in EQUITY]
    for w_from, w_to in WINDOWS:
        plain = slice_window_metrics(TRADES, EQUITY, w_from, w_to, 1000.0, 3600)
        shared = slice_window_metrics(TRADES, EQUITY, w_from, w_to, 1000.0, 3600,
                                      trade_ts=trade_ts, eq_ts=eq_ts)
        assert plain == shared, (w_from, w_to)
