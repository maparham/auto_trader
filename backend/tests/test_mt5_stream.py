"""MT5/MetaApi live-streaming pure logic — the tick-folding bar builder, the
price-side pick, the epoch-bucket rollover math, and the shared listener's
symbol-filtered fan-out. The MetaApi streaming connection itself (network + a
second stateful connection) is not unit-tested; this pins the logic the live
chart and MT5 paper triggers depend on.

Key invariant under test: MetaApi's on_symbol_price_updated fires for EVERY
symbol the terminal tracks, so the listener MUST route by price["symbol"] and
drop symbols with no subscriber (established by the live spike)."""

from __future__ import annotations

import asyncio
import time

import pytest

from auto_trader.brokers import mt5_stream
from auto_trader.brokers.mt5 import MT5Broker
from auto_trader.brokers.mt5_stream import _Bar, _TickListener, _bucket_ms, _pick_side
from auto_trader.core.models import Candle
from datetime import datetime, timezone


class _FakeStreamConn:
    """Records subscribe/unsubscribe calls so the refcount contract can be asserted
    without a live MetaApi streaming connection."""

    def __init__(self) -> None:
        self.subscribed: list[str] = []
        self.unsubscribed: list[str] = []
        self.listeners: list = []

    def add_synchronization_listener(self, listener) -> None:
        self.listeners.append(listener)

    async def subscribe_to_market_data(self, symbol, subscriptions=None):
        self.subscribed.append(symbol)

    async def unsubscribe_from_market_data(self, symbol, subscriptions=None):
        self.unsubscribed.append(symbol)


def _stubbed_broker() -> tuple[MT5Broker, _FakeStreamConn]:
    """An MT5Broker with its streaming connection pre-stubbed (no network)."""
    broker = MT5Broker(token="t", account_id="a")
    conn = _FakeStreamConn()
    broker._stream_conn = conn
    broker._stream_synced = True
    return broker, conn


# --- price side ------------------------------------------------------------

def test_pick_side_mid_is_average() -> None:
    assert _pick_side(1.0, 2.0, "mid") == 1.5


def test_pick_side_bid_and_ask() -> None:
    assert _pick_side(1.0, 2.0, "bid") == 1.0
    assert _pick_side(1.0, 2.0, "ask") == 2.0


def test_pick_side_unknown_falls_back_to_mid() -> None:
    assert _pick_side(1.0, 3.0, "bogus") == 2.0


def test_pick_side_none_when_a_side_missing() -> None:
    assert _pick_side(None, 2.0, "mid") is None
    assert _pick_side(1.0, None, "mid") is None


# --- bucket flooring -------------------------------------------------------

def test_bucket_ms_floors_to_step() -> None:
    step = 60_000  # 1m
    assert _bucket_ms(60_000, step) == 60_000
    assert _bucket_ms(60_001, step) == 60_000
    assert _bucket_ms(119_999, step) == 60_000
    assert _bucket_ms(120_000, step) == 120_000


def test_bucket_ms_phases_to_anchor() -> None:
    # A weekly step anchored on a Sunday must open its buckets on Sundays, not on
    # the Thursday a plain epoch floor (anchor 0) lands on. Anchor at t=100, step 10:
    step = 10
    anchor = 100
    assert _bucket_ms(100, step, anchor) == 100  # exactly on the anchor
    assert _bucket_ms(107, step, anchor) == 100  # within the first bucket
    assert _bucket_ms(110, step, anchor) == 110  # next bucket opens at anchor+step
    assert _bucket_ms(125, step, anchor) == 120  # phased, not floored to 120 from 0
    # A timestamp before the anchor floors to the bucket below it (still phased).
    assert _bucket_ms(95, step, anchor) == 90


# --- tick-fold bar builder -------------------------------------------------

def test_bar_unpriced_yields_none() -> None:
    bar = _Bar(step_ms=60_000)
    bar.roll(60_000)
    assert bar.candle() is None


def test_bar_first_tick_pins_open_and_sets_ohlc() -> None:
    bar = _Bar(step_ms=60_000)
    bar.roll(60_000)
    bar.apply(1.5)
    c = bar.candle()
    assert c is not None
    assert (c.open, c.high, c.low, c.close) == (1.5, 1.5, 1.5, 1.5)
    assert c.time == datetime.fromtimestamp(60, tz=timezone.utc)


def test_bar_folds_ticks_into_high_low_close_open_fixed() -> None:
    bar = _Bar(step_ms=60_000)
    bar.roll(60_000)
    for mid in (1.5, 2.0, 1.2, 1.8):
        bar.apply(mid)
    c = bar.candle()
    assert c.open == 1.5   # pinned to first tick
    assert c.high == 2.0
    assert c.low == 1.2
    assert c.close == 1.8  # last tick


