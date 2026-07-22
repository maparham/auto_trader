"""Engine `stop_index` hook: running over the full candle list but stopping at
index k must be identical to running over the truncated prefix candles[:k+1].

This is the invariant WFO exact mode relies on: a per-window run can pass the
FULL candle list (so causal indicator series computed once are reused) and stop
at the window's end, and it will match a real truncated run bar-for-bar."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from auto_trader.core.models import Candle, Side, Signal
from auto_trader.engine.backtest import BacktestEngine
from auto_trader.strategy.base import Context, Strategy


def _series(closes: list[float]) -> list[Candle]:
    t0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
    return [Candle(t0 + timedelta(minutes=i), c, c, c, c, 0.0)
            for i, c in enumerate(closes)]


class FlipEvery(Strategy):
    """Buy when flat, close when held, on alternating bars, so positions open
    and close across the range (some still open at an arbitrary stop point)."""

    def on_bar(self, ctx: Context) -> list[Signal]:
        n = len(ctx.history)
        if n % 4 == 1:
            return [Signal(Side.BUY, 1.0, "in")]
        if n % 4 == 3:
            return [Signal(Side.SELL, 1.0, "out")]
        return []


def _summary(res):
    return (res.net_pnl, res.n_trades,
            [(t.entry_price, t.exit_price, t.pnl, t.reason_out) for t in res.trades],
            [(round(p.equity, 6)) for p in res.equity])


def test_stop_index_matches_truncated_run():
    closes = [10, 11, 12, 11, 13, 14, 12, 15, 16, 14, 13, 12]
    full = _series(closes)
    for k in range(1, len(full)):
        trunc = full[:k + 1]
        a = BacktestEngine(FlipEvery(), commission_per_side=0.5).run(trunc)
        b = BacktestEngine(FlipEvery(), commission_per_side=0.5).run(full, stop_index=k)
        assert _summary(a) == _summary(b), f"mismatch at stop_index={k}"


def test_stop_index_none_is_full_run():
    full = _series([10, 11, 12, 13, 12, 11])
    a = BacktestEngine(FlipEvery()).run(full)
    b = BacktestEngine(FlipEvery()).run(full, stop_index=None)
    assert _summary(a) == _summary(b)
