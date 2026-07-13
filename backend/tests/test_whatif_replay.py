"""replay_bracket: walk bars forward with the engine's pessimistic intrabar
bracket rules (mirrors BacktestEngine._intrabar_exit ordering)."""

from datetime import datetime, timedelta, timezone

from auto_trader.core.models import Candle
from auto_trader.engine.whatif import replay_bracket


def _mk(bars):
    t0 = datetime(2026, 1, 5, tzinfo=timezone.utc)
    return [
        Candle(time=t0 + timedelta(hours=i), open=o, high=h, low=lo, close=c, volume=0.0)
        for i, (o, h, lo, c) in enumerate(bars)
    ]


def test_long_hits_target():
    candles = _mk([(100, 101, 99, 100), (100, 106, 99, 105)])
    outcome, i = replay_bracket(candles, 0, "long", stop=95.0, target=105.0)
    assert outcome == "target" and i == 1


def test_long_hits_stop_before_target_same_bar():
    # Same bar touches both: stop wins (pessimistic), matching _intrabar_exit,
    # which checks low <= stop before high >= target when the open gaps neither.
    candles = _mk([(100, 106, 94, 100)])
    outcome, i = replay_bracket(candles, 0, "long", stop=95.0, target=105.0)
    assert outcome == "stop" and i == 0


def test_long_gap_open_through_target():
    # Open at/above target resolves as target at the open, before the stop check.
    candles = _mk([(106, 107, 94, 100)])
    outcome, i = replay_bracket(candles, 0, "long", stop=95.0, target=105.0)
    assert outcome == "target" and i == 0


def test_short_hits_stop():
    candles = _mk([(100, 101, 99, 100), (100, 105, 99, 104)])
    outcome, i = replay_bracket(candles, 0, "short", stop=104.0, target=90.0)
    assert outcome == "stop" and i == 1


def test_short_gap_open_through_target():
    candles = _mk([(89, 106, 88, 100)])
    outcome, i = replay_bracket(candles, 0, "short", stop=105.0, target=90.0)
    assert outcome == "target" and i == 0


def test_undecided_at_array_end():
    candles = _mk([(100, 101, 99, 100)] * 3)
    outcome, i = replay_bracket(candles, 0, "long", stop=95.0, target=105.0)
    assert outcome == "undecided" and i is None


def test_undecided_at_horizon():
    candles = _mk([(100, 101, 99, 100)] * 10)
    outcome, i = replay_bracket(candles, 0, "long", stop=95.0, target=105.0, horizon=5)
    assert outcome == "undecided" and i is None


def test_stop_only_and_none_bracket():
    candles = _mk([(100, 101, 94, 95)])
    outcome, i = replay_bracket(candles, 0, "long", stop=95.0, target=None)
    assert outcome == "stop" and i == 0
    assert replay_bracket(candles, 0, "long", stop=None, target=None) == ("undecided", None)


def test_start_beyond_array_is_undecided():
    candles = _mk([(100, 101, 99, 100)])
    assert replay_bracket(candles, 5, "long", stop=95.0, target=105.0) == ("undecided", None)
