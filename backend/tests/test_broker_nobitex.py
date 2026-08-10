"""Unit tests for the Nobitex data-only broker. All network calls are mocked."""

import asyncio
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from auto_trader.core.models import Resolution


def _udf(ts, closes=None, s="ok"):
    """Minimal UDF payload: toman prices, per-bar volume 7.5."""
    n = len(ts)
    closes = closes or [186000.0 + i for i in range(n)]
    return {
        "s": s,
        "t": list(ts),
        "o": [c - 100 for c in closes],
        "h": [c + 200 for c in closes],
        "l": [c - 300 for c in closes],
        "c": list(closes),
        "v": [7.5] * n,
    }


def test_udf_no_data_is_empty():
    from auto_trader.brokers.nobitex import _udf_to_candles

    assert _udf_to_candles({"s": "no_data"}, Resolution.HOUR) == []


def test_udf_scales_toman_to_rial_not_volume():
    from auto_trader.brokers.nobitex import _udf_to_candles

    now = datetime(2026, 8, 10, tzinfo=timezone.utc)
    ts = [int(datetime(2026, 8, 9, 10, 0, tzinfo=timezone.utc).timestamp())]
    candles = _udf_to_candles(_udf(ts, closes=[186065.0]), Resolution.HOUR, now=now)
    assert len(candles) == 1
    c = candles[0]
    assert c.close == 1860650.0        # x10: toman -> rial
    assert c.open == 1859650.0
    assert c.volume == 7.5             # volume unscaled (base-asset units)
    assert c.time == datetime(2026, 8, 9, 10, 0, tzinfo=timezone.utc)


def test_udf_drops_forming_bar():
    from auto_trader.brokers.nobitex import _udf_to_candles

    now = datetime(2026, 8, 9, 10, 30, tzinfo=timezone.utc)
    ts = [
        int(datetime(2026, 8, 9, 9, 0, tzinfo=timezone.utc).timestamp()),
        int(datetime(2026, 8, 9, 10, 0, tzinfo=timezone.utc).timestamp()),  # forming
    ]
    candles = _udf_to_candles(_udf(ts), Resolution.HOUR, now=now)
    assert [c.time.hour for c in candles] == [9]


def test_udf_daily_restamped_to_utc_midnight_of_tehran_date():
    from auto_trader.brokers.nobitex import _udf_to_candles

    now = datetime(2026, 8, 12, tzinfo=timezone.utc)
    # Nobitex daily bar for Tehran-date 2026-08-10 opens 2026-08-09 20:30 UTC
    ts = [int(datetime(2026, 8, 9, 20, 30, tzinfo=timezone.utc).timestamp())]
    candles = _udf_to_candles(_udf(ts), Resolution.DAY, now=now)
    assert candles[0].time == datetime(2026, 8, 10, tzinfo=timezone.utc)


def test_chunks_cover_range_without_oversized_requests():
    from auto_trader.brokers.nobitex import _chunks

    spans = list(_chunks(0, 1000 * 60, 60, max_bars=450))
    assert spans[0][0] == 0 and spans[-1][1] == 60000
    # contiguous, no gaps/overlap
    assert all(a[1] == b[0] for a, b in zip(spans, spans[1:]))
    assert all((e - s) // 60 <= 450 for s, e in spans)


def _patch_api(monkeypatch, responder):
    """Replace the HTTP seam; records (path, params); responder(path, params)->payload."""
    from auto_trader.brokers import nobitex

    calls = []

    async def fake_api_get(client, path, params):
        calls.append((path, dict(params)))
        return responder(path, dict(params))

    monkeypatch.setattr(nobitex, "_api_get", fake_api_get)
    return calls


@pytest.fixture
def broker():
    from auto_trader.brokers.nobitex import NobitexBroker

    return NobitexBroker()


def test_get_candles_hourly_chunks_and_merges(monkeypatch, broker):
    start = datetime(2026, 8, 1, tzinfo=timezone.utc)
    end = datetime(2026, 8, 2, tzinfo=timezone.utc)

    def responder(path, params):
        # each chunk returns one bar at its own `from`
        return _udf([int(params["from"])])

    calls = _patch_api(monkeypatch, responder)
    candles = asyncio.run(broker.get_candles("USDTIRT", Resolution.HOUR, start, end))
    assert all(p == "/market/udf/history" for p, _ in calls)
    assert all(q["symbol"] == "USDTIRT" and q["resolution"] == "60" for _, q in calls)
    assert len(calls) == 1  # 24 bars fit one <=450-bar chunk
    assert candles and candles[0].time == start


def test_get_candles_week_folds_restamped_dailies(monkeypatch, broker):
    # Tehran-midnight daily anchors (20:30 UTC prior day), Mon 08/03 .. Sun 08/16 Tehran-dates? use two ISO weeks
    days = [datetime(2026, 5, d, 20, 30, tzinfo=timezone.utc) for d in range(3, 17)]
    # bars for Tehran dates 05/04..05/17 (Mon..Sun x2)
    payload = _udf([int(d.timestamp()) for d in days])

    calls = _patch_api(monkeypatch, lambda p, q: payload)
    candles = asyncio.run(broker.get_candles(
        "USDTIRT", Resolution.WEEK,
        datetime(2026, 5, 1, tzinfo=timezone.utc),
        datetime(2026, 6, 1, tzinfo=timezone.utc)))
    assert len(candles) == 2
    assert all(c.time.weekday() == 0 for c in candles)
    assert all(q["resolution"] == "1D" for _, q in calls)
    assert candles[0].volume == 7.5 * 7  # weekly volume summed


def test_get_recent_candles_tails(monkeypatch, broker):
    now = datetime.now(timezone.utc)
    ts = [int((now - timedelta(hours=h)).replace(minute=0, second=0, microsecond=0)
              .timestamp()) for h in range(10, 1, -1)]
    _patch_api(monkeypatch, lambda p, q: _udf(ts))
    candles = asyncio.run(broker.get_recent_candles("USDTIRT", Resolution.HOUR, 3))
    assert len(candles) == 3
    assert candles[0].time < candles[-1].time


def test_get_quote_real_bid_ask_in_rial(monkeypatch, broker):
    payload = {"status": "ok", "stats": {"usdt-rls": {
        "bestBuy": "1858320", "bestSell": "1860470", "latest": "1860650"}}}

    calls = _patch_api(monkeypatch, lambda p, q: payload)
    bid, ask = asyncio.run(broker.get_quote("USDTIRT"))
    # /market/stats is already rial (unlike UDF candles) — no scaling
    assert (bid, ask) == (1858320.0, 1860470.0)
    assert calls == [("/market/stats", {"srcCurrency": "usdt", "dstCurrency": "rls"})]


def test_get_quote_missing_market_none(monkeypatch, broker):
    _patch_api(monkeypatch, lambda p, q: {"status": "ok", "stats": {}})
    assert asyncio.run(broker.get_quote("NOPEIRT")) == (None, None)


def test_http_errors_propagate(monkeypatch, broker):
    from auto_trader.brokers import nobitex

    async def boom(client, path, params):
        raise httpx.HTTPStatusError(
            "500", request=httpx.Request("GET", "https://x"),
            response=httpx.Response(500))

    monkeypatch.setattr(nobitex, "_api_get", boom)
    with pytest.raises(httpx.HTTPStatusError):
        asyncio.run(broker.get_candles(
            "USDTIRT", Resolution.DAY,
            datetime(2026, 6, 1, tzinfo=timezone.utc),
            datetime(2026, 6, 5, tzinfo=timezone.utc)))
