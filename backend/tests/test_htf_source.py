import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from auto_trader.api import deps
from auto_trader.api.htf_source import (
    HtfNeed, HtfShortfall, closed_before, fetch_htf, htf_needs, source_htf, warm_window,
)
from auto_trader.core.models import Candle
from auto_trader.indicators.registry import resolve_instances
from auto_trader.strategy.expr.parser import parse
from auto_trader.strategy.expr.warmup import warmup_bars

T0 = datetime(2026, 1, 5, tzinfo=timezone.utc)  # a Monday
WEEK = 7 * 86400


def _weeks(n, start=T0):
    return [Candle(time=start + timedelta(weeks=k), open=1, high=2, low=0, close=1, volume=1)
            for k in range(n)]


def test_needs_from_tokens_across_nodes():
    nodes = [parse("EMA(5)@W > 0"), parse("count(candle.close@W > 0, 3) >= 1")]
    needs = htf_needs(nodes)
    assert [(n.tf, n.res, n.tf_s) for n in needs] == [("W", "WEEK", WEEK)]
    # deepest inner warm-up across both nodes (the EMA's), plus one
    assert needs[0].need == warmup_bars(parse("EMA(5) > 0")) + 1


def test_needs_from_a_pane_pin():
    inst = resolve_instances({"SLOPE": {"type": "SLOPE", "calcParams": [5],
                                        "extendData": {"slopePeriod": 3, "mtf": {"timeframe": "1H"}}}})
    needs = htf_needs([parse("SLOPE.5 > 0")], inst)
    assert len(needs) == 1 and needs[0].res == "HOUR" and needs[0].need > 1


def test_warm_window_adds_two_needs_plus_ten_bars():
    need = HtfNeed("W", "WEEK", WEEK, 6)
    start, end, bars = warm_window(need, 1_000_000_000, 1_000_000_000 + 10 * WEEK)
    assert start == 1_000_000_000 - (2 * 6 + 10) * WEEK
    assert end == 1_000_000_000 + 10 * WEEK
    assert bars == (end - start) // WEEK + 2


def test_closed_before_counts_bars_closed_at_or_before_cutoff():
    bars = _weeks(3)
    cutoff = int((T0 + timedelta(weeks=2)).timestamp())
    assert closed_before(bars, WEEK, cutoff) == 2  # the third opens AT the cutoff, so it is not closed


def test_fetch_htf_calls_the_fetcher_with_seven_positionals(monkeypatch):
    calls = []

    async def fake(broker, epic, resolution, bars, from_ts, to_ts, side):
        calls.append((broker, epic, resolution, bars, from_ts, to_ts, side))
        return _weeks(2)

    monkeypatch.setattr(deps, "_fetch_symbol_candles", fake)
    need = HtfNeed("W", "WEEK", WEEK, 2)
    out = asyncio.run(fetch_htf(need, broker="b", epic="E", side="mid", from_ts=0, to_ts=3 * WEEK))
    assert len(out) == 2 and calls == [("b", "E", "WEEK", 5, 0, 3 * WEEK, "mid")]


def test_fetch_htf_passes_degraded_only_when_given(monkeypatch):
    seen = {}

    async def fake(broker, epic, resolution, bars, from_ts, to_ts, side, degraded=None):
        seen["degraded"] = degraded
        if degraded is not None:
            degraded["x"] = True
        return _weeks(1)

    monkeypatch.setattr(deps, "_fetch_symbol_candles", fake)
    need = HtfNeed("W", "WEEK", WEEK, 1)
    d = {}
    asyncio.run(fetch_htf(need, broker="b", epic="E", side="mid", from_ts=0, to_ts=WEEK, degraded=d))
    assert d == {"x": True}


def test_source_htf_skips_shipped_and_checks_sufficiency(monkeypatch):
    fetched = []

    async def fake(broker, epic, resolution, bars, from_ts, to_ts, side):
        fetched.append(resolution)
        return _weeks(10)

    monkeypatch.setattr(deps, "_fetch_symbol_candles", fake)
    nodes = [parse("EMA(3)@W > 0")]
    need = warmup_bars(parse("EMA(3) > 0")) + 1
    cutoff = int((T0 + timedelta(weeks=9)).timestamp())
    kw = dict(broker="b", epic="E", side="mid", from_ts=int(T0.timestamp()), to_ts=cutoff)
    out = asyncio.run(source_htf(nodes, None, cutoff_ts=cutoff, shipped={"WEEK": _weeks(10)}, **kw))
    assert fetched == [] and len(out["WEEK"]) == 10
    with pytest.raises(HtfShortfall) as ei:
        asyncio.run(source_htf(nodes, None, cutoff_ts=cutoff, shipped={"WEEK": _weeks(2)}, **kw))
    assert (ei.value.tf, ei.value.closed, ei.value.need) == ("W", 2, need)
    # no cutoff: the short shipped set is accepted as-is
    out = asyncio.run(source_htf(nodes, None, cutoff_ts=None, shipped={"WEEK": _weeks(2)}, **kw))
    assert len(out["WEEK"]) == 2
    # nothing shipped: fetched once, keyed canonically
    out = asyncio.run(source_htf(nodes, None, cutoff_ts=cutoff, shipped={}, **kw))
    assert fetched == ["WEEK"] and "WEEK" in out


def test_source_htf_empty_fetch_is_a_shortfall_with_no_bars(monkeypatch):
    async def fake(broker, epic, resolution, bars, from_ts, to_ts, side):
        return []

    monkeypatch.setattr(deps, "_fetch_symbol_candles", fake)
    with pytest.raises(HtfShortfall) as ei:
        asyncio.run(source_htf([parse("EMA(3)@W > 0")], None, broker="b", epic="E", side="mid",
                               from_ts=0, to_ts=WEEK, cutoff_ts=WEEK, shipped={}))
    assert ei.value.bars == 0
