"""Per-broker circuit breaker: one unhealthy broker must not block the others.

Every backend call to a data broker is served from a single FastAPI origin, so a
browser pools them all on one host (~6 concurrent connections). If a down or slow
broker's calls hang for their full upstream retry+timeout, they hold those shared
connection slots and starve the healthy brokers — and even the broker-selector
fetch — making the whole app look dead when only one broker is down.

This breaker enforces isolation at the broker boundary:

  * every call is bounded to a wall-clock budget (`call_timeout`); a hung upstream
    is cancelled and surfaced as a timeout instead of pending forever, freeing the
    connection;
  * after `fail_threshold` consecutive failures (errors or timeouts) a broker's
    breaker OPENS for `cooldown` seconds — during which its calls fail instantly
    (no network, no held slot) — then half-opens to let one trial call through.

So a down broker returns in microseconds and the others keep working. State is
per broker id and process-global. 404/empty results are NOT failures (the broker
is healthy, the epic just has no data), so only real errors trip the breaker.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from typing import TypeVar

T = TypeVar("T")


class BrokerUnavailable(Exception):
    """The broker's breaker is open: it is fast-failing during its cooldown."""


class BrokerTimeout(Exception):
    """A single broker call exceeded its per-call wall-clock budget."""


class BrokerHealth:
    def __init__(
        self,
        *,
        fail_threshold: int = 2,
        cooldown: float = 20.0,
        call_timeout: float = 8.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._fail_threshold = fail_threshold
        self._cooldown = cooldown
        self._call_timeout = call_timeout
        self._clock = clock
        self._fails: dict[str, int] = {}
        self._open_until: dict[str, float] = {}
        # Keys with a half-open trial call currently in flight (see run()).
        self._half_open: set[str] = set()

    def is_open(self, key: str) -> bool:
        """True while `key`'s breaker is open (within its cooldown window)."""
        until = self._open_until.get(key)
        return until is not None and self._clock() < until

    async def run(
        self,
        key: str,
        factory: Callable[[], Awaitable[T]],
        *,
        ignore: tuple[type[BaseException], ...] = (),
    ) -> T:
        """Run `factory()` under the breaker for `key`.

        Raises BrokerUnavailable immediately if the breaker is open (the factory is
        never invoked, so no coroutine is created), BrokerTimeout if the call
        exceeds the budget, or re-raises the call's own exception. A timeout or
        error counts as a failure; a normal return (including []/None) is a success
        and resets the breaker.

        `ignore` lists *expected business* exceptions (e.g. a quota limit) that mean
        the broker is healthy — they're re-raised WITHOUT recording success or
        failure, so they never trip or reset the breaker."""
        until = self._open_until.get(key)
        if until is not None:
            if self._clock() < until:
                raise BrokerUnavailable(key)  # still cooling down — fail instantly
            # Cooldown elapsed -> HALF-OPEN: let exactly ONE trial call through and
            # fast-fail the rest until it resolves. Without this gate the instant the
            # cooldown expires every concurrent caller (e.g. the per-tab /api/market
            # poll fanning out one request per open tab) passes the time check at
            # once and piles onto the still-down broker together, each hanging the
            # full call_timeout — re-creating the connection-slot starvation the
            # breaker exists to prevent. The check + claim below are synchronous (no
            # await between them and the wait_for), so they're race-free under
            # asyncio's single thread; no lock needed.
            if key in self._half_open:
                raise BrokerUnavailable(key)
            self._half_open.add(key)
        try:
            result = await asyncio.wait_for(factory(), self._call_timeout)
        except ignore:
            raise  # expected business error — leave breaker state untouched
        except asyncio.TimeoutError as e:
            self._record_failure(key)
            raise BrokerTimeout(key) from e
        except Exception:
            self._record_failure(key)
            raise
        else:
            self._record_success(key)
            return result
        finally:
            self._half_open.discard(key)  # release the trial slot (success or fail)

    def _record_failure(self, key: str) -> None:
        n = self._fails.get(key, 0) + 1
        self._fails[key] = n
        if n >= self._fail_threshold:
            self._open_until[key] = self._clock() + self._cooldown

    def _record_success(self, key: str) -> None:
        self._fails.pop(key, None)
        self._open_until.pop(key, None)
