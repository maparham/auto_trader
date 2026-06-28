"""IG Lightstreamer candle aggregation — the pure logic that turns CHART source
bars into the forming target-resolution bar. The Lightstreamer connection itself
(threads + network) isn't unit-tested; this pins the math that the live chart and
the resolution-aggregation depend on."""

from __future__ import annotations

from auto_trader.brokers.ig_stream import _Aggregator, _source_scale, streamable


class _FakeUpdate:
    """Stand-in for a Lightstreamer ItemUpdate (getValue over a field dict)."""

    def __init__(self, **fields: str) -> None:
        self._f = fields

    def getValue(self, name: str):  # noqa: N802 (SDK method name)
        return self._f.get(name)


def _bar(utm: int, o: float, h: float, lo: float, c: float, ltv: str = "") -> _FakeUpdate:
    # Equal bid/offer so the mid equals the given value (keeps the math obvious).
    return _FakeUpdate(
        UTM=str(utm), LTV=ltv, CONS_END="0",
        BID_OPEN=str(o), BID_HIGH=str(h), BID_LOW=str(lo), BID_CLOSE=str(c),
        OFR_OPEN=str(o), OFR_HIGH=str(h), OFR_LOW=str(lo), OFR_CLOSE=str(c),
    )


def test_source_scale_picks_largest_native_divisor() -> None:
    assert _source_scale(60) == 60      # 1m  -> 1MINUTE
    assert _source_scale(300) == 300    # 5m  -> 5MINUTE
    assert _source_scale(900) == 300    # 15m -> from 5MINUTE
    assert _source_scale(1800) == 300   # 30m -> from 5MINUTE
    assert _source_scale(3600) == 3600  # 1h  -> HOUR
    assert _source_scale(14400) == 3600  # 4h -> from HOUR


def test_streamable_is_intraday_only() -> None:
    assert streamable(60) and streamable(14400)
    assert not streamable(86400)  # DAY
    assert not streamable(604800)  # WEEK
    assert not streamable(0)


def test_passthrough_yields_each_minute_bar() -> None:
    agg = _Aggregator(60, "mid")  # 1m target, 1m source
    b1 = agg.update(_bar(60_000, 1.0, 2.0, 0.5, 1.5, ltv="10"))
    assert b1.candle.open == 1.0 and b1.candle.high == 2.0 and b1.candle.close == 1.5
    assert b1.candle.volume == 10.0
    # next minute = a new bar (its own bucket)
    b2 = agg.update(_bar(120_000, 1.5, 1.8, 1.4, 1.6, ltv="7"))
    assert b2.candle.time.timestamp() == 120.0
    assert b2.candle.open == 1.5 and b2.candle.volume == 7.0


def test_aggregates_three_5min_bars_into_one_15min_bucket() -> None:
    agg = _Aggregator(900, "mid")  # 15m target from 5m source
    base = 900_000  # aligned to a 15-minute boundary
    agg.update(_bar(base, 1.0, 2.0, 0.5, 1.5, ltv="10"))
    agg.update(_bar(base + 300_000, 1.5, 3.0, 1.0, 2.5, ltv="20"))
    bar = agg.update(_bar(base + 600_000, 2.5, 2.8, 2.0, 2.7, ltv="5"))
    # one 15m bar: open from the first sub-bar, running high/low, latest close, summed vol
    assert bar.candle.time.timestamp() == 900.0  # bucket open
    assert bar.candle.open == 1.0
    assert bar.candle.high == 3.0
    assert bar.candle.low == 0.5
    assert bar.candle.close == 2.7
    assert bar.candle.volume == 35.0
    # a sub-bar in the NEXT 15m bucket starts a fresh bar
    nxt = agg.update(_bar(base + 900_000, 2.7, 2.9, 2.6, 2.8, ltv="3"))
    assert nxt.candle.time.timestamp() == 1800.0
    assert nxt.candle.open == 2.7 and nxt.candle.volume == 3.0


def test_incomplete_update_returns_none() -> None:
    agg = _Aggregator(60, "mid")
    # MERGE mode can deliver a partial first frame (no OHLC yet) — skip it.
    assert agg.update(_FakeUpdate(UTM="60000", BID_CLOSE="1.0")) is None


def test_price_side_selects_bid_or_ask() -> None:
    upd = _FakeUpdate(
        UTM="60000", LTV="0", CONS_END="0",
        BID_OPEN="10", BID_HIGH="12", BID_LOW="9", BID_CLOSE="11",
        OFR_OPEN="11", OFR_HIGH="13", OFR_LOW="10", OFR_CLOSE="12",
    )
    assert _Aggregator(60, "bid").update(upd).candle.close == 11.0
    assert _Aggregator(60, "ask").update(upd).candle.close == 12.0
    assert _Aggregator(60, "mid").update(upd).candle.close == 11.5
