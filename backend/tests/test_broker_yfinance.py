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
