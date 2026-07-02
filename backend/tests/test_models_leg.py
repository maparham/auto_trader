"""leg field on Signal/Trade and dual-position Context."""

from __future__ import annotations

from datetime import datetime, timezone

from auto_trader.core.models import Fill, Side, Signal, Trade
from auto_trader.strategy.base import Context


def test_signal_has_leg_defaulting_long():
    s = Signal(Side.BUY, 1.0, "enter")
    assert s.leg == "long"
    assert Signal(Side.SELL, 1.0, "short-open", leg="short").leg == "short"


def test_fill_has_leg_defaulting_long():
    t = datetime(2024, 1, 1, tzinfo=timezone.utc)
    assert Fill(t, Side.BUY, 10.0, 1.0, "enter").leg == "long"
    assert Fill(t, Side.SELL, 10.0, 1.0, "s", leg="short").leg == "short"


def test_trade_has_leg():
    t = datetime(2024, 1, 1, tzinfo=timezone.utc)
    trade = Trade(
        side=Side.BUY, quantity=1.0, entry_time=t, entry_price=10.0,
        exit_time=t, exit_price=12.0, pnl=2.0, leg="long",
    )
    assert trade.leg == "long"


def test_context_tracks_both_positions():
    ctx = Context()
    assert ctx.position_long == 0.0
    assert ctx.position_short == 0.0
    ctx.position_long = 5.0
    ctx.position_short = 3.0
    assert (ctx.position_long, ctx.position_short) == (5.0, 3.0)
