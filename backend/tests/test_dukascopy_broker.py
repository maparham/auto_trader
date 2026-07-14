"""Dukascopy broker: mapping helpers + candle building (no network).

The library's fetch() is monkeypatched everywhere; these tests never hit
Dukascopy. Constant VALUES are opaque strings from dukascopy_python, so we
assert against the library's own constants, not hardcoded strings.
"""

from __future__ import annotations

from datetime import datetime, timezone

import dukascopy_python
import dukascopy_python.instruments as dinstr
import pandas as pd
import pytest

from auto_trader.brokers.dukascopy import (
    DukascopyBroker,
    _instrument_for,
    _interval_for,
    _offer_side_for,
)
from auto_trader.core.models import Resolution


def test_instrument_for_known_epic():
    assert _instrument_for("EURUSD") == dinstr.INSTRUMENT_FX_MAJORS_EUR_USD


def test_instrument_for_unknown_epic_raises():
    with pytest.raises(ValueError, match="unknown"):
        _instrument_for("NOPE")


def test_interval_for_minute():
    assert _interval_for(Resolution.MINUTE) == dukascopy_python.INTERVAL_MIN_1


def test_interval_for_hour():
    assert _interval_for(Resolution.HOUR) == dukascopy_python.INTERVAL_HOUR_1


def test_offer_side_bid_ask_mid():
    assert _offer_side_for("bid") == dukascopy_python.OFFER_SIDE_BID
    assert _offer_side_for("ask") == dukascopy_python.OFFER_SIDE_ASK
    assert _offer_side_for("mid") is None


# --- get_candles ---------------------------------------------------------


def _fake_df(rows):
    """rows: list of (unix_seconds, o, h, l, c, v) -> OHLC DataFrame indexed by
    a tz-aware UTC DatetimeIndex named 'timestamp', mirroring dukascopy_python."""
    idx = pd.DatetimeIndex(
        [datetime.fromtimestamp(r[0], tz=timezone.utc) for r in rows], name="timestamp"
    )
    return pd.DataFrame(
        {
            "open": [r[1] for r in rows],
            "high": [r[2] for r in rows],
            "low": [r[3] for r in rows],
            "close": [r[4] for r in rows],
            "volume": [r[5] for r in rows],
        },
        index=idx,
    )


@pytest.fixture
def broker():
    return DukascopyBroker()


def _patch_fetch(monkeypatch, by_side):
    """by_side: dict OFFER_SIDE_* -> DataFrame. Records calls."""
    calls = []

    def fake_fetch(instrument, interval, offer_side, start, end):
        calls.append((instrument, interval, offer_side, start, end))
        return by_side[offer_side]

    monkeypatch.setattr("dukascopy_python.fetch", fake_fetch)
    return calls


def test_get_candles_bid_single_fetch(broker, monkeypatch):
    import asyncio

    df = _fake_df([(1_600_000_000, 1.1, 1.2, 1.05, 1.15, 10.0)])
    calls = _patch_fetch(monkeypatch, {dukascopy_python.OFFER_SIDE_BID: df})
    start = datetime(2020, 9, 13, tzinfo=timezone.utc)
    end = datetime(2020, 9, 14, tzinfo=timezone.utc)

    out = asyncio.run(broker.get_candles("EURUSD", Resolution.MINUTE, start, end, "bid"))

    assert len(calls) == 1  # bid only, no mid averaging
    assert len(out) == 1
    c = out[0]
    assert c.time == datetime.fromtimestamp(1_600_000_000, tz=timezone.utc)
    assert (c.open, c.high, c.low, c.close, c.volume) == (1.1, 1.2, 1.05, 1.15, 10.0)


def test_get_candles_mid_averages_bid_ask(broker, monkeypatch):
    import asyncio

    bid = _fake_df([(1_600_000_000, 1.0, 1.0, 1.0, 1.0, 4.0)])
    ask = _fake_df([(1_600_000_000, 2.0, 2.0, 2.0, 2.0, 6.0)])
    calls = _patch_fetch(
        monkeypatch,
        {dukascopy_python.OFFER_SIDE_BID: bid, dukascopy_python.OFFER_SIDE_ASK: ask},
    )
    start = datetime(2020, 9, 13, tzinfo=timezone.utc)
    end = datetime(2020, 9, 14, tzinfo=timezone.utc)

    out = asyncio.run(broker.get_candles("EURUSD", Resolution.MINUTE, start, end, "mid"))

    assert len(calls) == 2  # bid + ask
    assert out[0].close == 1.5  # (1.0 + 2.0) / 2


