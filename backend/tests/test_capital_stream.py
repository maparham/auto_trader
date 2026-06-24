"""Live-stream merge logic: OHLC bar structure + tick quotes -> mid candles.

The OHLC channel owns open/volume and a high/low/close baseline; tick quotes
push the forming bar's close (and stretch high/low) between OHLC pushes. These
tests pin that merge and the dispatch rules (ticks ignored until a bar is named,
stale ticks dropped, `t` advance resets state).
"""

from __future__ import annotations

import asyncio
import json

from auto_trader.brokers import capital_stream
from auto_trader.brokers.capital_stream import _BarState, _TickBar, stream_candles
from auto_trader.core.models import Resolution


def _ohlc(price_type: str, t: int, o, h, l, c, vol=None) -> dict:
    side = {"o": o, "h": h, "l": l, "c": c, "priceType": price_type}
    if vol is not None:
        side["lastTradedVolume"] = vol
    return side


# --- _BarState merge ---------------------------------------------------------


def test_ohlc_only_mids_bid_and_ask():
    bar = _BarState()
    bar.roll(60_000)
    bar.apply_ohlc(_ohlc("bid", 60_000, 100, 110, 90, 105, vol=7))
    bar.apply_ohlc(_ohlc("ask", 60_000, 102, 112, 92, 107))
    c = bar.candle()
    assert (c.open, c.high, c.low, c.close) == (101, 111, 91, 106)
    assert c.volume == 7


def test_tick_moves_close_between_ohlc_pushes():
    bar = _BarState()
    bar.roll(60_000)
    bar.apply_ohlc(_ohlc("bid", 60_000, 100, 100, 100, 100))
    bar.apply_ohlc(_ohlc("ask", 60_000, 100, 100, 100, 100))
    assert bar.candle().close == 100
    bar.apply_tick(103)  # tick more current than the OHLC close
    c = bar.candle()
    assert c.close == 103
    assert c.high == 103  # tick stretches high beyond OHLC's 100
    assert c.low == 100


def test_tick_stretches_low():
    bar = _BarState()
    bar.roll(60_000)
    bar.apply_ohlc(_ohlc("bid", 60_000, 100, 100, 100, 100))
    bar.apply_tick(96)
    c = bar.candle()
    assert c.low == 96
    assert c.close == 96


def test_tick_before_any_ohlc_seeds_open_from_tick():
    bar = _BarState()
    bar.roll(60_000)
    bar.apply_tick(50)
    c = bar.candle()
    assert (c.open, c.high, c.low, c.close) == (50, 50, 50, 50)


def test_open_pinned_to_first_tick_when_no_ohlc_yet():
    # A tick-rolled bar (no OHLC for it yet) must keep the open fixed at the first
    # tick; later ticks move only close/high/low. Regression: open had tracked the
    # latest tick, so the forming candle's open visibly crawled.
    bar = _BarState()
    bar.roll(60_000)
    bar.apply_tick(100)
    bar.apply_tick(105)
    bar.apply_tick(98)
    c = bar.candle()
    assert c.open == 100  # pinned to the first tick, not the latest
    assert c.high == 105 and c.low == 98 and c.close == 98


def test_ohlc_open_overrides_tick_seed_and_stays_fixed():
    # Once Capital's OHLC arrives, the authoritative open replaces the tick seed
    # and then stays put as more ticks land.
    bar = _BarState()
    bar.roll(60_000)
    bar.apply_tick(100)  # tentative open from first tick
    bar.apply_ohlc(_ohlc("bid", 60_000, 90, 90, 90, 90))
    bar.apply_ohlc(_ohlc("ask", 60_000, 90, 90, 90, 90))
    assert bar.candle().open == 90  # corrected to true OHLC open
    bar.apply_tick(110)
    assert bar.candle().open == 90  # still fixed


def test_roll_clears_prior_bar_state():
    bar = _BarState()
    bar.roll(60_000)
    bar.apply_ohlc(_ohlc("bid", 60_000, 100, 100, 100, 100, vol=5))
    bar.apply_tick(120)
    bar.roll(120_000)  # next bar
    assert bar.candle() is None  # nothing priced yet
    bar.apply_ohlc(_ohlc("bid", 120_000, 200, 200, 200, 200))
    c = bar.candle()
    assert c.open == 200 and c.high == 200 and c.low == 200
    assert c.volume == 0.0  # volume did not leak from the prior bar


