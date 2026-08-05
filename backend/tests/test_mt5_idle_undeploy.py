"""MT5 idle tracking: seconds_until_idle_undeploy decrements with elapsed idle
time, clamps at 0, and resets when a genuine RPC touches _last_use."""
import asyncio
import time

from auto_trader.brokers.mt5 import MT5Broker


def _broker(idle_timeout: int = 1800) -> MT5Broker:
    b = MT5Broker(token="t", account_id="a")
    b._idle_timeout = idle_timeout
    return b


def test_full_window_right_after_touch():
    b = _broker(1800)
    b._last_use = time.monotonic()
    assert 1795 <= b.seconds_until_idle_undeploy() <= 1800


def test_decrements_with_elapsed_idle():
    b = _broker(1800)
    b._last_use = time.monotonic() - 600  # 10 min ago
    assert 1195 <= b.seconds_until_idle_undeploy() <= 1200


def test_clamps_to_zero_past_deadline():
    b = _broker(1800)
    b._last_use = time.monotonic() - 3600  # well past
    assert b.seconds_until_idle_undeploy() == 0


def test_touch_via_bounded_resets_window():
    b = _broker(1800)
    b._last_use = time.monotonic() - 600
    # Simulate a synchronized connection so _bounded runs the call + touches.
    b._state = "OK"
    b._synced = True
    b._conn = object()

    async def fake_call(_conn):
        return "ok"

    asyncio.run(b._bounded(fake_call))
    assert 1795 <= b.seconds_until_idle_undeploy() <= 1800