def test_bar_seed_carries_rest_ohlcv_then_ticks_extend() -> None:
    seed = Candle(
        time=datetime.fromtimestamp(60, tz=timezone.utc),
        open=1.0, high=1.4, low=0.9, close=1.1, volume=42,
    )
    bar = _Bar(step_ms=60_000)
    bar.seed(seed)
    # a tick above the seeded high stretches high, moves close, keeps seeded open
    bar.apply(1.6)
    c = bar.candle()
    assert c.open == 1.0
    assert c.high == 1.6
    assert c.low == 0.9
    assert c.close == 1.6
    assert c.volume == 42  # quote ticks carry no volume; seed's is retained


def test_bar_roll_resets_state_for_new_bucket() -> None:
    bar = _Bar(step_ms=60_000)
    bar.roll(60_000)
    bar.apply(5.0)
    bar.roll(120_000)  # new bucket
    assert bar.candle() is None  # reset: no price yet in the new bucket
    bar.apply(3.0)
    c = bar.candle()
    assert c.open == 3.0 and c.close == 3.0
    assert c.time == datetime.fromtimestamp(120, tz=timezone.utc)


# --- listener fan-out ------------------------------------------------------

def test_listener_routes_tick_to_subscribed_symbol_queue() -> None:
    subs: dict[str, set[asyncio.Queue]] = {}
    listener = _TickListener(subs)
    q: asyncio.Queue = asyncio.Queue()
    subs["EURUSD"] = {q}

    asyncio.run(
        listener.on_symbol_price_updated("0", {"symbol": "EURUSD", "bid": 1.1, "ask": 1.2})
    )
    tick = q.get_nowait()
    assert tick == (1.1, 1.2)


def test_listener_ignores_unsubscribed_symbol() -> None:
    subs: dict[str, set[asyncio.Queue]] = {}
    listener = _TickListener(subs)
    q: asyncio.Queue = asyncio.Queue()
    subs["EURUSD"] = {q}

    # A tick for a DIFFERENT symbol (which MetaApi DOES deliver) must not land.
    asyncio.run(
        listener.on_symbol_price_updated("0", {"symbol": "GBPUSD", "bid": 2.0, "ask": 2.1})
    )
    assert q.empty()


def test_listener_fans_out_to_all_queues_for_one_symbol() -> None:
    subs: dict[str, set[asyncio.Queue]] = {}
    listener = _TickListener(subs)
    q1: asyncio.Queue = asyncio.Queue()
    q2: asyncio.Queue = asyncio.Queue()
    subs["EURUSD"] = {q1, q2}

    asyncio.run(
        listener.on_symbol_price_updated("0", {"symbol": "EURUSD", "bid": 1.0, "ask": 1.0})
    )
    assert q1.get_nowait() == (1.0, 1.0)
    assert q2.get_nowait() == (1.0, 1.0)


def test_listener_drops_tick_missing_a_side() -> None:
    subs: dict[str, set[asyncio.Queue]] = {}
    listener = _TickListener(subs)
    q: asyncio.Queue = asyncio.Queue()
    subs["EURUSD"] = {q}

    asyncio.run(
        listener.on_symbol_price_updated("0", {"symbol": "EURUSD", "bid": None, "ask": 1.2})
    )
    assert q.empty()


# --- broker register/unregister refcount -----------------------------------

def test_register_first_queue_subscribes_once() -> None:
    broker, conn = _stubbed_broker()
    q = asyncio.run(broker.register_tick_queue("EURUSD"))
    assert conn.subscribed == ["EURUSD"]
    assert q in broker._tick_subs["EURUSD"]


def test_second_queue_same_symbol_shares_one_subscription() -> None:
    broker, conn = _stubbed_broker()

    async def scenario():
        q1 = await broker.register_tick_queue("EURUSD")
        q2 = await broker.register_tick_queue("EURUSD")
        return q1, q2

    q1, q2 = asyncio.run(scenario())
    assert conn.subscribed == ["EURUSD"]  # subscribed once, not twice
    assert broker._tick_subs["EURUSD"] == {q1, q2}


def test_unregister_last_queue_unsubscribes_and_clears_symbol() -> None:
    broker, conn = _stubbed_broker()

    async def scenario():
        q1 = await broker.register_tick_queue("EURUSD")
        q2 = await broker.register_tick_queue("EURUSD")
        await broker.unregister_tick_queue("EURUSD", q1)
        assert conn.unsubscribed == []  # q2 still there
        await broker.unregister_tick_queue("EURUSD", q2)

    asyncio.run(scenario())
    assert conn.unsubscribed == ["EURUSD"]
    assert "EURUSD" not in broker._tick_subs


