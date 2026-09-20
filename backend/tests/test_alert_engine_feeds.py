"""Price feeds for the alert engine: per-(broker, epic) feed tasks that keep
`on_tick` fed, plus the reconciler that spawns/tears them down as the alert
registry changes. Uses a fake broker (no real network / no real brokers) with a
scripted `get_quote` to exercise the polling path, backoff-on-error, and
`_reconcile_feeds` spawn/cancel bookkeeping.
"""

from __future__ import annotations

import asyncio

import pytest

from auto_trader.core import alert_engine as alert_engine_module
from auto_trader.core.alert_engine import AlertEngine
from auto_trader.core.alert_store import AlertStore


def make_engine(tmp_path, get_broker=None):
    store = AlertStore(str(tmp_path / "alerts.db"))
    sent: list[tuple[str, dict]] = []

    async def broadcast(uid, msg):
        sent.append((uid, msg))

    eng = AlertEngine()
    eng.configure(
        store=store,
        get_broker=get_broker if get_broker is not None else (lambda b: None),
        broadcast=broadcast,
        notifiers=[],
    )
    return eng, store, sent


class FakeBroker:
    supports_streaming = False

    def __init__(self, quotes):
        # quotes: list of (bid, ask) or Exception instances, consumed in order
        # then repeats the last entry forever.
        self._quotes = list(quotes)
        self.calls = 0

    async def get_quote(self, epic):
        idx = min(self.calls, len(self._quotes) - 1)
        self.calls += 1
        item = self._quotes[idx]
        if isinstance(item, Exception):
            raise item
        return item


@pytest.fixture(autouse=True)
def fast_poll(monkeypatch):
    monkeypatch.setattr(alert_engine_module, "POLL_INTERVAL", 0.01)
    monkeypatch.setattr(alert_engine_module, "BACKOFF_MIN", 0.01)
    monkeypatch.setattr(alert_engine_module, "BACKOFF_MAX", 0.05)
    monkeypatch.setattr(alert_engine_module, "_BROKER_RETRY_SECONDS", 0.01)


def test_poll_loop_calls_on_tick_with_mid(tmp_path):
    async def main():
        broker = FakeBroker([(99.0, 101.0)])
        eng, store, sent = make_engine(tmp_path, get_broker=lambda b: broker)

        ticks: list[tuple] = []

        async def fake_on_tick(broker_id, epic, mid, bid, ask):
            ticks.append((broker_id, epic, mid, bid, ask))

        eng.on_tick = fake_on_tick

        task = asyncio.create_task(eng._feed_loop("capital", "US100"))
        await asyncio.sleep(0.05)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

        assert len(ticks) >= 1
        broker_id, epic, mid, bid, ask = ticks[0]
        assert broker_id == "capital" and epic == "US100"
        assert mid == 100.0
        assert bid == 99.0 and ask == 101.0

    asyncio.run(main())


def test_poll_loop_stops_on_cancel(tmp_path):
    async def main():
        broker = FakeBroker([(1.0, 2.0)])
        eng, store, sent = make_engine(tmp_path, get_broker=lambda b: broker)

        calls = []

        async def fake_on_tick(broker_id, epic, mid, bid, ask):
            calls.append(1)

        eng.on_tick = fake_on_tick

        task = asyncio.create_task(eng._feed_loop("capital", "US100"))
        await asyncio.sleep(0.03)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        n_at_cancel = len(calls)
        await asyncio.sleep(0.03)
        assert len(calls) == n_at_cancel

    asyncio.run(main())


