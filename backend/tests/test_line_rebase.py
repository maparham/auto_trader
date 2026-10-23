import asyncio
from datetime import datetime, timedelta, timezone

from auto_trader.api.line_rebase import rebase_lines
from auto_trader.api.schemas import PickedLineDTO
from auto_trader.core.models import Candle

BASE = datetime(2026, 1, 1, tzinfo=timezone.utc)


def _ms(k):
    return int((BASE + timedelta(hours=k)).timestamp() * 1000)


def _bars(n):
    return [Candle(time=BASE + timedelta(hours=k), open=1, high=1, low=1, close=1, volume=1.0) for k in range(n)]


def _dto(**kw):
    d = dict(epic="US100", broker="capital", timeframe="HOUR", t1=_ms(0), p1=1.0, t2=_ms(2), p2=2.0,
             slope=0.5, tRef=_ms(10), pRef=6.0)
    d.update(kw)
    return PickedLineDTO(**d)


def test_rebases_to_first_loaded_bar():
    lines = {"L1": _dto()}
    async def loader(broker, epic, res, side, count):
        return _bars(100), False
    warns = asyncio.run(rebase_lines(lines, first_ms=_ms(50), side="mid", loader=loader))
    assert warns == []
    assert lines["L1"].tRef == _ms(50) and lines["L1"].pRef == 6.0 + 0.5 * 40


def test_anchor_inside_range_is_untouched():
    lines = {"L1": _dto()}
    async def loader(*a):
        raise AssertionError("must not fetch")
    assert asyncio.run(rebase_lines(lines, first_ms=_ms(5), side="mid", loader=loader)) == []
    assert lines["L1"].tRef == _ms(10)


def test_fetch_failure_warns():
    lines = {"L1": _dto()}
    async def loader(*a):
        return [], True
    warns = asyncio.run(rebase_lines(lines, first_ms=_ms(50), side="mid", loader=loader))
    assert warns == ["L1 could not be placed on the loaded bars."]
