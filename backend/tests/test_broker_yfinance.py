"""Unit tests for the yfinance data-only broker. All network calls are mocked."""

from datetime import datetime, timezone

import pandas as pd
import pytest

from auto_trader.core.models import Resolution


def test_curated_epics_map_to_yahoo_tickers():
    from auto_trader.brokers.yfinance import _ticker_for

    assert _ticker_for("EURUSD") == "EURUSD=X"
    assert _ticker_for("US500") == "^GSPC"
    assert _ticker_for("XAUUSD") == "GC=F"
    assert _ticker_for("BTCUSD") == "BTC-USD"
    assert _ticker_for("AAPL") == "AAPL"


def test_uncurated_epic_passes_through_verbatim():
    from auto_trader.brokers.yfinance import _ticker_for

    assert _ticker_for("SHOP") == "SHOP"  # not in the curated map


def test_interval_map_covers_all_resolutions_except_hour4_directly():
    from auto_trader.brokers.yfinance import _INTERVALS, _interval_for

    assert _interval_for(Resolution.MINUTE) == "1m"
    assert _interval_for(Resolution.HOUR) == "1h"
    assert _interval_for(Resolution.DAY) == "1d"
    assert _interval_for(Resolution.WEEK) == "1wk"
    # HOUR_4 is synthesized from 1h, not fetched directly
    assert Resolution.HOUR_4 not in _INTERVALS


def _frame(times, tz="UTC"):
    """Minimal Yahoo-style OHLCV frame (capitalized columns, tz-aware index)."""
    idx = pd.DatetimeIndex(pd.to_datetime(times)).tz_localize(tz)
    n = len(times)
    return pd.DataFrame(
        {
            "Open": [1.0 + i for i in range(n)],
            "High": [2.0 + i for i in range(n)],
            "Low": [0.5 + i for i in range(n)],
            "Close": [1.5 + i for i in range(n)],
            "Volume": [100.0] * n,
        },
        index=idx,
    )


def test_df_to_candles_converts_and_sorts_utc():
    from auto_trader.brokers.yfinance import _df_to_candles

    df = _frame(["2020-01-02", "2020-01-01"])
    now = datetime(2020, 6, 1, tzinfo=timezone.utc)
    candles = _df_to_candles(df, Resolution.DAY, now=now)
    assert [c.time for c in candles] == [
        datetime(2020, 1, 1, tzinfo=timezone.utc),
        datetime(2020, 1, 2, tzinfo=timezone.utc),
    ]
    assert candles[0].open == 2.0 and candles[0].volume == 100.0


def test_df_to_candles_converts_exchange_tz_to_utc():
    from auto_trader.brokers.yfinance import _df_to_candles

    df = _frame(["2020-01-01 09:30"], tz="America/New_York")
    now = datetime(2020, 6, 1, tzinfo=timezone.utc)
    (c,) = _df_to_candles(df, Resolution.MINUTE_30, now=now)
    assert c.time == datetime(2020, 1, 1, 14, 30, tzinfo=timezone.utc)


def test_df_to_candles_drops_forming_bar():
    from auto_trader.brokers.yfinance import _df_to_candles

    df = _frame(["2020-01-01 10:00", "2020-01-01 11:00"])
    # 11:00 bar closes at 12:00, "now" is 11:30 → still forming, must drop
    now = datetime(2020, 1, 1, 11, 30, tzinfo=timezone.utc)
    candles = _df_to_candles(df, Resolution.HOUR, now=now)
    assert [c.time for c in candles] == [
        datetime(2020, 1, 1, 10, 0, tzinfo=timezone.utc)
    ]


def test_df_to_candles_empty_and_none():
    from auto_trader.brokers.yfinance import _df_to_candles

    assert _df_to_candles(None, Resolution.DAY) == []
    assert _df_to_candles(_frame([]), Resolution.DAY) == []


def test_resample_4h_epoch_aligned_ohlcv():
    from auto_trader.brokers.yfinance import _resample_4h

    hours = [f"2020-01-01 {h:02d}:00" for h in range(0, 8)]
    df = _frame(hours)
    out = _resample_4h(df)
    assert len(out) == 2
    assert out.index[0] == pd.Timestamp("2020-01-01 00:00", tz="UTC")
    assert out.index[1] == pd.Timestamp("2020-01-01 04:00", tz="UTC")
    first = out.iloc[0]
    assert first["Open"] == 1.0  # open of 00:00
    assert first["High"] == 5.0  # max high of 00..03 (2+3)
    assert first["Low"] == 0.5  # min low
    assert first["Close"] == 4.5  # close of 03:00 (1.5+3)
    assert first["Volume"] == 400.0  # summed


import asyncio