def test_poll_loop_survives_get_quote_error_and_backs_off(tmp_path):
    async def main():
        broker = FakeBroker([RuntimeError("boom"), RuntimeError("boom"), (5.0, 7.0)])
        eng, store, sent = make_engine(tmp_path, get_broker=lambda b: broker)

        ticks = []

        async def fake_on_tick(broker_id, epic, mid, bid, ask):
            ticks.append(mid)

        eng.on_tick = fake_on_tick

        task = asyncio.create_task(eng._feed_loop("capital", "US100"))
        # Task must survive the errors (never propagate) and eventually tick.
        for _ in range(50):
            if ticks:
                break
            await asyncio.sleep(0.02)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

        assert ticks and ticks[0] == 6.0

    asyncio.run(main())


def test_feed_loop_paused_broker_logs_one_line_and_uses_max_backoff(tmp_path, monkeypatch, caplog):
    """A paused MT5 account is operator state, not a fault: the feed loop logs
    one INFO line without a traceback and waits BACKOFF_MAX before retrying,
    even when the paused error arrives wrapped (as the stream helper raises it)."""
    from auto_trader.brokers.mt5 import MT5PausedError

    async def main():
        class Paused:
            supports_streaming = False

            async def get_quote(self, epic):
                try:
                    raise MT5PausedError("paused")
                except MT5PausedError as e:
                    raise RuntimeError("mt5 stream connect failed") from e

        eng, store, sent = make_engine(tmp_path, get_broker=lambda b: Paused())
        sleeps = []

        async def fake_sleep(secs):
            sleeps.append(secs)
            if len(sleeps) >= 2:
                raise asyncio.CancelledError

        monkeypatch.setattr(alert_engine_module.asyncio, "sleep", fake_sleep)
        with caplog.at_level("INFO", logger="auto_trader.core.alert_engine"):
            with pytest.raises(asyncio.CancelledError):
                await eng._feed_loop("mt5", "CrudeOIL")

        assert sleeps[0] == alert_engine_module.BACKOFF_MAX
        recs = [r for r in caplog.records if "paused" in r.getMessage()]
        assert recs and all(r.levelname == "INFO" and r.exc_info is None for r in recs)
        assert not [r for r in caplog.records if r.levelname == "WARNING"]

    asyncio.run(main())


def test_poll_loop_missing_broker_retries(tmp_path):
    async def main():
        calls = {"n": 0}

        def get_broker(broker_id):
            calls["n"] += 1
            raise RuntimeError("not configured yet")

        eng, store, sent = make_engine(tmp_path, get_broker=get_broker)

        # _BROKER_RETRY_SECONDS is monkeypatched small by fast_poll, so the loop
        # should retry get_broker more than once within this window, and never
        # raise out of the task.
        task = asyncio.create_task(eng._feed_loop("capital", "US100"))
        await asyncio.sleep(0.05)
        assert not task.done()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert calls["n"] >= 2

    asyncio.run(main())


def test_stream_feed_dispatches_to_capital_stream_and_feeds_on_tick(tmp_path, monkeypatch):
    async def main():
        class StreamingBroker(FakeBroker):
            supports_streaming = True

        broker = StreamingBroker([])
        eng, store, sent = make_engine(tmp_path, get_broker=lambda b: broker)

        class FakeBar:
            def __init__(self, close, bid, ask):
                self.candle = type("C", (), {"close": close})()
                self.bid = bid
                self.ask = ask

        async def fake_stream_candles(broker_arg, epic, resolution, price_side):
            assert broker_arg is broker
            assert epic == "US100"
            yield FakeBar(100.0, 99.5, 100.5)
            yield FakeBar(101.0, 100.5, 101.5)

        monkeypatch.setattr(
            "auto_trader.brokers.capital_stream.stream_candles", fake_stream_candles
        )

        ticks = []

        async def fake_on_tick(broker_id, epic, mid, bid, ask):
            ticks.append((broker_id, epic, mid, bid, ask))

        eng.on_tick = fake_on_tick

        await eng._stream_feed(broker, "capital", "US100")

        assert ticks == [
            ("capital", "US100", 100.0, 99.5, 100.5),
            ("capital", "US100", 101.0, 100.5, 101.5),
        ]

    asyncio.run(main())


