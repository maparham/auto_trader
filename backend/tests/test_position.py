from datetime import datetime, timezone

from auto_trader.engine.backtest import Position


def test_position_defaults():
    p = Position(qty=1.0, entry=100.0, open_time=datetime(2024, 1, 1, tzinfo=timezone.utc), open_reason="enter")
    assert p.stop is None and p.target is None
    assert p.extreme == 0.0
    assert p.breakeven_armed is False
