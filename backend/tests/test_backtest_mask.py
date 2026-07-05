from datetime import datetime, timezone

from auto_trader.core.models import Candle, Side, Signal
from auto_trader.engine.backtest import BacktestEngine
from auto_trader.engine.schedule import RecurrenceMask


class _AlwaysBuyLong:
    """Signals a long entry every bar (fills next open); no exits."""

    def on_bar(self, ctx):
        return [Signal(side=Side.BUY, quantity=1, reason="test-entry", leg="long")]


def _c(day, o):
    return Candle(
        time=datetime(2024, 1, day, tzinfo=timezone.utc),
        open=o, high=o + 1, low=o - 1, close=o, volume=0,
    )


def test_no_entry_on_inactive_bar():
    # 2024-01-01 Mon, -02 Tue, -03 Wed. Mask: Mondays only (JS getDay Mon==1).
    candles = [_c(1, 100), _c(2, 101), _c(3, 102)]
    mask = RecurrenceMask(enabled=True, days_of_week=(1,))
    result = BacktestEngine(_AlwaysBuyLong(), starting_cash=10_000, mask=mask).run(candles)
    # Entry signalled on Mon(01) fills at Tue(02) open — but Tue is inactive, so no fill.
    entry_fills = [f for f in result.fills if f.reason == "test-entry"]
    assert entry_fills == []


def test_force_flat_at_first_inactive_bar_open():
    # Active Mon-Tue, inactive from Wed. Enter Mon, fill Tue open, force-flat Wed open.
    candles = [_c(1, 100), _c(2, 101), _c(3, 102), _c(4, 103)]
    mask = RecurrenceMask(enabled=True, days_of_week=(1, 2))  # Mon, Tue
    result = BacktestEngine(_AlwaysBuyLong(), starting_cash=10_000, mask=mask).run(candles)
    session_closes = [f for f in result.fills if f.reason == "session close"]
    assert len(session_closes) == 1
    assert session_closes[0].price == 102  # Wed (01-03) open
    assert result.trades[-1].reason_out == "session close"


def test_no_mask_unchanged():
    candles = [_c(1, 100), _c(2, 101), _c(3, 102)]
    result = BacktestEngine(_AlwaysBuyLong(), starting_cash=10_000).run(candles)
    assert any(f.reason == "test-entry" for f in result.fills)
    assert not any(f.reason == "session close" for f in result.fills)