def test_stream_feed_returns_true_when_it_yields_and_is_not_interrupted(tmp_path, monkeypatch):
    """A stream that DOES yield bars must run to completion unaffected by
    the staleness timeout, and _stream_feed reports it yielded."""
    async def main():
        monkeypatch.setattr(alert_engine_module, "STREAM_STALE_SECONDS", 10.0)

        class StreamingBroker(FakeBroker):
            supports_streaming = True

        broker = StreamingBroker([])
        eng, store, sent = make_engine(tmp_path, get_broker=lambda b: broker)

        class FakeBar:
            def __init__(self, close, bid, ask):
                self.candle = type("C", (), {"close": close})()
                self.bid = bid
                self.ask = ask

        async def fake_stream_candles(broker_arg, epic, resolution, price_side):
            yield FakeBar(100.0, 99.5, 100.5)
            yield FakeBar(101.0, 100.5, 101.5)

        monkeypatch.setattr(
            "auto_trader.brokers.capital_stream.stream_candles", fake_stream_candles
        )

        ticks = []

        async def fake_on_tick(broker_id, epic, mid, bid, ask):
            ticks.append((broker_id, epic, mid, bid, ask))

        eng.on_tick = fake_on_tick

        yielded = await eng._stream_feed(broker, "capital", "US100")

        assert yielded is True
        assert len(ticks) == 2

    asyncio.run(main())


def test_stream_feed_times_out_on_silent_stream_and_returns_false(tmp_path, monkeypatch):
    """A stream that never yields anything must not block forever — bounded
    by STREAM_STALE_SECONDS (patched tiny here), _stream_feed gives up,
    closes the generator, and reports no bar was ever yielded."""
    async def main():
        monkeypatch.setattr(alert_engine_module, "STREAM_STALE_SECONDS", 0.02)

        class StreamingBroker(FakeBroker):
            supports_streaming = True

        broker = StreamingBroker([])
        eng, store, sent = make_engine(tmp_path, get_broker=lambda b: broker)

        closed = {"n": 0}

        async def fake_stream_candles(broker_arg, epic, resolution, price_side):
            try:
                await asyncio.Event().wait()  # never yields
                yield None  # pragma: no cover - unreachable, keeps this a generator
            finally:
                # Fires whether the generator unwinds via the wait_for
                # timeout's cancellation of the in-flight __anext__() or via
                # the explicit aclose() _stream_feed issues afterward —
                # either way this generator got torn down, not leaked.
                closed["n"] += 1

        monkeypatch.setattr(
            "auto_trader.brokers.capital_stream.stream_candles", fake_stream_candles
        )

        ticks = []

        async def fake_on_tick(broker_id, epic, mid, bid, ask):
            ticks.append(1)

        eng.on_tick = fake_on_tick

        yielded = await asyncio.wait_for(
            eng._stream_feed(broker, "capital", "US100"), timeout=2.0
        )

        assert yielded is False
        assert ticks == []
        assert closed["n"] == 1

    asyncio.run(main())


def test_feed_loop_falls_back_to_polling_after_repeated_stream_failures(tmp_path, monkeypatch):
    """The class-level scenario: a streaming broker whose stream keeps going
    silent. After _STREAM_FAILURE_THRESHOLD consecutive no-bar attempts,
    _feed_loop must fall back to polling get_quote for a cycle — on_tick
    still gets fed even though the stream itself never produced anything."""
    async def main():
        monkeypatch.setattr(alert_engine_module, "STREAM_STALE_SECONDS", 0.01)

        class StreamingBroker(FakeBroker):
            supports_streaming = True

        broker = StreamingBroker([(10.0, 12.0)])
        eng, store, sent = make_engine(tmp_path, get_broker=lambda b: broker)

        async def fake_stream_candles(broker_arg, epic, resolution, price_side):
            await asyncio.Event().wait()  # silent forever -> always stale
            yield None  # pragma: no cover

        monkeypatch.setattr(
            "auto_trader.brokers.capital_stream.stream_candles", fake_stream_candles
        )

        ticks = []

        async def fake_on_tick(broker_id, epic, mid, bid, ask):
            ticks.append((mid, bid, ask))

        eng.on_tick = fake_on_tick

        task = asyncio.create_task(eng._feed_loop("capital", "US100"))
        for _ in range(200):
            if ticks:
                break
            await asyncio.sleep(0.02)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

        assert ticks, "polling fallback never fed on_tick after repeated stream staleness"
        assert ticks[0] == (11.0, 10.0, 12.0)

    asyncio.run(main())


