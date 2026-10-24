import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from auto_trader.api import deps
from auto_trader.api.line_rebase import rebase_lines, rebase_request_lines
from auto_trader.api.schemas import ExprBacktestRequest
from auto_trader.strategy.expr.lines import LineSpecError, PickedLine, line_series
from auto_trader.api.schemas import PickedLineDTO
from auto_trader.core.models import Candle

BASE = datetime(2026, 1, 1, tzinfo=timezone.utc)
WARN = ("L1 could not be placed on the loaded bars. "
        "Lines older than 5000 bars of their timeframe need picking again.")


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
    warns = asyncio.run(rebase_lines(lines, first_ms=_ms(50), last_ms=_ms(99), broker="capital",
                                     side="mid", loader=loader))
    assert warns == []
    assert lines["L1"].tRef == _ms(50) and lines["L1"].pRef == 6.0 + 0.5 * 40


def test_anchor_inside_range_is_untouched():
    lines = {"L1": _dto()}
    async def loader(*a):
        raise AssertionError("must not fetch")
    assert asyncio.run(rebase_lines(lines, first_ms=_ms(5), last_ms=_ms(99), broker="capital",
                                    side="mid", loader=loader)) == []
    assert lines["L1"].tRef == _ms(10)


def test_fetch_failure_warns():
    lines = {"L1": _dto()}
    async def loader(*a):
        return [], True
    warns = asyncio.run(rebase_lines(lines, first_ms=_ms(50), last_ms=_ms(99), broker="capital",
                                     side="mid", loader=loader))
    assert warns == [WARN]


def test_past_window_of_a_line_picked_later_is_rebased():
    # t2 before the range, tRef (moved to "today" by the live engine) after
    # it: neither anchor is inside [first, last], so the line is placed by
    # counting bars back from tRef (n is negative).
    lines = {"L1": _dto(tRef=_ms(80), pRef=6.0 + 0.5 * 70)}  # 0.5/bar from tRef 10 -> 80
    async def loader(broker, epic, res, side, count):
        return _bars(100), False
    warns = asyncio.run(rebase_lines(lines, first_ms=_ms(30), last_ms=_ms(50), broker="capital",
                                     side="mid", loader=loader))
    assert warns == []
    assert lines["L1"].tRef == _ms(30)
    assert lines["L1"].pRef == 6.0 + 0.5 * 20  # the line's true value at bar 30
    vals = line_series(PickedLine(**lines["L1"].model_dump()), _bars(100)[30:51])
    assert vals == [6.0 + 0.5 * (k - 10) for k in range(30, 51)]


def test_line_starting_after_the_range_is_left_alone():
    lines = {"L1": _dto(t1=_ms(60), t2=_ms(70), tRef=_ms(80))}
    async def loader(*a):
        raise AssertionError("must not fetch")
    assert asyncio.run(rebase_lines(lines, first_ms=_ms(30), last_ms=_ms(50), broker="capital",
                                    side="mid", loader=loader)) == []


def test_loader_gets_the_callers_broker_not_the_lines():
    lines = {"L1": _dto(broker="")}
    seen = []
    async def loader(broker, epic, res, side, count):
        seen.append(broker)
        return _bars(100), False
    asyncio.run(rebase_lines(lines, first_ms=_ms(50), last_ms=_ms(99), broker="yfinance",
                             side="mid", loader=loader))
    assert seen == ["yfinance"]


def _req(lines, broker="capital"):
    return ExprBacktestRequest(
        epic="US100", resolution="HOUR", candles=[], broker=broker, lines=lines,
        costs={"quantity": 1, "commissionPerSide": 0, "slippage": {"kind": "fixed", "value": 0},
               "spread": 0, "startingCash": 10000},
        tradeFromTime=0)


def test_request_over_the_cap_refuses_before_any_fetch(monkeypatch):
    async def loader(*a):
        raise AssertionError("must not fetch")
    monkeypatch.setattr(deps, "load_alert_bars", loader)
    req = _req({f"L{k}": _dto() for k in range(1, 18)})
    with pytest.raises(LineSpecError) as e:
        asyncio.run(rebase_request_lines(req, first_ms=_ms(50), last_ms=_ms(99)))
    assert e.value.code == "too_many_lines"


def test_request_other_broker_line_is_not_fetched(monkeypatch):
    async def loader(*a):
        raise AssertionError("must not fetch")
    monkeypatch.setattr(deps, "load_alert_bars", loader)
    req = _req({"L1": _dto(broker="ig")}, broker="capital")
    assert asyncio.run(rebase_request_lines(req, first_ms=_ms(50), last_ms=_ms(99))) == []
    assert req.lines["L1"].tRef == _ms(10)


def test_request_own_line_fetches_from_the_resolved_broker(monkeypatch):
    seen = []
    async def loader(broker, epic, res, side, count):
        seen.append((broker, res))
        return _bars(100), False
    monkeypatch.setattr(deps, "load_alert_bars", loader)
    req = _req({"L1": _dto(broker="", timeframe="1H")}, broker="capital")
    assert asyncio.run(rebase_request_lines(req, first_ms=_ms(50), last_ms=_ms(99))) == []
    assert seen == [("capital", "HOUR")]
    assert req.lines["L1"].tRef == _ms(50)
