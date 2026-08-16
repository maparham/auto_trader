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
import os
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from typing import TypeVar

from fastapi import HTTPException, Query

from auto_trader.api.guard import COMPUTE_ONLY_ENV

from auto_trader.brokers.base import ExecutionBroker, MarketDataBroker
from auto_trader.brokers.capital_stream import SECONDS_INTERVALS
from auto_trader.brokers.ig import IGAllowanceExceeded, IGBroker
from auto_trader.brokers.paper_exec import PaperExecutionBroker
from auto_trader.brokers.registry import BrokerRegistry
from auto_trader.core.broker_health import (
    BrokerBlocked,
    BrokerHealth,
    BrokerReconnecting,
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


def default_broker_id() -> str:
    """The data broker a request that names none lands on (capital when
    registered, else the first registered broker — see default_data_id)."""
    assert _registry is not None, "registry not initialised"
    return _registry.default_data_id()


def broker_query(broker: str = Query("")) -> str:
    """The ?broker= param as a route dependency. Empty/absent resolves to the
    default registered broker, so a deployment without capital creds (where the
    old literal "capital" default would 404) still serves bare requests."""
    return broker or default_broker_id()


# Per-broker circuit breaker shared by every data-broker route. Keeps one down or
# slow broker from holding shared connection slots and starving the others — see
# auto_trader.core.broker_health.
# MT5/MetaApi fetches deep history slowly — a MetaApi characteristic, not a fault:
# ~500 daily bars (~2y) take 10-35s and ~500 weekly bars (~10y) take 30-45s, since
# latency scales with how far back the request reaches. So MT5 gets a much larger
# wall-clock budget than the default 8s. The cost is paid ONCE per symbol+resolution
# — the result populates the sqlite candle cache and every load after serves from it
# (incl. across restarts). Monthly/yearly are cheaper: they derive from the daily
# base series, which the cache bounds. Budget covers weekly's worst case (~45-70s
# through the server) with headroom; scoped to mt5 so a hang can't stall the others.
# Dukascopy downloads and decodes day tick files, so even a small cold minute-window
# fetch routinely exceeds 8s; like MT5 the cost is paid once and then the candle
# cache serves it.
BROKER_HEALTH = BrokerHealth(per_key_timeout={"mt5": 90.0, "dukascopy": 45.0, "oanor": 20.0, "nobitex": 30.0})

T = TypeVar("T")


def broker_blocked_http(label: str, e: BrokerBlocked) -> HTTPException:
    """The 503 for a network-path-blocked broker (WAF interstitial upstream).

    Shared by guarded() and the execution routes (which bypass the breaker).
    The X-Broker-Blocked marker header is the frontend's structural signal —
    no string matching on detail — and is exposed via CORS in app.py."""
    return HTTPException(
        503,
        f"{label}: blocked by your network (restricted internet connection) — {e}",
        headers={"X-Broker-Blocked": "1"},
    )


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
        # BrokerReconnecting is `ignore`d at the breaker: a broker self-healing a
        # wedged socket (only MT5 raises it, via its own rebuild path) is transient
        # and owns its recovery — it must not count toward tripping the SHARED
        # breaker, which would pin every other call for that broker into cooldown.
        # BrokerBlocked is `ignore`d too: the WAF interstitial answers instantly
        # (no held connection slot, so nothing for the breaker to protect), and
        # keeping it out of the breaker means every poll surfaces the specific
        # "your network is blocking the broker" 503 instead of degrading to the
        # generic BrokerUnavailable message once the breaker opens.
        return await BROKER_HEALTH.run(
            broker_id,
            factory,
            ignore=(IGAllowanceExceeded, BrokerReconnecting, BrokerBlocked),
        )
    except BrokerBlocked as e:
        raise broker_blocked_http(label, e) from e
    except IGAllowanceExceeded as e:
        raise HTTPException(
            429,
            "IG historical-data limit reached — resets weekly. "
            "Live prices still stream.",
        ) from e
    except BrokerReconnecting as e:
        raise HTTPException(
            503, f"{label}: broker '{broker_id}' reconnecting — retry shortly"
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


# How often the MT5 idle watchdog checks for a deployed-but-unused account to
# auto-undeploy (stops MetaApi hosting billing). Coarse: undeploy is a cost
# guard, not latency-sensitive.
_MT5_WATCHDOG_INTERVAL = 30.0


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


async def _mt5_idle_tick(broker) -> bool:
    """One watchdog check: undeploy the MT5 account if it is deployed and has
    been idle past its window. Returns True iff it undeployed. Never raises —
    a bad MetaApi call must not kill the watchdog."""
    try:
        if await broker.deploy_state() == "on" and broker.seconds_until_idle_undeploy() == 0:
            await broker.pause()
            log.info("mt5: auto-undeployed after idle timeout")
            return True
    except Exception:
        log.exception("mt5 idle watchdog tick failed")
    return False


async def _run_mt5_idle_watchdog(broker) -> None:
    """Periodically auto-undeploy an idle MT5 account so a forgotten deployment
    stops billing. The account is redeployed only by an explicit user action."""
    while True:
        await asyncio.sleep(_MT5_WATCHDOG_INTERVAL)
        await _mt5_idle_tick(broker)


def _parse_resolution(raw: str) -> Resolution:
    """Validate a native Capital resolution string (422 on anything else).

    Replaces FastAPI's automatic enum coercion, which we dropped so seconds
    intervals can be handled explicitly instead of 422-ing before the handler."""
    try:
        return Resolution(raw)
    except ValueError:
        raise HTTPException(422, f"unknown resolution '{raw}'") from None


def _reject_symbol_fetch_on_compute_host(epic: str, resolution: str) -> None:
    """A COMPUTE_ONLY host (the remote Fly compute node) must never source market
    data itself — every bar it needs is shipped in the request (base candles inline,
    higher timeframes in req.htfCandles). Reaching a symbol fetch at all means a bar
    was NOT shipped, so fail loudly here.

    This blocks BEFORE the candle cache, not just the broker call: the cache is never
    populated on a compute-only host, and its window() swallows a fetch exception when
    partial rows happen to exist (returning stale/incomplete bars) — which would let a
    sweep run on wrong higher-timeframe data instead of failing."""
    if os.environ.get(COMPUTE_ONLY_ENV) == "1":
        raise HTTPException(
            503,
            f"compute host has no shipped bars for {epic} {resolution} and must not "
            "source them itself; higher-timeframe bars must be provided in the request",
        )


async def _fetch_symbol_candles(
    broker_id: str,
    epic: str,
    resolution: str,
    bars: int,
    from_ts: int | None,
    to_ts: int | None,
    price_side: str,
    degraded: dict | None = None,
) -> list[Candle]:
    """Fetch raw candles for one epic against one broker: seconds (tick recorder),
    derived (folded from cached base series), or native (cache/broker). Raises the
    same HTTPExceptions as before for bad brokers/windows/IG-derived; does NOT
    raise the native-path "no data at all" 404 — that decision stays with the
    caller (a symbol's emptiness may or may not be fatal depending on context).

    `degraded` (optional out-param, see CandleCache.window): set when the broker
    fetch failed but the cache served bars anyway — the route turns it into the
    X-Candles-Degraded response header so clients can tell "possibly short cached
    data during an outage" apart from "this is all the data there is"."""
    # Resolve an unnamed broker BEFORE anything keys off broker_id (breaker,
    # candle cache, tick store) so an empty id never becomes a cache key.
    broker_id = broker_id or default_broker_id()
    _reject_symbol_fetch_on_compute_host(epic, resolution)
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
                base_key, base_seconds, start, end, fetch_range, degraded=degraded
            )
            return fold(base_bars, rule)
        base_bars = await CANDLE_CACHE.recent(
            base_key, base_seconds, base_count_for(rule, bars), fetch_recent,
            degraded=degraded,
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
        loaded = await CANDLE_CACHE.window(
            key, res_seconds, start, end, fetch_range, degraded=degraded
        )
    else:
        loaded = await CANDLE_CACHE.recent(
            key, res_seconds, bars, fetch_recent, degraded=degraded
        )
    return loaded