def test_poll_feed_max_duration_returns_after_deadline(tmp_path):
    async def main():
        broker = FakeBroker([(1.0, 2.0)])
        eng, store, sent = make_engine(tmp_path, get_broker=lambda b: broker)

        ticks = []

        async def fake_on_tick(broker_id, epic, mid, bid, ask):
            ticks.append(1)

        eng.on_tick = fake_on_tick

        await asyncio.wait_for(
            eng._poll_feed(broker, "capital", "US100", max_duration=0.03),
            timeout=2.0,
        )

        assert ticks  # at least fed once before the deadline

    asyncio.run(main())


def test_feed_spawn_waits_for_draining_task_before_starting_feed_loop(tmp_path):
    async def main():
        eng, store, sent = make_engine(tmp_path)

        order: list[str] = []
        release_old = asyncio.Event()

        async def old_task_body():
            try:
                await release_old.wait()
            finally:
                order.append("old-drained")

        old_task = asyncio.create_task(old_task_body())
        await asyncio.sleep(0)  # let it start running

        key = ("capital", "US100")
        eng._drain(key, old_task)  # registers the done-callback that GCs it

        loop_started = asyncio.Event()

        async def fake_feed_loop(broker_id, epic):
            order.append("new-started")
            loop_started.set()
            await asyncio.Event().wait()  # run forever until cancelled

        eng._feed_loop = fake_feed_loop

        spawn_task = asyncio.create_task(eng._feed_spawn(key))
        await asyncio.sleep(0.02)
        # The new feed loop must NOT have started yet — the old task is still
        # draining (blocked on release_old).
        assert not loop_started.is_set()
        assert key not in eng._draining or old_task in eng._draining.get(key, set())

        release_old.set()
        await asyncio.wait_for(loop_started.wait(), timeout=1)

        assert order == ["old-drained", "new-started"]
        assert key not in eng._draining

        spawn_task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await spawn_task

    asyncio.run(main())


def test_feed_spawn_cancelled_mid_drain_never_starts_feed_loop_and_stop_returns_promptly(tmp_path):
    """A cancel arriving on `_feed_spawn` WHILE it's still awaiting a draining
    predecessor must propagate — not be swallowed by the drain wait — so the
    spawn task actually ends cancelled, `_feed_loop` never starts, and `stop()`
    (which awaits the same task) returns promptly instead of hanging forever."""

    async def main():
        eng, store, sent = make_engine(tmp_path)

        # An old task that never finishes on its own within this test — if
        # the drain wait swallowed our cancellation and pressed on into
        # `_feed_loop` regardless, this would prove it (nothing here ever
        # unblocks it).
        never = asyncio.Event()

        async def old_task_body():
            await never.wait()

        old_task = asyncio.create_task(old_task_body())
        await asyncio.sleep(0)

        key = ("capital", "US100")
        eng._drain(key, old_task)

        loop_started = asyncio.Event()

        async def fake_feed_loop(broker_id, epic):
            loop_started.set()
            await asyncio.Event().wait()

        eng._feed_loop = fake_feed_loop

        spawn_task = asyncio.create_task(eng._feed_spawn(key))
        eng._feed_tasks[key] = spawn_task
        await asyncio.sleep(0.02)  # let it start awaiting the (never-ending) drain

        spawn_task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(spawn_task, timeout=1)

        assert spawn_task.cancelled()
        assert not loop_started.is_set()

        # stop() cancels + awaits old_task too (still draining, never released
        # on its own) — it must come back quickly rather than hang.
        await asyncio.wait_for(eng.stop(), timeout=1)

    asyncio.run(main())


