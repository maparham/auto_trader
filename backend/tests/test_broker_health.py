"""BrokerHealth circuit breaker: bounds a call's time and fast-fails a broken
broker so one bad broker can't block the others. Uses an injected clock so the
cooldown/half-open transitions are deterministic (no sleeps)."""

from __future__ import annotations

import asyncio

import pytest

from auto_trader.core.broker_health import (
    BrokerHealth,
    BrokerTimeout,
    BrokerUnavailable,
)


def _fixed_clock():
    t = {"now": 0.0}
    return t, (lambda: t["now"])


async def _ok():
    return "ok"


async def _boom():
    raise RuntimeError("upstream down")


def test_success_passes_through_and_keeps_breaker_closed() -> None:
    hb = BrokerHealth(fail_threshold=2)
    assert asyncio.run(hb.run("capital", _ok)) == "ok"
    assert hb.is_open("capital") is False


def test_breaker_opens_after_threshold_then_fast_fails_without_calling() -> None:
    t, clock = _fixed_clock()
    hb = BrokerHealth(fail_threshold=2, cooldown=20.0, clock=clock)

    async def scenario():
        # Two failures trip the breaker.
        for _ in range(2):
            with pytest.raises(RuntimeError):
                await hb.run("capital", _boom)
        assert hb.is_open("capital") is True
        # While open, the factory is NOT invoked — fast-fail in microseconds.
        called = {"n": 0}

        async def tracked():
            called["n"] += 1
            return "ok"

        with pytest.raises(BrokerUnavailable):
            await hb.run("capital", tracked)
        assert called["n"] == 0

    asyncio.run(scenario())


def test_other_broker_unaffected_when_one_is_open() -> None:
    """The whole point: capital tripping must not block ig-demo."""
    hb = BrokerHealth(fail_threshold=1)

    async def scenario():
        with pytest.raises(RuntimeError):
            await hb.run("capital", _boom)
        assert hb.is_open("capital") is True
        # ig-demo has its own independent state and still works.
        assert await hb.run("ig-demo", _ok) == "ok"
        assert hb.is_open("ig-demo") is False

    asyncio.run(scenario())


def test_ignored_exception_passes_through_without_tripping_breaker() -> None:
    """An expected business error (e.g. a quota limit) is re-raised but must not
    count as a failure — the broker is healthy, so the breaker stays closed."""
    hb = BrokerHealth(fail_threshold=1)

    class Quota(Exception):
        pass

    async def quota():
        raise Quota()

    async def scenario():
        for _ in range(3):
            with pytest.raises(Quota):
                await hb.run("ig", quota, ignore=(Quota,))
        assert hb.is_open("ig") is False  # never tripped despite repeated raises

    asyncio.run(scenario())


def test_timeout_counts_as_failure_and_raises_broker_timeout() -> None:
    hb = BrokerHealth(fail_threshold=1, call_timeout=0.01)

    async def slow():
        await asyncio.sleep(1.0)

    async def scenario():
        with pytest.raises(BrokerTimeout):
            await hb.run("capital", slow)
        assert hb.is_open("capital") is True

    asyncio.run(scenario())


def test_half_open_trial_after_cooldown_recovers_on_success() -> None:
    t, clock = _fixed_clock()
    hb = BrokerHealth(fail_threshold=1, cooldown=20.0, clock=clock)

    async def scenario():
        with pytest.raises(RuntimeError):
            await hb.run("capital", _boom)
        assert hb.is_open("capital") is True
        # Still open just before the cooldown elapses.
        t["now"] = 19.0
        assert hb.is_open("capital") is True
        # After the cooldown, a trial call is allowed through and a success closes it.
        t["now"] = 21.0
        assert hb.is_open("capital") is False
        assert await hb.run("capital", _ok) == "ok"
        assert hb.is_open("capital") is False

    asyncio.run(scenario())


def test_half_open_admits_only_one_trial_call_at_a_time() -> None:
    """After cooldown the breaker is half-open: a burst of concurrent callers must
    NOT all stampede the still-down broker — exactly one trial is admitted and the
    rest fast-fail with BrokerUnavailable until it resolves."""
    t, clock = _fixed_clock()
    hb = BrokerHealth(fail_threshold=1, cooldown=20.0, clock=clock)

    async def scenario():
        with pytest.raises(RuntimeError):
            await hb.run("capital", _boom)
        assert hb.is_open("capital") is True
        t["now"] = 21.0  # cooldown elapsed -> half-open

        gate = asyncio.Event()
        admitted = {"n": 0}

        async def trial():
            admitted["n"] += 1
            await gate.wait()  # hold the trial in flight
            return "ok"

        # First caller is admitted and parks in-flight.
        task = asyncio.create_task(hb.run("capital", trial))
        await asyncio.sleep(0.05)  # let it enter the factory

        # Concurrent callers while the trial is in flight are fast-failed.
        for _ in range(3):
            with pytest.raises(BrokerUnavailable):
                await hb.run("capital", trial)
        assert admitted["n"] == 1  # only the first reached the factory

        gate.set()  # let the trial finish; success closes the breaker
        assert await task == "ok"
        assert hb.is_open("capital") is False

    asyncio.run(scenario())


def test_half_open_trial_failure_reopens_and_releases_slot() -> None:
    """A failed half-open trial re-opens the breaker (new cooldown) and frees the
    single-flight slot, so the next trial is admitted after the next cooldown."""
    t, clock = _fixed_clock()
    hb = BrokerHealth(fail_threshold=1, cooldown=20.0, clock=clock)

    async def scenario():
        with pytest.raises(RuntimeError):
            await hb.run("capital", _boom)
        t["now"] = 21.0  # half-open
        with pytest.raises(RuntimeError):
            await hb.run("capital", _boom)  # trial fails -> re-open
        assert hb.is_open("capital") is True
        # Slot was released, but we're cooling down again until t=41.
        with pytest.raises(BrokerUnavailable):
            await hb.run("capital", _ok)
        t["now"] = 42.0
        assert await hb.run("capital", _ok) == "ok"  # next trial admitted

    asyncio.run(scenario())
