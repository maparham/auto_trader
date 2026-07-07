"""Shared singletons and infrastructure for the API.

These module globals are the coupling point: app.py and every router import the
SAME objects/functions from here so there is one broker registry, one circuit
breaker, and one candle-fetch path. They are plain module globals (NOT FastAPI
`Depends`) — `_registry` in particular is reassigned by lifespan on startup, so
users that touch it directly read it as `deps._registry` at call time (importing
the name by value would capture the startup `None` forever).
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from typing import TypeVar

from fastapi import HTTPException

from auto_trader.brokers.base import ExecutionBroker, MarketDataBroker
from auto_trader.brokers.capital_stream import SECONDS_INTERVALS
from auto_trader.brokers.ig import IGAllowanceExceeded, IGBroker
from auto_trader.brokers.paper_exec import PaperExecutionBroker
from auto_trader.brokers.registry import BrokerRegistry
from auto_trader.core.broker_health import (
    BrokerHealth,
    BrokerTimeout,
    BrokerUnavailable,
)
from auto_trader.core.candle_aggregate import (
    DERIVED,
    base_count_for,
    bucket_end,
    bucket_open,
    fold,
    is_derived,
)
from auto_trader.core.candle_cache import CANDLE_CACHE
from auto_trader.core.models import Candle, Resolution
from auto_trader.core.tick_store import TICK_STORE

log = logging.getLogger(__name__)

# The broker registry: named data brokers (keyed "capital") and execution brokers
# (keyed "capital:paper"). Built once in lifespan so each broker reuses its
# ~10-min session across requests — a fresh broker per request would re-auth every
# time and trip the session rate limit (1 req/s on /session). Adding a broker is a
# new register() in build_registry(), no route edits.
_registry: BrokerRegistry | None = None


def get_data(broker_id: str) -> MarketDataBroker:
    """The market-data broker for a broker id ("capital"). 404 if unknown."""
    assert _registry is not None, "registry not initialised"
    return _registry.get_data(broker_id)


# Per-broker circuit breaker shared by every data-broker route. Keeps one down or
# slow broker from holding shared connection slots and starving the others — see
# auto_trader.core.broker_health.
BROKER_HEALTH = BrokerHealth()

T = TypeVar("T")


async def guarded(
    broker_id: str, factory: Callable[[], Awaitable[T]], label: str
) -> T:
    """Run a data-broker call under the circuit breaker, mapping its states to HTTP.

    A broker whose breaker is open fast-fails as 503 (so its requests don't hold
    connections and block healthy brokers); a call that exceeds the wall-clock
    budget is a 504; other broker errors stay 502. Deliberate HTTPExceptions
    (e.g. a 404 from an unknown epic) pass through unchanged. IG's historical-data
    allowance being spent is a 429 with a clear, actionable message — and it does
    NOT trip the breaker (the broker is healthy; only REST history is locked out)."""
    try:
        return await BROKER_HEALTH.run(
            broker_id, factory, ignore=(IGAllowanceExceeded,)
        )
    except IGAllowanceExceeded as e:
        raise HTTPException(
            429,
            "IG historical-data limit reached — resets weekly. "
            "Live prices still stream.",
        ) from e
    except BrokerUnavailable as e:
        raise HTTPException(
            503, f"{label}: broker '{broker_id}' temporarily unavailable"
        ) from e
    except BrokerTimeout as e:
        raise HTTPException(504, f"{label}: broker '{broker_id}' timed out") from e
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, f"{label} failed: {e}") from e


def get_exec(account: str) -> ExecutionBroker:
    """The execution broker for an account key ("capital:paper").

    The account is an explicit per-call parameter — never an ambient server
    default — so a request can't be routed to the wrong account by stale shared
    state. 422 if unknown."""
    assert _registry is not None, "registry not initialised"
    return _registry.get_exec(account)


# How often the paper trigger driver checks resting limits / SL / TP against the
# latest tick. 0.5s keeps fills/closes feeling prompt without busy-looping; finer
# than this can't help much since paper marks off the (≤1s) tick stream anyway.
_TRIGGER_INTERVAL = 0.5


# Key prefix for the trades-changed push on the /ws/state channel. The frontend
# refetches positions/orders only when it sees this — replacing the periodic poll.
TRADES_DIRTY_PREFIX = "__trades__:"


async def _run_paper_triggers(broker: PaperExecutionBroker, account: str) -> None:
    """Drive the paper executor's limit/SL/TP triggers off the live tick stream.
    When a trigger changes the book, push a 'trades changed' notification so the
    frontend refetches once — no periodic polling."""
    # Late import to avoid a module-load cycle (routers.state has no deps needs,
    # but importing it here at load time would still couple the two files).
    from .routers.state import _broadcast_state

    while True:
        await asyncio.sleep(_TRIGGER_INTERVAL)
        try:
            if await broker.check_triggers():
                await _broadcast_state(
                    {"key": f"{TRADES_DIRTY_PREFIX}{account}", "origin": ""}
                )
        except Exception:  # never let one bad tick kill the driver
            log.exception("paper trigger check failed")


def _parse_resolution(raw: str) -> Resolution:
    """Validate a native Capital resolution string (422 on anything else).

    Replaces FastAPI's automatic enum coercion, which we dropped so seconds
    intervals can be handled explicitly instead of 422-ing before the handler."""
    try:
        return Resolution(raw)
    except ValueError:
        raise HTTPException(422, f"unknown resolution '{raw}'") from None


async def _fetch_symbol_candles(
    broker_id: str,
    epic: str,
    resolution: str,
    bars: int,
    from_ts: int | None,
    to_ts: int | None,
    price_side: str,
) -> list[Candle]:
    """Fetch raw candles for one epic against one broker: seconds (tick recorder),
    derived (folded from cached base series), or native (cache/broker). Raises the
    same HTTPExceptions as before for bad brokers/windows/IG-derived; does NOT
    raise the native-path "no data at all" 404 — that decision stays with the
    caller (a symbol's emptiness may or may not be fatal depending on context)."""
    if resolution in SECONDS_INTERVALS:
        return await TICK_STORE.bars(broker_id, epic, SECONDS_INTERVALS[resolution], bars)
    if is_derived(resolution):
        # 3m, 2W/3W/6W, 1M/2M/3M, 1Y aren't native resolutions: fold the cached base
        # series (1m for 3m; DAY/WEEK for the rest) into buckets on read. The cache
        # only ever sees the native base series (no derived rows), so its backfill
        # gives us full history.
        rule = DERIVED[resolution]
        base = rule.base
        base_key = (broker_id, epic, base.value, price_side)
        base_seconds = base.seconds
        broker = get_data(broker_id)  # 404 on unknown broker (not a breaker failure)
        # IG daily bars open at 22:00–23:00 UTC the prior calendar day, so folding
        # them by calendar date would shift every month/year bucket a session early
        # (wrong OHLC). Block derived on IG until session-aware bucketing exists —
        # matches the /ws/candles derived guard; the chart keeps its native view.
        if isinstance(broker, IGBroker):
            raise HTTPException(
                422, f"{resolution}: derived timeframes not supported for IG yet"
            )

        async def fetch_range(start_dt, end_dt):
            return await guarded(
                broker_id,
                lambda: broker.get_candles(epic, base, start_dt, end_dt, price_side),
                "data fetch",
            )

        async def fetch_recent(n):
            return await guarded(
                broker_id,
                lambda: broker.get_recent_candles(epic, base, n, price_side),
                "data fetch",
            )

        if from_ts is not None and to_ts is not None:
            if from_ts > to_ts:
                raise HTTPException(422, "from_ts must be <= to_ts")
            # Snap the window OUTWARD to whole bucket boundaries so every folded
            # bucket is complete. Otherwise a window cutting mid-month yields a
            # partial month bar that collides (same open ts, different OHLC) with
            # the full one on scroll-back prepend — chart corruption. `end` stops
            # 1s short of the next bucket so the next bucket's first base bar isn't
            # pulled into a spurious partial.
            try:
                start = datetime.fromtimestamp(bucket_open(from_ts, rule), tz=timezone.utc)
                end = datetime.fromtimestamp(bucket_end(to_ts, rule) - 1, tz=timezone.utc)
            except (OverflowError, OSError, ValueError) as e:
                raise HTTPException(422, f"from_ts/to_ts out of range: {e}") from e
            base_bars = await CANDLE_CACHE.window(
                base_key, base_seconds, start, end, fetch_range
            )
            return fold(base_bars, rule)
        base_bars = await CANDLE_CACHE.recent(
            base_key, base_seconds, base_count_for(rule, bars), fetch_recent
        )
        folded = fold(base_bars, rule)
        # Match the native path: only 404 when no window was requested at all (a
        # bad epic). A partial-window request (from_ts only) may legitimately be
        # empty and should return an empty 200, not a hard error.
        if not folded and from_ts is None:
            raise HTTPException(
                404, f"no data for epic '{epic}' (unknown epic or no history)"
            )
        return folded[-bars:]
    resolution = _parse_resolution(resolution)
    broker = get_data(broker_id)  # 404 on unknown broker (not a breaker failure)
    key = (broker_id, epic, resolution.value, price_side)
    res_seconds = resolution.seconds

    async def fetch_range(start_dt, end_dt):
        # Keep the circuit breaker around the actual broker call so one down broker
        # can't starve the others (see guarded()).
        return await guarded(
            broker_id,
            lambda: broker.get_candles(epic, resolution, start_dt, end_dt, price_side),
            "data fetch",
        )

    async def fetch_recent(n):
        return await guarded(
            broker_id,
            lambda: broker.get_recent_candles(epic, resolution, n, price_side),
            "data fetch",
        )

    if from_ts is not None and to_ts is not None:
        # Validate the window before hitting the cache/broker: an out-of-range epoch
        # would crash datetime.fromtimestamp (surfaced as a confusing 502), and an
        # inverted window would silently return an empty 200. Both are client
        # errors -> 422.
        if from_ts > to_ts:
            raise HTTPException(422, "from_ts must be <= to_ts")
        try:
            start = datetime.fromtimestamp(from_ts, tz=timezone.utc)
            end = datetime.fromtimestamp(to_ts, tz=timezone.utc)
        except (OverflowError, OSError, ValueError) as e:
            raise HTTPException(422, f"from_ts/to_ts out of range: {e}") from e
        loaded = await CANDLE_CACHE.window(key, res_seconds, start, end, fetch_range)
    else:
        loaded = await CANDLE_CACHE.recent(key, res_seconds, bars, fetch_recent)
    return loaded
