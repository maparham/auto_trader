from datetime import datetime, timezone

from auto_trader.core.models import Candle, Side, Signal
from auto_trader.engine.backtest import BacktestEngine
from auto_trader.engine.risk import RiskConfig, StopSpec, TargetSpec
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
    # Force-flat is now opt-in, so flatten_at_close must be set explicitly.
    candles = [_c(1, 100), _c(2, 101), _c(3, 102), _c(4, 103)]
    mask = RecurrenceMask(enabled=True, days_of_week=(1, 2), flatten_at_close=True)  # Mon, Tue
    result = BacktestEngine(_AlwaysBuyLong(), starting_cash=10_000, mask=mask).run(candles)
    session_closes = [f for f in result.fills if f.reason == "session close"]
    assert len(session_closes) == 1
    assert session_closes[0].price == 102  # Wed (01-03) open
    assert any(t.reason_out == "session close" for t in result.trades)


def test_no_force_flat_runs_to_target_across_boundary():
    # Default flatten_at_close=False: a position opened inside the window survives
    # past the session boundary and exits on its target, not "session close".
    # Active Mon-Tue only. Enter Mon → fill Tue open (=101). Wed is inactive but
    # the long's 1% target (101 * 1.01 = 102.01) is reached by Wed's high (103).
    candles = [_c(1, 100), _c(2, 101), _c(3, 102), _c(4, 103)]
    mask = RecurrenceMask(enabled=True, days_of_week=(1, 2))  # Mon, Tue; flatten off
    risk = RiskConfig(StopSpec("none"), TargetSpec("pct", value=1.0))
    result = BacktestEngine(
        _AlwaysBuyLong(), starting_cash=10_000, mask=mask, long_risk=risk
    ).run(candles)
    assert not any(f.reason == "session close" for f in result.fills)
    assert len(result.trades) == 1
    trade = result.trades[0]
    assert trade.reason_out == "target"
    assert trade.exit_time == datetime(2024, 1, 3, tzinfo=timezone.utc)  # Wed, past boundary


def test_range_end_books_a_trade_with_commission():
    # A position still open at the last bar is booked as a "range end" Trade via
    # the normal exit path — so it charges an exit commission and never silently
    # vanishes from the Trades table.
    candles = [_c(1, 100), _c(2, 101), _c(3, 102)]
    result = BacktestEngine(
        _AlwaysBuyLong(), starting_cash=10_000, commission_per_side=0.5
    ).run(candles)
    # Entry fills Tue(101), stays open; last bar Wed(102) books the range-end exit.
    assert result.trades[-1].reason_out == "range end"
    last = result.trades[-1]
    assert last.exit_price == 102  # Wed close
    # gross pnl = 1 * (102 - 101) = 1.0; net = gross - 2 commissions (entry+exit).
    assert result.net_pnl == 1.0 - 2 * 0.5


def test_dto_maps_flatten_at_close_over_the_wire():
    # The DTO uses camelCase attr names (no aliases), so the wire key is
    # `flattenAtClose`; to_mask() must map it to the engine's flatten_at_close.
    from auto_trader.api.schemas import RecurrenceMaskDTO

    assert RecurrenceMaskDTO(enabled=True, flattenAtClose=True).to_mask().flatten_at_close is True
    assert RecurrenceMaskDTO(enabled=True).to_mask().flatten_at_close is False  # default off


def test_no_mask_unchanged():
    candles = [_c(1, 100), _c(2, 101), _c(3, 102)]
    result = BacktestEngine(_AlwaysBuyLong(), starting_cash=10_000).run(candles)
    assert any(f.reason == "test-entry" for f in result.fills)
    assert not any(f.reason == "session close" for f in result.fills)
