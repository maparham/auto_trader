"""Unit tests for the yfinance data-only broker. All network calls are mocked."""

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
