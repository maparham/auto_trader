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


class BrokerReconnecting(Exception):
    """The broker's own connection is wedged and being rebuilt in the background.
    Distinct from BrokerUnavailable (which is the shared circuit breaker fast-
    failing): this is raised by a broker that self-heals a stale long-lived socket,
    so the caller should surface a transient "reconnecting" state and retry, not
    treat it as a hard error."""


class BrokerHealth:
    def __init__(
        self,
        *,
        fail_threshold: int = 2,
        cooldown: float = 20.0,
        call_timeout: float = 8.0,
        per_key_timeout: dict[str, float] | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._fail_threshold = fail_threshold
        self._cooldown = cooldown
        self._call_timeout = call_timeout
        # Per-broker wall-clock budget overrides. Most brokers answer REST history in
        # well under the default; a broker whose upstream is inherently slow for some
        # requests (MT5/MetaApi fetching deep daily history takes ~10-30s) needs a
        # bigger budget so its FIRST fetch completes and populates the cache instead
        # of timing out forever. Scoped per key so one slow broker can't relax the
        # tight budget that protects the others.
        self._per_key_timeout = per_key_timeout or {}
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
        the broker is healthy — they're re-raised without ever counting as a failure
        (they never trip the breaker). In the CLOSED state they also don't reset it
        (the fail streak is left untouched); but on a HALF-OPEN trial they DO close
        it, since the broker responding at all proves it has recovered — see the
        `except ignore` handler."""
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
            timeout = self._per_key_timeout.get(key, self._call_timeout)
            result = await asyncio.wait_for(factory(), timeout)
        except ignore:
            # Expected business error — the broker RESPONDED, so it's reachable.
            # In the closed state we deliberately leave the breaker untouched
            # (don't count toward opening, don't reset the fail streak). But on a
            # HALF-OPEN trial (`until is not None`) reaching the broker at all is
            # recovery from the outage that opened it: close the breaker. Otherwise
            # the stale, already-elapsed `_open_until` lingers and pins every future
            # call into single-flight half-open mode for as long as the business
            # error persists (e.g. IG's week-long allowance lockout) — fast-failing
            # concurrent callers as BrokerUnavailable even though the broker is up.
            if until is not None:
                self._record_success(key)
            raise
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