def test_reconcile_feeds_spawns_and_cancels(tmp_path):
    async def main():
        broker = FakeBroker([(1.0, 2.0)])
        eng, store, sent = make_engine(tmp_path, get_broker=lambda b: broker)

        row1 = await store.create(
            "u1",
            {
                "id": "al-1", "broker": "capital", "epic": "US100", "kind": "price_level",
                "params": {"level": 100.0, "condition": "crossing", "trigger": "every"},
                "message": "", "expires_at": None,
                "notify": {"toast": True, "browser": True, "sound": True, "push": True, "telegram": True},
                "precision": 2, "active": 1,
            },
        )
        eng.on_alert_changed("u1", row1, "al-1")
        eng._reconcile_feeds()
        await asyncio.sleep(0)

        assert ("capital", "US100") in eng._feed_tasks
        task1 = eng._feed_tasks[("capital", "US100")]
        assert not task1.done()

        # Delete the alert -> feed no longer needed -> reconcile cancels it.
        eng.on_alert_changed("u1", None, "al-1")
        eng._reconcile_feeds()
        await asyncio.sleep(0.02)

        assert ("capital", "US100") not in eng._feed_tasks
        assert task1.cancelled() or task1.done()

    asyncio.run(main())


def test_reconciler_loop_reacts_to_change_event(tmp_path):
    async def main():
        broker = FakeBroker([(1.0, 2.0)])
        eng, store, sent = make_engine(tmp_path, get_broker=lambda b: broker)

        row1 = await store.create(
            "u1",
            {
                "id": "al-1", "broker": "capital", "epic": "US100", "kind": "price_level",
                "params": {"level": 100.0, "condition": "crossing", "trigger": "every"},
                "message": "", "expires_at": None,
                "notify": {"toast": True, "browser": True, "sound": True, "push": True, "telegram": True},
                "precision": 2, "active": 1,
            },
        )

        reconciler = asyncio.create_task(eng._reconciler_loop())
        eng.on_alert_changed("u1", row1, "al-1")

        for _ in range(50):
            if ("capital", "US100") in eng._feed_tasks:
                break
            await asyncio.sleep(0.01)

        assert ("capital", "US100") in eng._feed_tasks

        reconciler.cancel()
        with pytest.raises(asyncio.CancelledError):
            await reconciler
        for t in eng._feed_tasks.values():
            t.cancel()

    asyncio.run(main())


def test_start_stop_wires_reconciler_and_feed_lifecycle(tmp_path):
    async def main():
        broker = FakeBroker([(1.0, 2.0)])
        eng, store, sent = make_engine(tmp_path, get_broker=lambda b: broker)

        row1 = await store.create(
            "u1",
            {
                "id": "al-1", "broker": "capital", "epic": "US100", "kind": "price_level",
                "params": {"level": 100.0, "condition": "crossing", "trigger": "every"},
                "message": "", "expires_at": None,
                "notify": {"toast": True, "browser": True, "sound": True, "push": True, "telegram": True},
                "precision": 2, "active": 1,
            },
        )
        eng.on_alert_changed("u1", row1, "al-1")
        await eng.start()

        for _ in range(50):
            if ("capital", "US100") in eng._feed_tasks:
                break
            await asyncio.sleep(0.01)
        assert ("capital", "US100") in eng._feed_tasks

        await eng.stop()
        assert eng._feed_tasks == {}
        assert eng._reconciler_task is None or eng._reconciler_task.done()

    asyncio.run(main())