def test_get_candles_fetches_and_converts(monkeypatch):
    import auto_trader.brokers.yfinance as yfb

    calls = []

    def fake_fetch(ticker, interval, start, end):
        calls.append((ticker, interval, start, end))
        return _frame(["2020-01-01", "2020-01-02"])

    monkeypatch.setattr(yfb, "_fetch_history", fake_fetch)
    broker = yfb.YFinanceBroker()
    start = datetime(2020, 1, 1, tzinfo=timezone.utc)
    end = datetime(2020, 1, 3, tzinfo=timezone.utc)
    candles = asyncio.run(broker.get_candles("EURUSD", Resolution.DAY, start, end))
    assert calls == [("EURUSD=X", "1d", start, end)]
    assert len(candles) == 2
    assert candles[0].time == datetime(2020, 1, 1, tzinfo=timezone.utc)


def test_get_candles_hour4_fetches_1h_and_resamples(monkeypatch):
    import auto_trader.brokers.yfinance as yfb

    calls = []

    def fake_fetch(ticker, interval, start, end):
        calls.append(interval)
        return _frame([f"2020-01-01 {h:02d}:00" for h in range(8)])

    monkeypatch.setattr(yfb, "_fetch_history", fake_fetch)
    broker = yfb.YFinanceBroker()
    start = datetime(2020, 1, 1, tzinfo=timezone.utc)
    end = datetime(2020, 1, 2, tzinfo=timezone.utc)
    candles = asyncio.run(broker.get_candles("AAPL", Resolution.HOUR_4, start, end))
    assert calls == ["1h"]
    assert [c.time.hour for c in candles] == [0, 4]


def test_get_recent_candles_returns_last_n(monkeypatch):
    import auto_trader.brokers.yfinance as yfb

    def fake_fetch(ticker, interval, start, end):
        return _frame([f"2020-01-{d:02d}" for d in range(1, 21)])

    monkeypatch.setattr(yfb, "_fetch_history", fake_fetch)
    broker = yfb.YFinanceBroker()
    candles = asyncio.run(broker.get_recent_candles("AAPL", Resolution.DAY, 5))
    assert len(candles) == 5
    assert candles[-1].time == datetime(2020, 1, 20, tzinfo=timezone.utc)
    assert candles[0].time == datetime(2020, 1, 16, tzinfo=timezone.utc)


def test_get_recent_candles_zero_count():
    import auto_trader.brokers.yfinance as yfb

    assert asyncio.run(yfb.YFinanceBroker().get_recent_candles("AAPL", Resolution.DAY, 0)) == []


def test_get_quote_is_none_none():
    import auto_trader.brokers.yfinance as yfb

    assert asyncio.run(yfb.YFinanceBroker().get_quote("AAPL")) == (None, None)


def test_all_markets_rows_use_price_precision_key():
    import auto_trader.brokers.yfinance as yfb

    rows = asyncio.run(yfb.YFinanceBroker().all_markets())
    assert len(rows) == len(yfb._INSTRUMENT_LIST)
    row = next(r for r in rows if r["epic"] == "EURUSD")
    assert row["pricePrecision"] == 5
    assert row["status"] == "TRADEABLE"
    assert "precision" not in row


def test_search_merges_curated_and_yahoo(monkeypatch):
    import auto_trader.brokers.yfinance as yfb

    def fake_search(query, limit):
        return [
            {"symbol": "SHOP", "shortname": "Shopify Inc.", "quoteType": "EQUITY"},
            {"symbol": "AAPL", "shortname": "Apple Inc.", "quoteType": "EQUITY"},
        ]

    monkeypatch.setattr(yfb, "_search_yahoo", fake_search)
    rows = asyncio.run(yfb.YFinanceBroker().search_markets("sho"))
    epics = [r["epic"] for r in rows]
    assert "SHOP" in epics  # from Yahoo
    shop = next(r for r in rows if r["epic"] == "SHOP")
    assert shop["pricePrecision"] == yfb._DEFAULT_PRECISION
    assert shop["name"] == "Shopify Inc."
    # AAPL is curated: appears once, not duplicated by the Yahoo hit
    assert epics.count("AAPL") <= 1


def test_search_survives_yahoo_failure(monkeypatch):
    import auto_trader.brokers.yfinance as yfb

    def boom(query, limit):
        raise RuntimeError("yahoo down")

    monkeypatch.setattr(yfb, "_search_yahoo", boom)
    rows = asyncio.run(yfb.YFinanceBroker().search_markets("EUR"))
    assert any(r["epic"] == "EURUSD" for r in rows)  # curated still works


def test_market_meta_curated_and_fallback():
    import auto_trader.brokers.yfinance as yfb

    broker = yfb.YFinanceBroker()
    meta = asyncio.run(broker.get_market_meta("US500"))
    assert meta["name"] == "S&P 500"
    fallback = asyncio.run(broker.get_market_meta("SHOP"))
    assert fallback["epic"] == "SHOP"
    assert fallback["pricePrecision"] == yfb._DEFAULT_PRECISION
