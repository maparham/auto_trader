"""Unit tests for the oanor IRR data-only broker. All network calls are mocked."""

import asyncio
from datetime import datetime, timezone

import httpx
import pytest

from auto_trader.core.models import Resolution


def test_oanor_settings_gate():
    from auto_trader.config import OanorSettings

    assert OanorSettings(api_key="", _env_file=None).has() is False
    s = OanorSettings(api_key="oanor_live_xyz", _env_file=None)
    assert s.has() is True
    assert s.base_url == "https://api.oanor.com/irr-api"


def _row(date, o=1785100, h=1785200, low=1757800, c=1758050):
    return {"date": date, "open": o, "high": h, "low": low, "close": c,
            "date_jalali": "1405/03/20"}


def test_parse_date_gregorian_slash_format():
    from auto_trader.brokers.oanor import _parse_date

    assert _parse_date("2026/06/10") == datetime(2026, 6, 10, tzinfo=timezone.utc)
    with pytest.raises(ValueError):
        _parse_date("1405/13/40")


def test_rows_to_candles_ascending_closed_only():
    from auto_trader.brokers.oanor import _rows_to_candles

    now = datetime(2026, 6, 10, 12, 0, tzinfo=timezone.utc)
    rows = [_row("2026/06/10"), _row("2026/06/09"), _row("2026/06/08")]  # newest-first
    candles = _rows_to_candles(rows, now=now)
    # 06-10 is still forming at noon UTC → dropped; remainder ascending
    assert [c.time.day for c in candles] == [8, 9]
    c = candles[-1]
    assert (c.open, c.high, c.low, c.close, c.volume) == (
        1785100.0, 1785200.0, 1757800.0, 1758050.0, 0.0)


def test_rows_to_candles_drops_zero_and_missing_ohlc():
    from auto_trader.brokers.oanor import _rows_to_candles

    now = datetime(2026, 6, 20, tzinfo=timezone.utc)
    rows = [
        _row("2026/06/09", o=0),                      # zero open → dropped
        {"date": "2026/06/08", "open": 1, "high": 2},  # missing low/close → dropped
        _row("2026/06/07"),
    ]
    candles = _rows_to_candles(rows, now=now)
    assert [c.time.day for c in candles] == [7]


def _history_payload(dates):
    return {"status": "ok", "success": True,
            "data": {"symbol": "usd", "name": "US Dollar", "unit": "IRR",
                     "source": "tgju.org", "count": len(dates),
                     "history": [_row(d) for d in dates]}}


def _patch_api(monkeypatch, payloads):
    """Replace the HTTP seam; records (path, params) calls, pops payloads FIFO."""
    from auto_trader.brokers import oanor

    calls = []

    async def fake_api_get(client, path, params):
        calls.append((path, dict(params)))
        return payloads.pop(0)

    monkeypatch.setattr(oanor, "_api_get", fake_api_get)
    return calls


@pytest.fixture
def broker():
    from auto_trader.brokers.oanor import OanorBroker

    return OanorBroker(api_key="oanor_test_key")


def test_get_candles_daily_slices_window(monkeypatch, broker):
    calls = _patch_api(monkeypatch, [_history_payload(
        ["2026/06/10", "2026/06/09", "2026/06/08", "2026/06/07"])])
    start = datetime(2026, 6, 8, tzinfo=timezone.utc)
    end = datetime(2026, 6, 9, tzinfo=timezone.utc)
    candles = asyncio.run(broker.get_candles("usd", Resolution.DAY, start, end))
    assert [c.time.day for c in candles] == [8, 9]
    assert calls == [("/v1/history", {"symbol": "usd", "limit": 365})]


def test_get_candles_week_folds_daily(monkeypatch, broker):
    # Mon 2026-05-04 .. Sun 2026-05-17: two complete ISO weeks
    days = [f"2026/05/{d:02d}" for d in range(4, 18)]
    _patch_api(monkeypatch, [_history_payload(list(reversed(days)))])
    start = datetime(2026, 5, 1, tzinfo=timezone.utc)
    end = datetime(2026, 6, 1, tzinfo=timezone.utc)
    candles = asyncio.run(broker.get_candles("usd", Resolution.WEEK, start, end))
    assert len(candles) == 2
    assert all(c.time.weekday() == 0 for c in candles)  # week opens on Monday


def test_get_candles_intraday_returns_empty(monkeypatch, broker):
    calls = _patch_api(monkeypatch, [])
    out = asyncio.run(broker.get_candles(
        "usd", Resolution.HOUR,
        datetime(2026, 6, 1, tzinfo=timezone.utc),
        datetime(2026, 6, 2, tzinfo=timezone.utc)))
    assert out == [] and calls == []  # no wasted API call


