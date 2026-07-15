from __future__ import annotations

from datetime import datetime, timezone

from auto_trader.core.models import Candle
from auto_trader.engine.exit_time import resolve_exit_time


def _c(ts: int, high: float, low: float) -> Candle:
    dt = datetime.fromtimestamp(ts, tz=timezone.utc)
    return Candle(time=dt, open=(high + low) / 2, high=high, low=low, close=(high + low) / 2)


# 1H run bar starting at t0; five minute candles; the third one first dips to the stop.
T0 = 1_783_299_600  # 2026-07-06 01:00 UTC
MINUTES = [
    _c(T0 + 0, high=29690, low=29650),
    _c(T0 + 60, high=29680, low=29600),
    _c(T0 + 120, high=29650, low=29520),   # first low <= 29533.99
    _c(T0 + 180, high=29560, low=29500),
    _c(T0 + 240, high=29540, low=29480),
]


def test_long_stop_returns_first_minute_low_pierces():
    got = resolve_exit_time(
        leg="long", reason="stop", run_tf_seconds=3600,
        stop_final=29533.99, target=None, exit_price=29533.99, minute_candles=MINUTES,
    )
    assert got == T0 + 120


def test_short_stop_uses_high_side():
    mins = [_c(T0, 29500, 29480), _c(T0 + 60, 29560, 29500)]  # 2nd high >= 29540
    got = resolve_exit_time(
        leg="short", reason="stop", run_tf_seconds=3600,
        stop_final=29540.0, target=None, exit_price=29540.0, minute_candles=mins,
    )
    assert got == T0 + 60


def test_long_target_uses_high_side():
    mins = [_c(T0, 29500, 29480), _c(T0 + 60, 29610, 29550)]  # 2nd high >= 29600
    got = resolve_exit_time(
        leg="long", reason="target", run_tf_seconds=3600,
        stop_final=None, target=29600.0, exit_price=29600.0, minute_candles=mins,
    )
    assert got == T0 + 60


def test_gap_through_open_returns_first_minute():
    mins = [_c(T0, 29540, 29500), _c(T0 + 60, 29520, 29480)]  # first already <= 29533.99
    got = resolve_exit_time(
        leg="long", reason="stop", run_tf_seconds=3600,
        stop_final=29533.99, target=None, exit_price=29533.99, minute_candles=mins,
    )
    assert got == T0


def test_non_intrabar_reason_returns_none():
    assert resolve_exit_time(
        leg="long", reason="MA Slope 100 lt 0.5", run_tf_seconds=3600,
        stop_final=29533.99, target=None, exit_price=29533.99, minute_candles=MINUTES,
    ) is None


def test_run_tf_at_or_below_minute_returns_none():
    assert resolve_exit_time(
        leg="long", reason="stop", run_tf_seconds=60,
        stop_final=29533.99, target=None, exit_price=29533.99, minute_candles=MINUTES,
    ) is None


def test_empty_minutes_returns_none():
    assert resolve_exit_time(
        leg="long", reason="stop", run_tf_seconds=3600,
        stop_final=29533.99, target=None, exit_price=29533.99, minute_candles=[],
    ) is None


import asyncio

from auto_trader.core.models import Side, Trade
from auto_trader.engine.exit_time import attach_exit_times


def _trade(reason: str, exit_ts: int, *, stop=29533.99) -> Trade:
    dt = datetime.fromtimestamp(exit_ts, tz=timezone.utc)
    return Trade(
        side=Side.BUY, quantity=1.0, entry_time=dt, entry_price=29682.4,
        exit_time=dt, exit_price=stop, pnl=-1.0, leg="long",
        reason_out=reason, stop_final=stop,
    )


def test_attach_sets_exact_for_stop_and_skips_rule_exit():
    calls: list[tuple[int, int]] = []

    async def load(from_s: int, to_s: int) -> list[Candle]:
        calls.append((from_s, to_s))
        return MINUTES  # third minute at T0+120 pierces 29533.99

    stop_trade = _trade("stop", T0)
    rule_trade = _trade("MA Slope lt 0.5", T0)

    asyncio.run(attach_exit_times(
        [stop_trade, rule_trade], run_tf_seconds=3600, load_minutes=load,
    ))

    assert int(stop_trade.exit_time_exact.timestamp()) == T0 + 120
    assert rule_trade.exit_time_exact is None
    assert calls == [(T0, T0 + 3600)]  # only the intra-bar exit triggers a load


def test_attach_memoizes_shared_exit_bar():
    loads = 0

    async def load(from_s: int, to_s: int) -> list[Candle]:
        nonlocal loads
        loads += 1
        return MINUTES

    a, b = _trade("stop", T0), _trade("stop", T0)
    asyncio.run(attach_exit_times([a, b], run_tf_seconds=3600, load_minutes=load))
    assert loads == 1  # same exit bar fetched once