# --- _TickBar (sub-minute bucketing) -----------------------------------------


def test_tickbar_buckets_by_step_and_seeds_open():
    bar = _TickBar(5)  # 5-second bars
    c = bar.apply_tick(62_300, 100.0)  # 62.3s -> bucket floor(62300/5000)*5000 = 60000
    assert c.time.timestamp() == 60.0  # bar open = 60s
    assert (c.open, c.high, c.low, c.close) == (100, 100, 100, 100)
    assert c.volume == 0.0


def test_tickbar_stretches_within_bucket():
    bar = _TickBar(5)
    bar.apply_tick(60_000, 100.0)
    bar.apply_tick(61_000, 103.0)
    c = bar.apply_tick(62_000, 98.0)
    assert c.open == 100  # first tick of the bucket
    assert c.high == 103
    assert c.low == 98
    assert c.close == 98  # latest tick


def test_tickbar_rolls_to_new_bucket():
    bar = _TickBar(5)
    bar.apply_tick(61_000, 100.0)  # bucket 60000
    c = bar.apply_tick(66_000, 200.0)  # bucket 65000 -> new bar
    assert c.time.timestamp() == 65.0
    assert (c.open, c.high, c.low, c.close) == (200, 200, 200, 200)  # no leak from prior bar


def test_tickbar_quiet_bucket_skips_time_slot():
    # A bucket with no ticks emits nothing; the next tick opens a later bar. Bars
    # are contiguous by index but may skip empty time slots (standard tick-chart).
    bar = _TickBar(5)
    first = bar.apply_tick(60_000, 100.0)  # bucket 60000
    later = bar.apply_tick(73_000, 105.0)  # bucket 70000 (65000 had no ticks)
    assert first.time.timestamp() == 60.0
    assert later.time.timestamp() == 70.0  # 65s slot never emitted


# --- stream_candles dispatch (fake socket) -----------------------------------


class _FakeWS:
    def __init__(self, frames: list[str]):
        self._frames = frames
        self.sent: list[dict] = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def send(self, raw):
        self.sent.append(json.loads(raw))

    async def __aiter__(self):
        for f in self._frames:
            yield f


class _FakeBroker:
    def __init__(self):
        self._cst = "cst"
        self._security_token = "tok"

    async def _ensure_session(self):
        pass


def _run_stream(frames: list[str], n: int):
    """Pull `n` candles from stream_candles backed by a fake socket."""

    async def go():
        ws = _FakeWS(frames)
        orig = capital_stream.websockets.connect
        capital_stream.websockets.connect = lambda url, **kw: ws
        try:
            gen = stream_candles(_FakeBroker(), "BTCUSD", Resolution.MINUTE)
            # The stream yields LiveBar(candle, bid, ask); unwrap to the candle so
            # the OHLC assertions below read it directly. _run_stream_bars keeps the
            # full LiveBar for the bid/ask test.
            out = [(await anext(gen)).candle for _ in range(n)]
            await gen.aclose()
            return out, ws
        finally:
            capital_stream.websockets.connect = orig

    return asyncio.run(go())


def test_subscribes_to_both_channels():
    frames = [json.dumps({"destination": "ohlc.event",
                          "payload": _ohlc("bid", 60_000, 1, 1, 1, 1) | {"t": 60_000}})]
    _, ws = _run_stream(frames, 1)
    dests = {m["destination"] for m in ws.sent}
    assert "OHLCMarketData.subscribe" in dests
    assert "marketData.subscribe" in dests