def test_register_rolls_back_when_subscribe_fails() -> None:
    # A permanent per-symbol fault (unknown/invalid epic) surfaces from subscribe.
    # register must re-raise AND leave no orphan registration/refcount behind, so a
    # later retry of a valid symbol isn't skewed by a leaked count.
    broker, conn = _stubbed_broker()

    async def boom(symbol, subscriptions=None):
        raise ValueError("unknown symbol")

    conn.subscribe_to_market_data = boom

    with pytest.raises(ValueError):
        asyncio.run(broker.register_tick_queue("BOGUS"))
    assert "BOGUS" not in broker._tick_subs
    assert "BOGUS" not in broker._sub_refcount


def test_register_rolls_back_on_cancellation() -> None:
    # A client disconnect while the FIRST subscribe is in flight cancels the await.
    # CancelledError is a BaseException (not Exception), so a plain `except Exception`
    # rollback would miss it — leaving a dead queue + refcount 1 that permanently
    # blocks re-subscribing the symbol (first=False forever → the symbol goes silent).
    broker, conn = _stubbed_broker()

    async def cancel(symbol, subscriptions=None):
        raise asyncio.CancelledError()

    conn.subscribe_to_market_data = cancel

    with pytest.raises(asyncio.CancelledError):
        asyncio.run(broker.register_tick_queue("EURUSD"))
    assert "EURUSD" not in broker._tick_subs
    assert "EURUSD" not in broker._sub_refcount


# --- stream_candles connect-failure surfaces a recoverable error ------------

class _FailingEnsureBroker:
    """stream_candles must not let a connect/sync exception escape uncaught — the
    router's forward() only catches StreamFatalError/RuntimeError, so anything else
    closes the socket with no error frame. A connect failure is (probably) transient,
    so it should surface as a RECOVERABLE RuntimeError (client retries, self-heals)."""

    broker_id = "mt5"

    async def _ensure_stream(self):
        raise TimeoutError("streaming sync timed out")


def test_stream_connect_failure_raises_runtime_error() -> None:
    from auto_trader.core.models import Resolution

    async def run():
        gen = mt5_stream.stream_candles(
            _FailingEnsureBroker(), "EURUSD", Resolution.MINUTE, "mid"
        )
        async for _ in gen:  # noqa: B007
            break

    with pytest.raises(RuntimeError):
        asyncio.run(run())


# --- stream_candles seeding (integration over a fake broker) ----------------

class _FakeStreamBroker:
    """Minimal MT5Broker stand-in for driving stream_candles without a network.
    `forming` is what get_forming_candle returns; `ticks` are pre-loaded onto the
    queue register_tick_queue hands back."""

    broker_id = "mt5"

    def __init__(self, forming: Candle | None, ticks: list[tuple[float, float]]) -> None:
        self._forming = forming
        self._q: asyncio.Queue = asyncio.Queue()
        for t in ticks:
            self._q.put_nowait(t)

    async def _ensure_stream(self):
        return None

    async def get_forming_candle(self, epic, resolution, price_side="mid"):
        return self._forming

    async def register_tick_queue(self, symbol):
        return self._q

    async def unregister_tick_queue(self, symbol, q):
        return None


def _current_bucket_candle(step_s: int, o, h, lo, c, vol) -> Candle:
    step_ms = step_s * 1000
    t = _bucket_ms(int(time.time() * 1000), step_ms)
    return Candle(
        time=datetime.fromtimestamp(t / 1000, tz=timezone.utc),
        open=o, high=h, low=lo, close=c, volume=vol,
    )


async def _first_bar(broker, resolution) -> "mt5_stream.LiveBar":
    from auto_trader.core.models import Resolution  # noqa: F401
    gen = mt5_stream.stream_candles(broker, "EURUSD", resolution, "mid")
    try:
        async for bar in gen:
            return bar
    finally:
        await gen.aclose()


def test_stream_seeds_forming_bar_so_open_is_rest_not_first_tick() -> None:
    from auto_trader.core.models import Resolution
    # Forming bar for the CURRENT bucket, from REST: open 1.0. A tick at mid 5.0 must
    # extend close/high but leave the REST open + volume intact — proving the seed
    # actually fired (the whole point of seeding vs cold-starting the open at 5.0).
    forming = _current_bucket_candle(60, o=1.0, h=1.4, lo=0.9, c=1.1, vol=42)
    broker = _FakeStreamBroker(forming, ticks=[(5.0, 5.0)])
    bar = asyncio.run(_first_bar(broker, Resolution.MINUTE))
    assert bar.candle.open == 1.0     # seeded REST open, NOT the 5.0 first tick
    assert bar.candle.close == 5.0    # tick moved close
    assert bar.candle.high == 5.0     # tick stretched high
    assert bar.candle.low == 0.9      # seeded low preserved
    assert bar.candle.volume == 42    # seeded volume retained


