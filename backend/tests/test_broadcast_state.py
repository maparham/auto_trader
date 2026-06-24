"""State pub/sub broadcast fan-out.

Pin the M3 fix: iterating a snapshot so a subscriber that mutates the live set
during the `send_json` await (a concurrent connect/disconnect) can't raise
"Set changed size during iteration", and dead sockets are pruned.
"""

from __future__ import annotations

import asyncio

from auto_trader.api import app as app_module


class _OKWS:
    async def send_json(self, message: dict) -> None:
        pass


class _MutatingWS:
    """Mid-send, mutates the live subscriber set — the concurrent-connect race."""

    async def send_json(self, message: dict) -> None:
        app_module._state_subscribers.add(_OKWS())


class _DeadWS:
    async def send_json(self, message: dict) -> None:
        raise RuntimeError("client gone")


def _reset(subs: set) -> None:
    app_module._state_subscribers.clear()
    app_module._state_subscribers.update(subs)


def test_broadcast_survives_set_mutation_during_send() -> None:
    _reset({_MutatingWS(), _OKWS()})
    # Pre-fix this raised "Set changed size during iteration".
    asyncio.run(app_module._broadcast_state({"key": "k", "value": 1, "origin": ""}))


def test_broadcast_prunes_dead_sockets() -> None:
    dead, alive = _DeadWS(), _OKWS()
    _reset({dead, alive})
    asyncio.run(app_module._broadcast_state({"key": "k", "value": 1, "origin": ""}))
    assert dead not in app_module._state_subscribers
    assert alive in app_module._state_subscribers
    app_module._state_subscribers.clear()