def test_first_tick_bootstraps_bar_without_waiting_for_ohlc():
    # Cold start: Capital pushes the first ohlc.event ~13s after subscribe (then
    # ~once a bar), so gating bar 1 on it froze the live candle until then — a dead
    # chart on a thin epic whose ticks trickle in. The first tick must instead open
    # bar 1 from the tick clock. Regression for the "chart frozen on load" bug.
    frames = [
        # first tick, before any OHLC -> opens bar 1 at its epoch bucket (60_000)
        json.dumps({"destination": "quote", "payload": {"bid": 9, "ofr": 11, "timestamp": 60_500}}),
        json.dumps({"destination": "ohlc.event",
                    "payload": _ohlc("bid", 60_000, 100, 100, 100, 100) | {"t": 60_000}}),
        json.dumps({"destination": "ohlc.event",
                    "payload": _ohlc("ask", 60_000, 100, 100, 100, 100) | {"t": 60_000}}),
        # a later tick folds into the same bar
        json.dumps({"destination": "quote", "payload": {"bid": 104, "ofr": 106, "timestamp": 60_600}}),
    ]
    candles, _ = _run_stream(frames, 4)  # first tick now yields too -> 4 candles
    assert candles[0].time.timestamp() == 60.0  # bar 1 aligned to the tick bucket
    assert candles[0].close == 10  # mid of 9/11, no OHLC needed
    assert candles[-1].close == 105  # mid of 104/106


def test_daily_quote_before_ohlc_still_waits():
    # DAY/WEEK bars aren't a plain epoch bucket, so the tick-clock bootstrap above
    # doesn't apply: a quote before the anchoring OHLC must still be ignored.
    frames = [
        json.dumps({"destination": "quote", "payload": {"bid": 9, "ofr": 11, "timestamp": 60_500}}),
        json.dumps({"destination": "ohlc.event",
                    "payload": _ohlc("bid", 0, 100, 100, 100, 100) | {"t": 0}}),
    ]

    async def go():
        ws = _FakeWS(frames)
        orig = capital_stream.websockets.connect
        capital_stream.websockets.connect = lambda url, **kw: ws
        try:
            gen = stream_candles(_FakeBroker(), "BTCUSD", Resolution.DAY)
            out = [(await anext(gen)).candle]
            await gen.aclose()
            return out
        finally:
            capital_stream.websockets.connect = orig

    candles = asyncio.run(go())
    assert candles[0].close == 100  # only the OHLC yields; the early tick is ignored


def test_tick_rolls_bar_without_waiting_for_ohlc():
    # A tick in the next minute must roll the forming bar immediately (tick clock),
    # not fold into the old bar until OHLC pushes the new one. Regression for the
    # ~1-bar lag where rollover was OHLC-driven only.
    frames = [
        json.dumps({"destination": "ohlc.event",
                    "payload": _ohlc("bid", 60_000, 100, 100, 100, 100) | {"t": 60_000}}),
        json.dumps({"destination": "ohlc.event",
                    "payload": _ohlc("ask", 60_000, 100, 100, 100, 100) | {"t": 60_000}}),
        # tick still in the 60s bar
        json.dumps({"destination": "quote", "payload": {"bid": 101, "ofr": 101, "timestamp": 61_000}}),
        # tick in the NEXT minute, before any OHLC for it arrives
        json.dumps({"destination": "quote", "payload": {"bid": 200, "ofr": 200, "timestamp": 120_500}}),
    ]
    candles, _ = _run_stream(frames, 4)
    assert candles[-1].time.timestamp() == 120.0  # rolled to the new bar
    assert candles[-1].open == 200 and candles[-1].close == 200
    assert candles[-2].time.timestamp() == 60.0 and candles[-2].close == 101


def test_stale_tick_dropped():
    frames = [
        json.dumps({"destination": "ohlc.event",
                    "payload": _ohlc("bid", 120_000, 100, 100, 100, 100) | {"t": 120_000}}),
        json.dumps({"destination": "quote", "payload": {"bid": 8, "ofr": 8, "timestamp": 119_000}}),
        json.dumps({"destination": "ohlc.event",
                    "payload": _ohlc("bid", 120_000, 100, 100, 100, 100) | {"t": 120_000}}),
    ]
    candles, _ = _run_stream(frames, 2)  # stale tick yields nothing
    assert all(c.close == 100 for c in candles)