def test_get_candles_sorted_ascending(broker, monkeypatch):
    import asyncio

    df = _fake_df(
        [
            (1_600_000_120, 3, 3, 3, 3, 1.0),
            (1_600_000_000, 1, 1, 1, 1, 1.0),
            (1_600_000_060, 2, 2, 2, 2, 1.0),
        ]
    )
    _patch_fetch(monkeypatch, {dukascopy_python.OFFER_SIDE_BID: df})
    start = datetime(2020, 9, 13, tzinfo=timezone.utc)
    end = datetime(2020, 9, 14, tzinfo=timezone.utc)

    out = asyncio.run(broker.get_candles("EURUSD", Resolution.MINUTE, start, end, "bid"))
    assert [c.close for c in out] == [1, 2, 3]


def test_get_candles_unknown_epic_raises(broker):
    import asyncio

    start = datetime(2020, 9, 13, tzinfo=timezone.utc)
    end = datetime(2020, 9, 14, tzinfo=timezone.utc)
    with pytest.raises(ValueError, match="unknown"):
        asyncio.run(broker.get_candles("NOPE", Resolution.MINUTE, start, end, "bid"))


# --- recent / quote / catalogue -----------------------------------------


def test_get_recent_candles_tails_count(broker, monkeypatch):
    import asyncio

    rows = [(1_600_000_000 + 60 * i, i, i, i, i, 1.0) for i in range(10)]
    _patch_fetch(monkeypatch, {dukascopy_python.OFFER_SIDE_BID: _fake_df(rows)})
    out = asyncio.run(broker.get_recent_candles("EURUSD", Resolution.MINUTE, 3, "bid"))
    assert len(out) == 3
    assert [c.close for c in out] == [7, 8, 9]  # last 3, ascending


def test_get_quote_is_none(broker):
    import asyncio

    assert asyncio.run(broker.get_quote("EURUSD")) == (None, None)


def test_all_markets_lists_catalogue(broker):
    import asyncio

    markets = asyncio.run(broker.all_markets())
    epics = {m["epic"] for m in markets}
    assert {"EURUSD", "XAUUSD", "US500"} <= epics
    eur = next(m for m in markets if m["epic"] == "EURUSD")
    assert eur["name"] == "EUR/USD"
    assert eur["type"] == "fx"


def test_search_markets_matches_epic_and_name(broker):
    import asyncio

    by_epic = asyncio.run(broker.search_markets("eur"))
    assert any(m["epic"] == "EURUSD" for m in by_epic)
    by_name = asyncio.run(broker.search_markets("gold"))
    assert any(m["epic"] == "XAUUSD" for m in by_name)


def test_market_meta_has_precision(broker):
    import asyncio

    meta = asyncio.run(broker.get_market_meta("USDJPY"))
    assert meta is not None
    # Must be "pricePrecision" (the key the market route + frontend read), not
    # "precision" (which would be silently dropped -> wrong chart decimals).
    assert meta["pricePrecision"] == 3
    assert asyncio.run(broker.get_market_meta("NOPE")) is None


def test_get_recent_candles_zero_count_returns_empty(broker, monkeypatch):
    import asyncio

    rows = [(1_600_000_000 + 60 * i, i, i, i, i, 1.0) for i in range(5)]
    _patch_fetch(monkeypatch, {dukascopy_python.OFFER_SIDE_BID: _fake_df(rows)})
    out = asyncio.run(broker.get_recent_candles("EURUSD", Resolution.MINUTE, 0, "bid"))
    assert out == []  # not the whole window (bars[-0:] quirk)


def test_get_candles_mid_empty_one_side_returns_empty(broker, monkeypatch):
    import asyncio

    bid = _fake_df([(1_600_000_000, 1.0, 1.0, 1.0, 1.0, 4.0)])
    empty_ask = _fake_df([])
    _patch_fetch(
        monkeypatch,
        {dukascopy_python.OFFER_SIDE_BID: bid, dukascopy_python.OFFER_SIDE_ASK: empty_ask},
    )
    start = datetime(2020, 9, 13, tzinfo=timezone.utc)
    end = datetime(2020, 9, 14, tzinfo=timezone.utc)
    # Only bid has data; must NOT fabricate a single-sided series cached as "mid".
    out = asyncio.run(broker.get_candles("EURUSD", Resolution.MINUTE, start, end, "mid"))
    assert out == []


def test_build_registry_includes_dukascopy():
    from auto_trader.brokers.registry import build_registry

    registry = build_registry()
    assert "dukascopy" in registry.data
    assert "dukascopy" in registry.describe()["data"]