def test_get_recent_candles_tails_count(monkeypatch, broker):
    _patch_api(monkeypatch, [_history_payload(
        ["2026/06/09", "2026/06/08", "2026/06/07", "2026/06/06"])])
    candles = asyncio.run(broker.get_recent_candles("usd", Resolution.DAY, 2))
    assert [c.time.day for c in candles] == [8, 9]


def test_get_quote_returns_close_as_mid(monkeypatch, broker):
    payload = {"status": "ok", "success": True,
               "data": {"symbol": "usd", "close": 1758050, "open": 1785100,
                        "high": 1785200, "low": 1757800, "date": "2026/06/10"}}
    calls = _patch_api(monkeypatch, [payload])
    assert asyncio.run(broker.get_quote("usd")) == (1758050.0, 1758050.0)
    assert calls == [("/v1/price", {"symbol": "usd"})]


def test_get_quote_malformed_payload_is_none_none(monkeypatch, broker):
    _patch_api(monkeypatch, [{"status": "ok", "data": {}}])
    assert asyncio.run(broker.get_quote("usd")) == (None, None)


def test_register_adds_data_only_broker():
    from auto_trader.brokers.oanor import OanorBroker, register
    from auto_trader.brokers.registry import BrokerRegistry

    registry = BrokerRegistry()
    broker = register(registry, api_key="k")
    assert isinstance(broker, OanorBroker)
    assert registry.get_data("oanor") is broker
    assert broker.broker_id == "oanor"
    # data-only: synthetic pseudo-account, flagged dataOnly, no real executor
    desc = registry.describe()
    row = next(a for a in desc["exec"] if a["broker"] == "oanor")
    assert row.get("dataOnly") is True


def test_build_registry_gates_on_key(monkeypatch):
    from auto_trader.brokers.registry import build_registry
    from auto_trader.config import oanor_settings

    monkeypatch.setattr(oanor_settings, "api_key", "", raising=False)
    assert "oanor" not in build_registry().data

    monkeypatch.setattr(oanor_settings, "api_key", "k", raising=False)
    assert "oanor" in build_registry().data


_SYMBOLS_PAYLOAD = {"status": "ok", "success": True, "data": {
    "count": 3, "source": "tgju.org", "symbols": [
        {"name": "US Dollar", "unit": "IRR", "symbol": "usd", "category": "currency"},
        {"name": "Gold Ounce (global)", "unit": "USD", "symbol": "ounce", "category": "gold"},
        {"name": "Emami Coin", "unit": "IRR", "symbol": "coin_emami", "category": "gold"},
    ]}}


def test_all_markets_from_symbols_endpoint(monkeypatch, broker):
    calls = _patch_api(monkeypatch, [_SYMBOLS_PAYLOAD])
    rows = asyncio.run(broker.all_markets())
    assert [r["epic"] for r in rows] == ["usd", "ounce", "coin_emami"]
    usd = rows[0]
    assert usd["name"] == "US Dollar" and usd["type"] == "currency"
    assert usd["status"] == "TRADEABLE"
    assert usd["pricePrecision"] == 0        # IRR prices are integers
    assert rows[1]["pricePrecision"] == 2    # ounce is USD-denominated, decimal
    # second call served from the in-process cache — one HTTP hit total
    asyncio.run(broker.all_markets())
    assert len(calls) == 1


def test_search_markets_filters_catalogue(monkeypatch, broker):
    _patch_api(monkeypatch, [_SYMBOLS_PAYLOAD])
    rows = asyncio.run(broker.search_markets("coin"))
    assert [r["epic"] for r in rows] == ["coin_emami"]


def test_market_meta_and_detail(monkeypatch, broker):
    _patch_api(monkeypatch, [_SYMBOLS_PAYLOAD])
    meta = asyncio.run(broker.get_market_meta("usd"))
    assert meta is not None and meta["pricePrecision"] == 0
    assert asyncio.run(broker.get_market_detail("nope")) is None


def test_http_errors_propagate(monkeypatch, broker):
    from auto_trader.brokers import oanor

    async def boom(client, path, params):
        raise httpx.HTTPStatusError(
            "429", request=httpx.Request("GET", "https://x"),
            response=httpx.Response(429))

    monkeypatch.setattr(oanor, "_api_get", boom)
    with pytest.raises(httpx.HTTPStatusError):
        asyncio.run(broker.get_candles(
            "usd", Resolution.DAY,
            datetime(2026, 6, 1, tzinfo=timezone.utc),
            datetime(2026, 6, 2, tzinfo=timezone.utc)))