def test_late_ohlc_does_not_roll_bar_backward():
    # The tick clock rolls the bar forward to the 120s bucket; then Capital's
    # lazily-pushed OHLC for the PRIOR (60s) bar lands. It must NOT roll the
    # forming bar backward and discard the new bar's ticks. Regression for the
    # `t != bar.t` -> `t > bar.t` fix.
    frames = [
        json.dumps({"destination": "ohlc.event",
                    "payload": _ohlc("bid", 60_000, 100, 100, 100, 100) | {"t": 60_000}}),
        json.dumps({"destination": "ohlc.event",
                    "payload": _ohlc("ask", 60_000, 100, 100, 100, 100) | {"t": 60_000}}),
        # tick in the NEXT minute rolls the bar forward off the tick clock
        json.dumps({"destination": "quote", "payload": {"bid": 200, "ofr": 200, "timestamp": 120_500}}),
        # late OHLC for the OLD 60s bar arrives after the rollover
        json.dumps({"destination": "ohlc.event",
                    "payload": _ohlc("bid", 60_000, 100, 100, 100, 100) | {"t": 60_000}}),
    ]
    # Only 3 candles: the late OHLC frame is ignored and yields nothing (proving
    # the fix — pre-fix it rolled back to 60s and emitted a 4th, backward candle).
    candles, _ = _run_stream(frames, 3)
    assert candles[-1].time.timestamp() == 120.0
    assert candles[-1].close == 200


def test_malformed_ohlc_frame_skipped_not_fatal():
    # An ohlc.event missing `t` (or `payload`) must not raise KeyError and kill the
    # generator with no reconnect. It's skipped; the stream keeps producing.
    frames = [
        json.dumps({"destination": "ohlc.event", "payload": {"priceType": "bid"}}),  # no `t`
        json.dumps({"destination": "ohlc.event"}),  # no `payload`
        json.dumps({"destination": "ohlc.event",
                    "payload": _ohlc("bid", 60_000, 100, 100, 100, 100) | {"t": 60_000}}),
    ]
    candles, _ = _run_stream(frames, 1)  # only the valid frame yields a candle
    assert candles[0].time.timestamp() == 60.0
    assert candles[0].close == 100


def _run_stream_bars(frames: list[str], n: int):
    """Like _run_stream but keep the full LiveBar(candle, bid, ask)."""

    async def go():
        ws = _FakeWS(frames)
        orig = capital_stream.websockets.connect
        capital_stream.websockets.connect = lambda url, **kw: ws
        try:
            gen = stream_candles(_FakeBroker(), "BTCUSD", Resolution.MINUTE)
            out = [await anext(gen) for _ in range(n)]
            await gen.aclose()
            return out
        finally:
            capital_stream.websockets.connect = orig

    return asyncio.run(go())


def test_livebar_carries_raw_bid_and_ask():
    # The candle is price_side-adjusted (mid here), but the LiveBar also carries the
    # raw spread sides for the bid & ask price lines — independent of the candle.
    frames = [
        json.dumps({"destination": "ohlc.event",
                    "payload": _ohlc("bid", 60_000, 100, 100, 100, 100) | {"t": 60_000}}),
        json.dumps({"destination": "ohlc.event",
                    "payload": _ohlc("ask", 60_000, 100, 100, 100, 100) | {"t": 60_000}}),
        json.dumps({"destination": "quote",
                    "payload": {"bid": 104, "ofr": 106, "timestamp": 60_600}}),
    ]
    bars = _run_stream_bars(frames, 3)
    last = bars[-1]
    assert last.candle.close == 105  # mid of 104/106 (price_side=mid)
    assert last.bid == 104 and last.ask == 106  # raw sides, not midded


def test_livebar_bid_ask_known_from_ohlc_before_first_quote():
    # Before any tick quote, the OHLC closes seed bid/ask so the lines have a value.
    frames = [
        json.dumps({"destination": "ohlc.event",
                    "payload": _ohlc("bid", 60_000, 100, 100, 100, 99) | {"t": 60_000}}),
        json.dumps({"destination": "ohlc.event",
                    "payload": _ohlc("ask", 60_000, 100, 100, 100, 101) | {"t": 60_000}}),
    ]
    bars = _run_stream_bars(frames, 2)
    assert bars[-1].bid == 99 and bars[-1].ask == 101
