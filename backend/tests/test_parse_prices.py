"""Price-row -> Candle mapping and the mid-price helper.

Pin the T8 fix: a missing/one-sided quote must drop the bar rather than fabricate
a 0.0 close (which would corrupt SMA signals and draw a low=0 spike).
"""

from __future__ import annotations

from auto_trader.brokers.capital import _mid, _parse_prices, pick_side
from auto_trader.core.models import Resolution


def _row(o, h, l, c, t="2022-02-24T10:00:00", vol=5) -> dict:
    """A Capital.com /prices row; each of o/h/l/c is a {bid, ask} dict or None."""
    return {
        "snapshotTimeUTC": t,
        "openPrice": o,
        "highPrice": h,
        "lowPrice": l,
        "closePrice": c,
        "lastTradedVolume": vol,
    }


def _bidask(bid, ask) -> dict:
    return {"bid": bid, "ask": ask}


def test_mid_averages_both_sides() -> None:
    assert _mid(_bidask(100, 102)) == 101


def test_mid_falls_back_to_single_side() -> None:
    assert _mid(_bidask(100, None)) == 100
    assert _mid(_bidask(None, 102)) == 102


def test_mid_returns_none_when_empty_or_both_missing() -> None:
    assert _mid(None) is None
    assert _mid({}) is None
    assert _mid(_bidask(None, None)) is None


def test_parse_prices_maps_a_full_row() -> None:
    rows = [_row(_bidask(100, 102), _bidask(110, 112), _bidask(90, 92), _bidask(104, 106))]
    out = _parse_prices(rows, Resolution.MINUTE)
    assert len(out) == 1
    c = out[0]
    assert (c.open, c.high, c.low, c.close) == (101, 111, 91, 105)
    assert c.volume == 5


def test_pick_side_selects_bid_mid_ask() -> None:
    assert pick_side(100, 102, "bid") == 100
    assert pick_side(100, 102, "ask") == 102
    assert pick_side(100, 102, "mid") == 101
    # Unknown side falls through to mid (matches the WS handler's lenient default).
    assert pick_side(100, 102, "weird") == 101


def test_pick_side_falls_back_to_present_side() -> None:
    assert pick_side(None, 102, "bid") == 102  # no bid -> use ask
    assert pick_side(100, None, "ask") == 100  # no ask -> use bid
    assert pick_side(None, None, "mid") is None


def test_mid_honors_side() -> None:
    assert _mid(_bidask(100, 102), "bid") == 100
    assert _mid(_bidask(100, 102), "ask") == 102
    assert _mid(_bidask(100, 102)) == 101  # default mid


def test_parse_prices_draws_bid_side_when_requested() -> None:
    # Same row, three sides: bid is the low edge, ask the high edge, mid between.
    rows = [_row(_bidask(100, 102), _bidask(110, 112), _bidask(90, 92), _bidask(104, 106))]
    bid = _parse_prices(rows, Resolution.MINUTE, "bid")[0]
    ask = _parse_prices(rows, Resolution.MINUTE, "ask")[0]
    assert (bid.open, bid.high, bid.low, bid.close) == (100, 110, 90, 104)
    assert (ask.open, ask.high, ask.low, ask.close) == (102, 112, 92, 106)


def test_parse_prices_drops_bar_with_missing_component() -> None:
    # closePrice absent -> _mid(None) is None -> bar dropped, no 0.0 fabricated.
    good = _row(_bidask(100, 102), _bidask(110, 112), _bidask(90, 92), _bidask(104, 106))
    bad = _row(_bidask(100, 102), _bidask(110, 112), _bidask(90, 92), None,
               t="2022-02-24T10:01:00")
    out = _parse_prices([good, bad], Resolution.MINUTE)
    assert len(out) == 1  # the bad bar is gone, not coerced to close=0.0
    assert out[0].close == 105
    assert all(c.close != 0.0 for c in out)