def test_stream_cold_starts_when_no_forming_candle() -> None:
    from auto_trader.core.models import Resolution
    broker = _FakeStreamBroker(None, ticks=[(5.0, 5.0)])
    bar = asyncio.run(_first_bar(broker, Resolution.MINUTE))
    assert bar.candle.open == 5.0     # cold start: open pins to the first tick
    assert bar.candle.close == 5.0


def _current_week_open(weekday_open: int) -> datetime:
    """00:00 UTC of the most recent `weekday_open` (Mon=0 … Sun=6) at or before now
    — i.e. the open of the week that contains `now`, for a broker whose weeks start
    on that weekday. Used to build a forming WEEKLY seed for the current bucket."""
    now = datetime.now(timezone.utc)
    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    from datetime import timedelta

    days_since = (now.weekday() - weekday_open) % 7
    return midnight - timedelta(days=days_since)


def test_stream_weekly_anchors_to_broker_week_open_not_epoch_thursday() -> None:
    from auto_trader.core.models import Resolution

    # AvaTrade opens weekly bars on Sunday for some instruments; a plain epoch week
    # (604800s) opens on a Thursday. Seed the current SUNDAY-opening week and prove
    # the live bar carries that Sunday open, not the epoch-Thursday bucket.
    sunday_open = _current_week_open(6)  # Sun=6
    seed = Candle(time=sunday_open, open=1.0, high=1.4, low=0.9, close=1.1, volume=42)
    broker = _FakeStreamBroker(seed, ticks=[(5.0, 5.0)])
    bar = asyncio.run(_first_bar(broker, Resolution.WEEK))

    assert bar.candle.time == sunday_open   # phased to the broker's week-open
    assert bar.candle.open == 1.0           # seeded, not cold-started at 5.0
    assert bar.candle.close == 5.0          # tick moved close

    # Guard the point of the test: the un-anchored epoch bucket would land elsewhere
    # (a Thursday), so equality above only holds because of the anchor fix.
    step_ms = Resolution.WEEK.seconds * 1000
    epoch_bucket_ms = _bucket_ms(int(sunday_open.timestamp() * 1000), step_ms)
    assert epoch_bucket_ms != int(sunday_open.timestamp() * 1000)


def test_stream_weekly_without_seed_fails_recoverably_not_misanchored() -> None:
    from auto_trader.core.models import Resolution

    # No forming weekly bar (RPC blip / mid-reconnect) means no correct week-open
    # anchor. Rather than fold onto the epoch-Thursday bucket and emit a weekly bar
    # at the wrong time (a spurious candle beside history), stream_candles must raise
    # a RECOVERABLE RuntimeError so the client retries — the retry's seed usually lands.
    broker = _FakeStreamBroker(None, ticks=[(5.0, 5.0)])
    with pytest.raises(RuntimeError):
        asyncio.run(_first_bar(broker, Resolution.WEEK))


def test_stream_daily_anchors_to_seed_day() -> None:
    from auto_trader.core.models import Resolution

    # DAY phases its bucket to the seed's open. For AvaTrade that's today's 00:00
    # UTC, but anchoring to the seed keeps it correct for a broker whose dailies
    # open at some other (server-time) hour. Seed today's bar; the live bar keeps it.
    now = datetime.now(timezone.utc)
    today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    seed = Candle(time=today, open=2.0, high=2.2, low=1.9, close=2.1, volume=7)
    broker = _FakeStreamBroker(seed, ticks=[(9.0, 9.0)])
    bar = asyncio.run(_first_bar(broker, Resolution.DAY))

    assert bar.candle.time == today   # anchored to the seed's day-open
    assert bar.candle.open == 2.0     # seeded
    assert bar.candle.close == 9.0    # tick moved close


def test_stream_daily_without_seed_cold_starts_not_raises() -> None:
    from auto_trader.core.models import Resolution

    # Unlike WEEK, DAY tolerates a missing seed: the epoch day (anchor 0) opens at
    # 00:00 UTC, where AvaTrade dailies open, so a cold start lands on the right
    # bucket. It must NOT raise (that path is WEEK-only).
    broker = _FakeStreamBroker(None, ticks=[(9.0, 9.0)])
    bar = asyncio.run(_first_bar(broker, Resolution.DAY))

    now_day = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    assert bar.candle.time == now_day  # epoch day = today 00:00 UTC
    assert bar.candle.open == 9.0      # cold start pins open to the first tick
