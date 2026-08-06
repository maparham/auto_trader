from datetime import datetime, timedelta, timezone

from auto_trader.core.models import Candle
from auto_trader.indicators.core import (
    PRICE_SOURCES, evwma_series, price_of, vwma_series,
)


def mk(n, vols=None):
    t0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
    return [
        Candle(
            time=t0 + timedelta(hours=i),
            open=100.0 + i, high=102.0 + i, low=99.0 + i, close=101.0 + i,
            volume=(vols[i] if vols else 10.0),
        )
        for i in range(n)
    ]


def test_price_sources_cover_the_chart_set():
    assert PRICE_SOURCES == (
        "close", "open", "high", "low", "hl2", "hlc3", "ohlc4", "hlcc4",
    )


def test_price_of_each_source():
    c = mk(1)[0]  # o=100 h=102 l=99 c=101
    assert price_of(c, "open") == 100.0
    assert price_of(c, "high") == 102.0
    assert price_of(c, "low") == 99.0
    assert price_of(c, "close") == 101.0
    assert price_of(c, "hl2") == (102.0 + 99.0) / 2
    assert price_of(c, "hlc3") == (102.0 + 99.0 + 101.0) / 3
    assert price_of(c, "ohlc4") == (100.0 + 102.0 + 99.0 + 101.0) / 4
    assert price_of(c, "hlcc4") == (102.0 + 99.0 + 101.0 + 101.0) / 4


def test_price_of_unknown_source_falls_back_to_close():
    assert price_of(mk(1)[0], "nonsense") == 101.0


def test_vwma_warms_up_then_equals_the_weighted_mean():
    candles = mk(4, vols=[1.0, 2.0, 3.0, 4.0])
    prices = [c.close for c in candles]  # 101, 102, 103, 104
    out = vwma_series(candles, prices, 2)
    assert out[0] is None
    assert out[1] == (101.0 * 1 + 102.0 * 2) / 3
    assert out[2] == (102.0 * 2 + 103.0 * 3) / 5
    assert out[3] == (103.0 * 3 + 104.0 * 4) / 7


def test_vwma_is_none_when_the_whole_window_has_no_volume():
    candles = mk(3, vols=[0.0, 0.0, 5.0])
    prices = [c.close for c in candles]
    out = vwma_series(candles, prices, 2)
    assert out[1] is None          # both bars volumeless
    assert out[2] is not None      # one volume-carrying bar in the window


def test_vwma_length_below_one_is_all_none():
    candles = mk(3)
    assert vwma_series(candles, [c.close for c in candles], 0) == [None] * 3


def test_evwma_seeds_from_price_not_zero():
    candles = mk(3, vols=[1.0, 1.0, 1.0])
    prices = [c.close for c in candles]
    out = evwma_series(candles, prices, 2)
    assert out[0] is None
    assert out[1] == 102.0         # seeds from the source price, no zero-ramp
    nbfs = 2.0
    assert out[2] == (102.0 * (nbfs - 1.0) + 1.0 * 103.0) / nbfs


def test_evwma_reseeds_after_a_volumeless_window():
    candles = mk(4, vols=[1.0, 0.0, 0.0, 2.0])
    prices = [c.close for c in candles]
    out = evwma_series(candles, prices, 2)
    assert out[2] is None          # window [0,0] has no volume
    assert out[3] == 104.0         # recursion re-seeds from price
