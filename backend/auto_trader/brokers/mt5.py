"""MetaTrader 5 broker via the MetaApi cloud bridge (AvaTrade).

MetaApi (metaapi.cloud) hosts a real MT5 terminal logged into the user's AvaTrade
account and exposes it over a REST + websocket API, so this adapter needs no
Windows terminal of its own — it's a normal async API client, the same shape as
the Capital.com and IG adapters.

The account is registered once as the "mt5" data broker, carrying the in-app
paper simulator ("mt5:paper", fills priced off live MT5 quotes) and the
real-money dealing account ("mt5:live"). One shared `MT5Broker` holds the single
MetaApi connection; `MT5ExecutionBroker` wraps it for order routing.

Two conventions differ from the REST brokers and matter:
- `epic` IS the MT5 symbol verbatim ("EURUSD", "#NVIDIA") — no catalogue mapping.
- `quantity` is in LOTS (MT5's volume), not instrument units. 0.01 is the typical
  minimum; check `get_market_meta`'s volume step before sizing.

Unlike Capital/IG's stateless REST calls, MetaApi is a stateful connection: the
account must be DEPLOYED (running in MetaApi's cloud) and the client synchronizes
a terminal-state snapshot on connect. We connect lazily on first use and cache
the connection; `_ensure` is the single re-entrant gate.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING

from metaapi_cloud_sdk import MetaApi
from metaapi_cloud_sdk.clients.metaapi.trade_exception import TradeException
from metaapi_cloud_sdk.clients.timeout_exception import TimeoutException
from metaapi_cloud_sdk.logger import LoggerManager

from auto_trader.brokers._prices import pick_side
from auto_trader.brokers.base import ExecutionBroker, MarketDataBroker
from auto_trader.core.broker_health import BrokerReconnecting
from auto_trader.core.models import (
    Candle,
    Order,
    OrderResult,
    OrderStatus,
    OrderType,
    Position,
    Resolution,
    Side,
    WorkingOrder,
)

if TYPE_CHECKING:
    from auto_trader.brokers.registry import BrokerRegistry

log = logging.getLogger(__name__)

# Resolution -> MetaApi timeframe string. Every Resolution we support has a direct
# MetaApi equivalent (MetaApi also has 2m/10m/… we don't use).
_TIMEFRAME: dict[Resolution, str] = {
    Resolution.MINUTE: "1m",
    Resolution.MINUTE_5: "5m",
    Resolution.MINUTE_15: "15m",
    Resolution.MINUTE_30: "30m",
    Resolution.HOUR: "1h",
    Resolution.HOUR_4: "4h",
    Resolution.DAY: "1d",
    Resolution.WEEK: "1w",
}

# MetaApi caps readHistoricalCandles at 1000 bars/call; we page backward for wider
# ranges (see get_candles).
_MAX_CANDLES_PER_CALL = 1000
# Hard stop on backward paging so a bad range can't spin forever.
_MAX_PAGES = 40


def _quiet_sdk_logging() -> None:
    """Route the MetaApi SDK's own logging through Python's `logging` (it prints to
    stdout otherwise) and silence the transient `SubscriptionManager` subscribe
    timeouts it emits while the terminal state syncs. We trade via RPC, not market-
    data subscriptions, so those retries are cosmetic noise, not real failures."""
    LoggerManager.use_logging()
    logging.getLogger("SubscriptionManager").setLevel(logging.CRITICAL)


def _to_candle(c: dict) -> Candle:
    """MetaApi candle dict -> domain Candle. `time` is already tz-aware UTC (bar
    open time); tickVolume is the only volume MT5 exposes on candles."""
    return Candle(
        time=c["time"],
        open=c["open"],
        high=c["high"],
        low=c["low"],
        close=c["close"],
        volume=c.get("tickVolume", 0) or 0,
    )


# --- symbol-search categorisation -------------------------------------------
# MetaApi's get_symbols() returns bare symbol strings with no category metadata
# (unlike Capital's instrumentType), so the symbol-search modal's chips (Stocks/
# Forex/Crypto/Indices/Commodities) have nothing to filter on. We infer the
# category from AvaTrade's naming conventions. This is a best-effort classifier
# tuned to AvaTrade's actual symbol list; unrecognised symbols return None and
# stay browsable under "All" + free-text search rather than being mislabelled.

# ISO-4217 fiat codes AvaTrade quotes forex in. Deliberately excludes the metal
# codes (XAU/XAG/XPT/XPD) so "XAUUSD"-style symbols don't read as a forex pair.
_FIAT_CODES = frozenset(
    "USD EUR GBP JPY CHF CAD AUD NZD SEK NOK DKK SGD HKD MXN ZAR TRY PLN CZK "
    "HUF ILS RUB CNY CNH CLP".split()
)
# Crypto base tickers; a symbol whose alnum form starts with one (e.g. BTCUSD,
# MATICUSD, PEPEUSD) is crypto. "CRYPTO" also catches AvaTrade's CRYPTO10 basket.
_CRYPTO_BASES = (
    "BTC", "ETH", "LTC", "BCH", "XRP", "XLM", "DOGE", "SOL", "LINK", "UNI",
    "MATIC", "PEPE", "BTG", "ADA", "DOT", "AVAX", "TRX", "EOS", "DASH", "SHIB",
)
_METAL_CODES = ("XAU", "XAG", "XPT", "XPD")
# AvaTrade names commodities in words (GOLD, BRENT_OIL, NATURAL_GAS), not tickers.
_COMMODITY_KW = (
    "GOLD", "SILVER", "PLATINUM", "PALLADIUM", "COPPER", "ALUMINIUM", "ALUMINUM",
    "NICKEL", "OIL", "CRUDE", "BRENT", "GASOLINE", "GAS", "HEATING", "COCOA",
    "COFFEE", "CORN", "COTTON", "SOYBEAN", "SUGAR", "WHEAT",
)
_COMMODITY_EXACT = frozenset({"SI_FUTURE"})  # silver future, named off-pattern
# Region-benchmark indices (US_30, GERMANY_40, JAPAN_225) + AvaTrade's thematic
# baskets (FAANG, AIRLINES, AI_INDX), which it groups under indices.
_INDEX_KW = (
    "INDX", "INDEX", "FAANG", "AIRLINES", "GIANTS", "INTERNET", "VACCINE",
    "CANNABIS", "GREEN_ENERGY", "BATTERY", "STRATEGIC_METALS", "RACING",
)
_INDEX_REGION = (
    "US_", "UK_", "GERMANY", "FRANCE", "ITALY", "JAPAN", "AUS_", "HK_",
    "CHINA_", "EUROPE", "NED_", "SWISS", "TAIWAN", "CANADA", "SPAIN", "SPA_",
)


def _classify_symbol(sym: str) -> str | None:
    """AvaTrade MT5 symbol -> symbol-search category, matching the frontend chip
    types (SHARES/CURRENCIES/CRYPTOCURRENCIES/INDICES/COMMODITIES). None means
    "no chip" — the symbol still appears under All and in search. First match wins;
    order matters (bonds before indices so JAPAN_BOND isn't read as a JAPAN index;
    metals before forex so XAUUSD isn't read as a currency pair)."""
    if sym.startswith(("#", "_")):
        return "SHARES"  # AvaTrade prefixes equities with # (US) or _ (EU)
    s = sym.upper()
    if "BOND" in s or "BUND" in s:
        return None  # no bonds chip; keep out of the region-index bucket
    alnum = re.sub(r"[^A-Z0-9]", "", s)
    if "CRYPTO" in s or any(
        alnum.startswith(b) and len(alnum) > len(b) for b in _CRYPTO_BASES
    ):
        return "CRYPTOCURRENCIES"
    if (
        sym in _COMMODITY_EXACT
        or alnum[:3] in _METAL_CODES
        or any(kw in s for kw in _COMMODITY_KW)
    ):
        return "COMMODITIES"
    if any(kw in s for kw in _INDEX_KW) or s.startswith(_INDEX_REGION):
        return "INDICES"
    if len(alnum) == 6 and alnum[:3] in _FIAT_CODES and alnum[3:] in _FIAT_CODES:
        return "CURRENCIES"
    return None


def _pos_side(raw_type: str) -> Side:
    """MT5 position/order type string -> Side. Buys contain "_BUY"."""
    return Side.BUY if "BUY" in (raw_type or "").upper() else Side.SELL


# MetaApi account trade mode → the selector label's env suffix. CONTEST (and any
# future mode) is deliberately unmapped: better a bare broker name than a wrong tag.
_TRADE_MODE_ENV = {"ACCOUNT_TRADE_MODE_DEMO": "demo", "ACCOUNT_TRADE_MODE_REAL": "live"}


def _lvl(v: float | None) -> float | None:
    """MT5 reports absent stop/target as 0 (or None). Normalise both to None."""
    return v if v else None


def _mt5_expiration(expires_at: datetime | None) -> dict | None:
    """MetaApi PendingTradeOptions payload for a good-till-date, or None for GTC.
    Passes the datetime object through — the SDK serializes it to UTC ISO itself."""
    if expires_at is None:
        return None
    return {"expiration": {"type": "ORDER_TIME_SPECIFIED", "time": expires_at}}


def _as_utc(dt: datetime) -> datetime:
    """Coerce a naive datetime to UTC (MetaApi returns aware; be defensive)."""
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


def _order_is_gtc(current: dict) -> bool:
    """Whether a MetaApi order dict represents a Good-Till-Cancelled order."""
    etype = current.get("expirationType")
    etime = current.get("expirationTime")
    return etype == "ORDER_TIME_GTC" or (etime is None and etype in (None, "ORDER_TIME_GTC"))


def _order_original_expiration(current: dict) -> dict | None:
    """Reconstruct the PendingTradeOptions expiration payload from a MetaApi order
    dict's own expirationType/expirationTime — used to recreate the original order
    on a cancel-replace rollback. None for a GTC order."""
    etype = current.get("expirationType")
    etime = current.get("expirationTime")
    if not etype or etype == "ORDER_TIME_GTC" or etime is None:
        return None
    return {"expiration": {"type": etype, "time": etime}}


def _mt5_expiry_changes(
    current: dict, expires_at: datetime | None, clear_expiry: bool
) -> bool:
    """Whether a modify request would ALTER the order's expiration.

    MT5's ORDER_MODIFY cannot change expiration (MetaApi/MT5 protocol limitation,
    verified against the SDK, the trade-API docs, and a live account), so a real
    expiry change must be done by cancel-and-replace. A level-only edit (no expiry
    change) keeps the cheap in-place modify. `current` is the MetaApi order dict."""
    if clear_expiry:
        return not _order_is_gtc(current)  # clearing an already-GTC order is a no-op
    if expires_at is None:
        return False  # this edit carries no expiry → unchanged (carry-forward)
    cur_time = current.get("expirationTime")
    if cur_time is None:
        return True  # GTC → a specific expiry is a change
    return abs((_as_utc(expires_at) - _as_utc(cur_time)).total_seconds()) >= 1


class MT5Broker(MarketDataBroker):
    """Market data + the shared MetaApi connection(s) for one AvaTrade MT5 account.

    Holds the RPC connection the execution broker also trades through (reads +
    trades), plus a second streaming connection for the live tick feed (see
    _ensure_stream). supports_streaming is True: intraday, DAY and WEEK charts tick
    live via mt5_stream (WEEK phased to the broker's week-open), MONTH ticks via the
    router folding the live DAY stream, and MT5 paper limit/SL/TP orders fire off the
    same tick feed. Seconds and the wider derived timeframes (2W/3W/6W, 2M/3M, 1Y)
    are fatal-gated in the /ws/candles router and keep their REST history.
    """

    supports_streaming = True

    # Per-call wall-clock budget for an RPC read/trade. Short so a wedged socket
    # surfaces as "reconnecting" in seconds rather than hanging the SDK's 60s
    # request timeout. Candle history uses a SEPARATE account path
    # (get_historical_candles / historicalMarketDataRequestTimeout) and is not
    # bounded by this.
    RPC_BUDGET = 8.0

    # Minimum gap between background reconnect attempts, so a burst of polls during
    # an outage can't spawn a full-client rebuild every poll. Consecutive failed
    # rebuilds double the gap (capped) — a persistently-down broker must not spawn
    # a fresh MetaApi client every 5s; each attempt costs sockets + SDK tasks.
    RECONNECT_COOLDOWN = 5.0
    RECONNECT_BACKOFF_MAX = 300.0

    # Wall-clock bounds on tearing down a retired/wedged SDK client (see _reap_api)
    # and on closing connections at shutdown (see aclose). Shutdown MUST be bounded:
    # uvicorn --reload join()s the old process with no timeout while the parent
    # keeps the listening socket, so a hung close means every request — static
    # endpoints included — hangs until the process is killed by hand.
    REAP_BUDGET = 10.0
    CLOSE_BUDGET = 5.0

    def __init__(self, *, token: str, account_id: str, region: str = "london") -> None:
        self._token = token
        self._account_id = account_id
        self._region = region
        self._api: MetaApi | None = None
        self._acct = None
        self._conn = None
        self._synced = False
        self._lock = asyncio.Lock()
        # Wedge recovery. A long-lived MetaApi RPC socket can go half-open: every
        # request then hangs the full request timeout and never heals, because
        # flipping `_synced` only makes `_ensure` re-hand-out the SAME dead cached
        # connection. So RPC calls are bounded (RPC_BUDGET); two consecutive
        # timeouts escalate to a background full-client rebuild (see `_rebuild`),
        # and calls fast-fail as BrokerReconnecting while it runs. `_gen` makes the
        # rebuild single-flight — a stale rebuild task (older gen) is a no-op.
        self._state = "OK"  # "OK" | "RECONNECTING"
        self._gen = 0
        self._fail_streak = 0
        self._rebuild_fails = 0  # consecutive failed rebuilds — drives the backoff
        self._rebuild_task: asyncio.Task | None = None
        self._last_rebuild_at = float("-inf")
        # Streaming lives on a SECOND, stateful MetaApi connection alongside the RPC
        # one (they coexist — verified live). One shared connection multiplexes every
        # symbol; its listener fans ticks out to per-symbol consumer queues, and
        # subscriptions are ref-counted so N charts on one symbol share one upstream
        # subscribe. Lazily connected on first stream (see _ensure_stream).
        self._stream_conn = None
        self._stream_synced = False
        self._stream_lock = asyncio.Lock()
        self._tick_subs: dict[str, set[asyncio.Queue]] = {}
        self._sub_refcount: dict[str, int] = {}
        # Per-symbol MetaApi specification cache (contractSize/volumeStep/digits are
        # static), plus a set tracking which symbols we've already warned about
        # missing a contractSize, so the fallback warning fires at most once each.
        self._spec_cache: dict[str, dict] = {}
        self._warned_no_contract: set[str] = set()
        # One-shot background fetch of the account's real broker name for the
        # selector label (see start_display_name_fetch).
        self._label_task: asyncio.Task | None = None

    # --- connection -----------------------------------------------------------

    async def _ensure(self):
        """Connect + synchronize once, then reuse. Re-entrant: concurrent callers
        share one connect via the lock, and a healthy connection short-circuits
        before taking it."""
        if self._synced and self._conn is not None:
            return self._conn
        async with self._lock:
            if self._synced and self._conn is not None:
                return self._conn
            if self._api is None:
                _quiet_sdk_logging()
                # MetaApi spawns background asyncio tasks in __init__, so it must be
                # constructed inside a running loop (never at import time). The Python
                # SDK auto-discovers the account's hosting region — passing a `region`
                # option is explicitly discouraged (it triggers subscribe timeouts on
                # the wrong socket), so `_region` is retained for reference only.
                self._api = MetaApi(self._token)
            if self._acct is None:
                self._acct = await self._api.metatrader_account_api.get_account(self._account_id)
            # Account must be running in MetaApi's cloud; deploy if it isn't.
            if self._acct.state not in ("DEPLOYING", "DEPLOYED"):
                await self._acct.deploy()
            await self._acct.wait_connected()
            conn = self._acct.get_rpc_connection()
            await conn.connect()
            await conn.wait_synchronized(120)
            self._conn = conn
            self._synced = True
            log.info("mt5: connected + synchronized (account %s)", self._account_id)
            return conn

    async def _bounded(self, make_coro):
        """Run an RPC coroutine against the CACHED RPC connection, bounded to
        RPC_BUDGET. Crucially it never performs the SDK connect itself — that can
        block up to wait_synchronized's 120s — so a caller can never hang on it:

          * reconnect in flight  -> fast-fail (TimeoutException);
          * not synchronized     -> fast-fail AND kick a background reconnect (the
            unbounded connect lives only in `_rebuild`, off the request path);
          * synchronized         -> run the call under wait_for; a timeout feeds the
            consecutive-failure streak that escalates to a rebuild.

        Raises TimeoutException on any wedge so callers map it: reads surface
        reconnecting, trades fall to their UNKNOWN/reconcile path."""
        if self._state == "RECONNECTING":
            raise TimeoutException("mt5: reconnecting")
        if not self._synced or self._conn is None:
            self._trigger_rebuild_if_idle()
            raise TimeoutException("mt5: connecting")
        conn = self._conn
        gen = self._gen
        try:
            result = await asyncio.wait_for(make_coro(conn), self.RPC_BUDGET)
        except (asyncio.TimeoutError, TimeoutException) as exc:
            self._note_rpc_timeout(gen)
            raise TimeoutException("mt5: rpc timed out") from exc
        except asyncio.CancelledError:
            # A CancelledError raised from INSIDE the RPC — the SDK cancels its own
            # `_wait_connect_promises` future when the account connection drops
            # mid-call (observed live). That's a wedge, not a cancellation of us:
            # map it like a timeout so it surfaces as reconnecting (503, not a raw
            # 500) and feeds the streak that schedules a rebuild. But if OUR task is
            # the one being cancelled (shutdown, client disconnect), `cancelling()`
            # is > 0 — never swallow that; re-raise so cancellation propagates.
            task = asyncio.current_task()
            if task is not None and task.cancelling() > 0:
                raise
            self._note_rpc_timeout(gen)
            raise TimeoutException("mt5: rpc cancelled (connection dropped)")
        self._fail_streak = 0
        self._rebuild_fails = 0  # a working RPC proves the broker healed — reset backoff
        return result

    async def read(self, make_coro):
        """Run a read-only RPC bounded to RPC_BUDGET. A wedged/stale connection is
        surfaced as BrokerReconnecting instead of being left to hang; two
        consecutive timeouts trigger a background full-client rebuild. We do NOT
        retry inline — the frontend polls, so the next poll rides the healed
        connection. Never route a trade through here, only reads."""
        try:
            return await self._bounded(make_coro)
        except TimeoutException as exc:
            raise BrokerReconnecting("mt5") from exc

    # --- display name -----------------------------------------------------------

    def note_account_info(self, info: dict | None) -> None:
        """Cache the account's real broker name off a MetaApi account-information
        payload — `broker` verbatim (the registered name, e.g. "Ava Trade Ltd")
        plus a demo/live suffix from the trade mode, matching the selector's
        "Capital.com (demo)" style. Called opportunistically by every account-info
        read so the label heals itself even if the startup fetch missed."""
        name = (info or {}).get("broker")
        if not name:
            return
        env = _TRADE_MODE_ENV.get(info.get("type"))
        self.display_name = f"{name} ({env})" if env else name

    def start_display_name_fetch(self) -> None:
        """Kick the one-shot background fetch of the broker name, so the selector
        shows it even if the user never routes a read through this broker. Quiet
        and bounded: a down broker just leaves the frontend's fallback label. A
        no-op outside a running loop (unit tests construct brokers directly)."""
        try:
            self._label_task = asyncio.get_running_loop().create_task(self._fetch_display_name())
        except RuntimeError:
            pass

    async def _fetch_display_name(self) -> None:
        # `read` fast-fails while the connection is still coming up (and itself
        # triggers the connect), so poll until one read lands. ~5 minutes covers
        # a slow MetaApi deploy; past that, give up — summary reads still heal it.
        for _ in range(60):
            try:
                self.note_account_info(await self.read(lambda c: c.get_account_information()))
                return
            except Exception:
                await asyncio.sleep(5.0)

    def _note_rpc_timeout(self, gen: int) -> None:
        """Count a consecutive RPC timeout; on the second (a persistent wedge on a
        still-'synchronized' socket, not a one-off blip) kick off a single-flight
        background rebuild. The `gen` guard means a timeout observed against an
        already-superseded connection doesn't schedule a redundant rebuild."""
        self._fail_streak += 1
        if self._state == "OK" and self._fail_streak >= 2 and gen == self._gen:
            self._start_rebuild()

    def _rebuild_cooldown(self) -> float:
        """Current gap to respect between reconnect attempts: the base cooldown,
        doubled per consecutive failed rebuild, capped so recovery after a long
        outage is minutes away at worst."""
        return min(self.RECONNECT_COOLDOWN * (2 ** self._rebuild_fails), self.RECONNECT_BACKOFF_MAX)

    def _trigger_rebuild_if_idle(self) -> None:
        """Kick a background reconnect when disconnected (cold start, or a prior
        attempt that hasn't landed), unless one is already running or we tried
        too recently — so a burst of polls doesn't rebuild the client every poll,
        and a persistent outage backs off instead of churning out SDK clients."""
        if self._state == "OK" and (time.monotonic() - self._last_rebuild_at) >= self._rebuild_cooldown():
            self._start_rebuild()

    def _start_rebuild(self) -> None:
        self._last_rebuild_at = time.monotonic()
        self._state = "RECONNECTING"
        # Capture the connection this rebuild is meant to replace. A plain `_ensure`
        # from the streaming/candle paths can connect a fresh client concurrently
        # WITHOUT bumping `_gen`, so the rebuild also checks identity (below) to
        # avoid tearing down a connection that was replaced while it was queued.
        suspect = self._conn
        self._rebuild_task = asyncio.create_task(self._rebuild(self._gen, suspect))

    async def _rebuild(self, gen: int, suspect=None) -> None:
        """Force a genuine reconnect by recreating the whole MetaApi client — the
        in-process equivalent of a process restart, since `get_rpc_connection`
        otherwise re-hands-out the same cached, dead connection. The rebuilt client
        drops the shared websocket, so we also re-establish streaming and
        re-subscribe every live symbol. Single-flight via `_gen`.

        Lock discipline: everything that touches `_lock` is done and RELEASED before
        any streaming work, because `_ensure_stream` acquires `_stream_lock` then
        `_lock` — holding `_lock` across a `_stream_lock` acquisition would deadlock."""
        async with self._lock:
            if gen != self._gen or self._conn is not suspect:
                # A newer rebuild ran, OR a plain reconnect already replaced the
                # connection this one targeted — don't tear the fresh client down.
                return
            self._gen += 1
            old_api = self._api
            self._api = None
            self._acct = None
            self._conn = None
            self._synced = False
            self._stream_conn = None
            self._stream_synced = False
            symbols = list(self._tick_subs.keys())
        # _lock released — safe to reconnect streaming (which locks _stream_lock -> _lock).
        if old_api is not None:
            await self._reap_api(old_api)
        try:
            await self._ensure()  # fresh RPC connection over a fresh socket
            if symbols:
                await self._ensure_stream()
                for sym in symbols:
                    try:
                        await self._stream_conn.subscribe_to_market_data(
                            sym, [{"type": "quotes"}]
                        )
                    except Exception:
                        log.warning(
                            "mt5: re-subscribe failed for %s after reconnect",
                            sym,
                            exc_info=True,
                        )
            log.info("mt5: reconnected after wedge (account %s)", self._account_id)
            self._rebuild_fails = 0
        except Exception:
            self._rebuild_fails += 1
            log.warning(
                "mt5: reconnect attempt %d failed; next retry in >= %.0fs",
                self._rebuild_fails,
                self._rebuild_cooldown(),
                exc_info=True,
            )
        finally:
            self._fail_streak = 0
            self._state = "OK"

    async def _reap_api(self, api) -> None:
        """Fully tear down a retired MetaApi client, bounded. The SDK's own
        `close()` is fire-and-forget: it spawns `ws.close()` as an orphan task that
        never resolves over a wedged socket (`socket.disconnect()` hangs), and it
        leaks the per-socket synchronization-throttler interval tasks and engineio's
        ping/read/write loops — whose ping loop swallows CancelledError while its
        state is 'connected' (verified against metaapi_cloud_sdk 29.1.1 / that
        repeated rebuilds leak ~6 tasks each). Those survivors outlive asyncio.run's
        shutdown cancellation and wedge uvicorn --reload's old process forever, which
        hangs EVERY request because the reload parent keeps the listening socket.
        So: bounded await of the websocket close (wait_for cancels it on timeout),
        then force-kill the stragglers by hand."""
        ws = getattr(api, "_metaapi_websocket_client", None)
        if ws is None:  # not a real SDK client (tests/fakes) — its close() is enough
            try:
                api.close()
            except Exception:
                log.debug("mt5: error closing wedged client", exc_info=True)
            return
        # Snapshot the socket instances BEFORE closing: ws.close() empties the
        # per-region instance lists, so a post-close walk would tear down nothing
        # (which is how the throttler-interval leak survived a first fix attempt).
        try:
            instances_snapshot = [
                instance
                for instances_by_number in (ws._socket_instances or {}).values()
                for instances in instances_by_number.values()
                for instance in instances
            ]
        except Exception:
            instances_snapshot = []
        try:
            await asyncio.wait_for(ws.close(), self.REAP_BUDGET)
        except Exception:
            log.debug("mt5: bounded sdk ws close failed/timed out", exc_info=True)
        try:
            for timer in getattr(ws, "_status_timers", {}).values():
                timer.cancel()  # 60s zombie timers for hosts that no longer exist
            for instance in instances_snapshot:
                throttler = instance.get("synchronizationThrottler")
                if throttler is not None:
                    throttler.stop()
                eio = getattr(instance.get("socket"), "eio", None)
                if eio is None:
                    continue
                # The ping loop ignores cancellation while state is
                # 'connected' — flip the state FIRST so the cancel lands.
                eio.state = "disconnected"
                for name in ("ping_loop_task", "read_loop_task", "write_loop_task"):
                    task = getattr(eio, name, None)
                    if task is not None and not task.done():
                        task.cancel()
        except Exception:
            log.debug("mt5: force-teardown of sdk socket tasks failed", exc_info=True)
        # The sync tail of MetaApi.close(), minus its create_task(ws.close()) —
        # that orphan re-close is exactly the hang we just avoided.
        for stop in (
            lambda: ws.stop(),
            lambda: api._terminal_hash_manager._stop(),
        ):
            try:
                stop()
            except Exception:
                log.debug("mt5: error stopping sdk jobs", exc_info=True)

    # --- streaming connection -------------------------------------------------

    async def _ensure_stream(self):
        """Connect + synchronize the shared streaming connection once, then reuse.
        Re-entrant like `_ensure`. The single `_TickListener` is attached on first
        connect and lives for the connection's lifetime; per-symbol subscriptions
        are layered on by register_tick_queue."""
        if self._stream_synced and self._stream_conn is not None:
            return self._stream_conn
        async with self._stream_lock:
            if self._stream_synced and self._stream_conn is not None:
                return self._stream_conn
            await self._ensure()  # ensures the account is deployed + self._acct set
            from auto_trader.brokers.mt5_stream import _TickListener

            conn = self._acct.get_streaming_connection()
            conn.add_synchronization_listener(_TickListener(self._tick_subs))
            await conn.connect()
            await conn.wait_synchronized({"timeoutInSeconds": 120})
            self._stream_conn = conn
            self._stream_synced = True
            log.info("mt5: streaming connection synchronized (account %s)", self._account_id)
            return conn

    async def register_tick_queue(self, symbol: str) -> asyncio.Queue:
        """Register a consumer queue for `symbol`'s ticks; returns the queue. The
        FIRST consumer of a symbol subscribes it upstream (ref-counted), so N charts
        on one symbol share a single MetaApi subscription."""
        q: asyncio.Queue = asyncio.Queue()
        async with self._stream_lock:
            first = not self._tick_subs.get(symbol)
            self._tick_subs.setdefault(symbol, set()).add(q)
            self._sub_refcount[symbol] = self._sub_refcount.get(symbol, 0) + 1
            if first:
                try:
                    await self._stream_conn.subscribe_to_market_data(symbol, [{"type": "quotes"}])
                except BaseException:
                    # A failed subscribe (unknown epic) OR a CancelledError (the client
                    # disconnected while this first subscribe was in flight) must leave
                    # no orphan registration/refcount. CancelledError is a BaseException,
                    # so a plain `except Exception` would miss it — leaving a dead queue
                    # + refcount 1 that permanently blocks re-subscribing this symbol
                    # (first=False forever → the symbol silently never ticks again).
                    self._tick_subs.pop(symbol, None)
                    self._sub_refcount.pop(symbol, None)
                    raise
        return q

    async def unregister_tick_queue(self, symbol: str, q: asyncio.Queue) -> None:
        """Drop a consumer queue; the LAST consumer of a symbol unsubscribes it
        upstream. Never closes the shared connection."""
        async with self._stream_lock:
            subs = self._tick_subs.get(symbol)
            if subs:
                subs.discard(q)
            self._sub_refcount[symbol] = max(0, self._sub_refcount.get(symbol, 0) - 1)
            if self._sub_refcount[symbol] == 0:
                self._sub_refcount.pop(symbol, None)
                self._tick_subs.pop(symbol, None)
                if self._stream_conn is not None:
                    try:
                        await self._stream_conn.unsubscribe_from_market_data(
                            symbol, [{"type": "quotes"}]
                        )
                    except Exception:  # best-effort; a failed unsubscribe is harmless
                        log.debug("mt5: unsubscribe failed for %s", symbol, exc_info=True)

    async def aclose(self) -> None:
        """Close both connections on shutdown, BOUNDED. The account is left DEPLOYED —
        tearing it down would stop live trading and re-deploying is slow + costs a
        deploy charge; deployment is managed in the MetaApi dashboard, not per
        process. Bounded because lifespan shutdown awaits this: a close that hangs
        on a wedged socket would hang uvicorn --reload's process swap and with it
        every request. The client is then reaped so no cancellation-immune SDK task
        survives into asyncio.run's shutdown."""
        if self._label_task is not None:
            self._label_task.cancel()
            self._label_task = None
        conn, self._conn, self._synced = self._conn, None, False
        stream, self._stream_conn, self._stream_synced = self._stream_conn, None, False
        for c in (conn, stream):
            if c is not None:
                try:
                    await asyncio.wait_for(c.close(), self.CLOSE_BUDGET)
                except Exception:  # best-effort on shutdown
                    log.debug("mt5: error closing connection", exc_info=True)
        api, self._api, self._acct = self._api, None, None
        if api is not None:
            await self._reap_api(api)

    # --- candles --------------------------------------------------------------

    async def get_candles(
        self,
        epic: str,
        resolution: Resolution,
        start: datetime,
        end: datetime,
        price_side: str = "mid",
    ) -> list[Candle]:
        """Candles in [start, end], ascending. Pages backward from `end` (MetaApi
        returns ≤1000 bars up to and including the anchor time).

        MetaApi returns the current, still-forming bar as the last element; we pass
        it through (matching Capital/IG). The candle cache stores closed bars only
        but forwards the broker's forming bar so the chart shows today's live candle
        — dropping it here made today's DAY/WEEK bar go missing on MT5 charts.

        MT5 candles are a single series (no separate bid/ask history like Capital),
        so `price_side` is accepted for interface parity but not applied — AvaTrade
        candles are bid-based.
        """
        await self._ensure()
        tf = _TIMEFRAME[resolution]
        by_time: dict[datetime, Candle] = {}
        anchor = end
        for _ in range(_MAX_PAGES):
            batch = await self._acct.get_historical_candles(epic, tf, anchor, _MAX_CANDLES_PER_CALL)
            if not batch:
                break
            for raw in batch:
                c = _to_candle(raw)
                if start <= c.time <= end:
                    by_time[c.time] = c
            oldest = batch[0]["time"]
            if oldest <= start or len(batch) < _MAX_CANDLES_PER_CALL:
                break
            anchor = oldest - timedelta(seconds=1)  # step strictly before this page
        return sorted(by_time.values(), key=lambda c: c.time)

    async def get_recent_candles(
        self,
        epic: str,
        resolution: Resolution,
        count: int,
        price_side: str = "mid",
    ) -> list[Candle]:
        """Most recent `count` candles regardless of date (robust when the market
        is shut). MetaApi returns the current, still-forming bar as the last element;
        we keep it (matching Capital/IG) so the candle cache can forward today's live
        bar to the chart — the cache itself stores closed bars only."""
        await self._ensure()
        tf = _TIMEFRAME[resolution]
        batch = await self._acct.get_historical_candles(epic, tf, None, count)
        candles = sorted((_to_candle(r) for r in batch), key=lambda c: c.time)
        return candles[-count:]

    async def get_forming_candle(
        self, epic: str, resolution: Resolution, price_side: str = "mid"
    ) -> Candle | None:
        """The CURRENT, still-forming bar for `epic` — MetaApi returns it as the last
        historical element. `get_recent_candles`/`get_candles` also return it (last
        element), but there the candle cache stores it or not by bucket; this method
        fetches JUST that forming bar so the live stream can seed its forming bar from
        it — carrying the in-progress bucket's real OHLCV from frame one instead of
        cold-starting the open at the first tick. None if unavailable. `price_side` is
        accepted for interface parity but not applied (MT5 candles are bid-based)."""
        await self._ensure()
        tf = _TIMEFRAME[resolution]
        try:
            batch = await self._acct.get_historical_candles(epic, tf, None, 1)
        except Exception:
            log.debug("mt5: get_forming_candle failed for %s", epic, exc_info=True)
            return None
        return _to_candle(batch[-1]) if batch else None

    async def get_quote(self, epic: str) -> tuple[float | None, float | None]:
        """Latest (bid, ask), or (None, None) if the symbol has no live price."""
        try:
            price = await self.read(lambda c: c.get_symbol_price(epic))
            return (price.get("bid"), price.get("ask"))
        except Exception:
            log.debug("mt5: get_quote failed for %s", epic, exc_info=True)
            return (None, None)

    # --- catalogue ------------------------------------------------------------

    async def all_markets(self) -> list[dict]:
        """Full MT5 symbol list, each tagged with a symbol-search category inferred
        from AvaTrade's naming (see _classify_symbol) so the modal's Stocks/Forex/
        Crypto/Indices/Commodities chips filter correctly."""
        try:
            conn = await self._ensure()
            syms = await conn.get_symbols()
        except Exception:
            log.debug("mt5: get_symbols failed", exc_info=True)
            return []
        return [
            {
                "epic": s,
                "name": s.lstrip("#_"),
                "status": "TRADEABLE",
                "type": _classify_symbol(s),
            }
            for s in syms
        ]

    async def search_markets(self, query: str, limit: int = 20) -> list[dict]:
        q = (query or "").upper()
        markets = await self.all_markets()
        hits = [m for m in markets if q in m["epic"].upper()]
        return hits[:limit]

    # --- lots <-> units -------------------------------------------------------
    # MT5 speaks LOTS; the rest of the app works in instrument units. This broker
    # converts at its boundary — reads multiply by contractSize (lots→units),
    # writes divide (units→lots, which MetaApi requires). contractSize comes from
    # the symbol specification and is static, so it's cached per symbol.

    async def _get_spec(self, symbol: str) -> dict | None:
        """The MetaApi symbol specification, cached per symbol. Returns None on a
        failed lookup (not cached, so a transient failure can be retried)."""
        cached = self._spec_cache.get(symbol)
        if cached is not None:
            return cached
        try:
            conn = await self._ensure()
            spec = await conn.get_symbol_specification(symbol)
        except Exception:
            log.debug("mt5: get_symbol_specification failed for %s", symbol, exc_info=True)
            return None
        if spec:
            self._spec_cache[symbol] = spec
        return spec

    async def _contract_size(self, symbol: str) -> float:
        """Units per lot for `symbol`. Falls back to 1.0 (a no-op multiplier, i.e.
        today's lots-as-units behaviour) with a one-time warning if the spec has no
        usable contractSize — never raises, so a bad spec degrades gracefully."""
        spec = await self._get_spec(symbol)
        cs = (spec or {}).get("contractSize")
        if not cs:  # None or 0
            if symbol not in self._warned_no_contract:
                self._warned_no_contract.add(symbol)
                log.warning(
                    "mt5: no contractSize for %s; treating quantity as units (lots=units)",
                    symbol,
                )
            return 1.0
        return float(cs)

    async def _units_to_lots(self, symbol: str, units: float) -> float:
        """Convert an instrument-unit quantity to MT5 lots for submission, snapped
        to the symbol's volumeStep so float division can't leave sub-step dust."""
        cs = await self._contract_size(symbol)
        lots = units / cs
        step = (await self._get_spec(symbol) or {}).get("volumeStep")
        if step:
            lots = round(lots / step) * step
        return round(lots, 8)  # kill floating-point dust regardless of step

    async def get_market_meta(self, epic: str) -> dict | None:
        """Display precision (decimal digits), order-sizing bounds, and contract
        size for one symbol. minVolume/volumeStep are returned in instrument UNITS
        (× contractSize) so the whole meta object is consistent with the rest of
        the app, which works in units."""
        spec = await self._get_spec(epic)
        if not spec:
            return None
        cs = spec.get("contractSize") or 1.0
        min_vol = spec.get("minVolume")
        step = spec.get("volumeStep")
        return {
            "epic": epic,
            "precision": spec.get("digits"),
            "minVolume": (min_vol * cs) if min_vol is not None else None,
            "volumeStep": (step * cs) if step is not None else None,
            "contractSize": cs,
            "status": "TRADEABLE",
        }

    async def _calc_margin(self, epic: str, volume_lots: float, price: float) -> float | None:
        """Margin (in ACCOUNT currency) required to open a 1-lot buy, via MetaApi's
        calculateMargin. This applies the account's real per-symbol margin rules —
        so it reflects AvaTrade's per-instrument leverage cap, not the raw account
        coefficient. Uses the RPC application path (our connection is RPC, not
        streaming), reaching the websocket client through the connection since the
        SDK only exposes calculate_margin on the streaming wrapper. Best-effort:
        None on any failure, so the caller degrades to "no leverage shown"."""
        conn = await self._ensure()
        ws = getattr(conn, "_websocket_client", None)
        acct = self._acct
        if ws is None or acct is None:
            return None
        order = {
            "symbol": epic,
            "type": "ORDER_TYPE_BUY",
            "volume": volume_lots,
            "openPrice": price,
        }
        try:
            res = await ws.calculate_margin(
                acct.id, "RPC", getattr(acct, "reliability", "regular"), order
            )
        except Exception:
            log.debug("mt5: calculate_margin failed for %s", epic, exc_info=True)
            return None
        margin = res.get("margin") if isinstance(res, dict) else None
        return margin if isinstance(margin, (int, float)) and margin > 0 else None

    async def _effective_leverage(self, epic: str, spec: dict, price: dict) -> float | None:
        """True per-instrument leverage = 1-lot notional ÷ required margin, both in
        ACCOUNT currency. The notional is taken from `profitTickValue` (the money
        value of one tick of one lot, already denominated in the account currency by
        MetaApi) — notional = price × profitTickValue / tickSize — which sidesteps
        any cross-currency FX conversion (a EUR account gets 30 for EURUSD, 20 for
        the DAX, 2 for BTC). None when inputs are missing or the margin call fails."""
        ask = price.get("ask")
        tick_size = spec.get("tickSize")
        tick_value = price.get("profitTickValue")
        if not ask or not tick_size or not tick_value:
            return None
        margin = await self._calc_margin(epic, 1.0, ask)
        if not margin:
            return None
        notional_acct = ask * tick_value / tick_size
        lev = notional_acct / margin
        return round(lev) if lev > 0 else None

    async def get_market_detail(self, epic: str) -> dict | None:
        """Instrument detail for the legend ⓘ popover. MT5 has no single "market
        details" call like Capital's, so we build the three sections the popover
        reads from the MetaApi symbol specification plus a live quote. The full raw
        spec is passed through under `instrument` so "All details" hides nothing;
        a handful of fields are surfaced under the keys the curated header reads
        (currency, type, snapshot bid/offer, min/max size, leverage). None if the
        symbol is unknown."""
        spec = await self._get_spec(epic)
        if not spec:
            return None
        cs = spec.get("contractSize") or 1.0

        # Raw spec verbatim + the curated aliases the popover header looks for.
        instrument = dict(spec)
        instrument["epic"] = epic
        instrument["name"] = spec.get("description") or epic.lstrip("#_")
        instrument["type"] = _classify_symbol(epic)
        if spec.get("profitCurrency"):  # currency price/PnL is denominated in
            instrument["currency"] = spec["profitCurrency"]

        # Full price dict (not just bid/ask) — the leverage calc also needs
        # profitTickValue, which get_quote drops.
        try:
            price = await self.read(lambda c: c.get_symbol_price(epic)) or {}
        except Exception:
            log.debug("mt5: get_symbol_price failed for %s", epic, exc_info=True)
            price = {}
        bid, ask = price.get("bid"), price.get("ask")
        snapshot: dict = {}
        if bid is not None:
            snapshot["bid"] = bid
        if ask is not None:
            snapshot["offer"] = ask
        if spec.get("digits") is not None:
            snapshot["decimalPlacesFactor"] = spec["digits"]

        # Sizing bounds in instrument UNITS (× contractSize), matching get_market_meta.
        dealing: dict = {}
        for out_key, spec_key in (
            ("minDealSize", "minVolume"),
            ("maxDealSize", "maxVolume"),
            ("dealSizeStep", "volumeStep"),
        ):
            v = spec.get(spec_key)
            if v is not None:
                dealing[out_key] = {"value": round(v * cs, 8), "unit": "units"}

        out = {"instrument": instrument, "dealingRules": dealing, "snapshot": snapshot}
        # accountLeverage drives BOTH the popover's Leverage ("X:1") and Margin
        # ("Y%") rows — the same field Capital populates from its per-asset-class
        # setting. Here it's the true effective leverage from calculateMargin.
        lev = await self._effective_leverage(epic, spec, price)
        if lev:
            out["accountLeverage"] = lev
        return out


class MT5ExecutionBroker(ExecutionBroker):
    """Real-money dealing on the AvaTrade MT5 account, trading through the shared
    MT5Broker connection.

    place_order is idempotent on `client_order_id` via a process-local ledger (the
    same posture as the Capital/IG dealing executors). A submission that raises a
    MetaApi TradeException is a business rejection → REJECTED; any other exception
    means we don't know if it landed → UNKNOWN, and the caller must reconcile via
    get_positions rather than blindly retry.
    """

    def __init__(self, data: MT5Broker) -> None:
        self._data = data
        self._ledger: dict[str, OrderResult] = {}
        self._lock = asyncio.Lock()

    @property
    def env(self) -> str:
        return "live"

    @property
    def is_real_money(self) -> bool:
        return True

    async def aclose(self) -> None:  # connection is owned + closed by the data broker
        return None

    async def quote(self, epic: str) -> dict[str, float | None]:
        """bid/ask/mid for the order ticket, from the shared MT5 data connection.
        Goes through the data broker's wedge-safe read path, so a wedge yields
        (None, None) rather than hanging the ticket. Mirrors
        CapitalExecutionBroker.quote."""
        bid, ask = await self._data.get_quote(epic)
        return {"bid": bid, "ask": ask, "mid": pick_side(bid, ask, "mid")}

    # --- helpers --------------------------------------------------------------

    def _fail(self, client_order_id: str, exc: Exception) -> OrderResult:
        """Map an exception from a trade call to REJECTED (known business error)
        vs UNKNOWN (submission raised; fill state unknown)."""
        if isinstance(exc, TradeException):
            return OrderResult(
                client_order_id=client_order_id,
                status=OrderStatus.REJECTED,
                reason=f"{exc.stringCode}: {exc}",
                resolved_at=datetime.now(timezone.utc),
            )
        log.warning("mt5: trade submission raised (state unknown)", exc_info=True)
        # A TimeoutException here already fed the wedge detector inside `_bounded`
        # (which owns reconnection). We must NOT drop `_synced` — doing so would send
        # the very next read into the unbounded SDK connect and hang the poll. And we
        # do NOT retry the trade: an UNKNOWN must be reconciled via get_positions,
        # never blindly re-sent.
        return OrderResult(
            client_order_id=client_order_id,
            status=OrderStatus.UNKNOWN,
            reason=str(exc),
            resolved_at=datetime.now(timezone.utc),
        )

    async def _fill_price(self, position_id) -> float | None:
        """Open level of the just-filled position, or None if it can't be read
        (never fail a confirmed fill just because the price lookup didn't land).
        Goes through the bounded read path, so a wedge just yields None, never a
        hang."""
        if position_id is None:
            return None
        try:
            for p in await self._data.read(lambda c: c.get_positions()):
                if str(p.get("id")) == str(position_id):
                    return p.get("openPrice")
        except Exception:
            log.debug("mt5: fill-price lookup failed for %s", position_id, exc_info=True)
        return None

    # --- orders ---------------------------------------------------------------

    async def place_order(self, order: Order) -> OrderResult:
        async with self._lock:
            prior = self._ledger.get(order.client_order_id)
        if prior is not None:  # idempotent retry: return the recorded outcome
            return prior

        sl = order.stop_level
        tp = order.take_profit_level
        # order.quantity is in instrument units (the app's convention); MetaApi
        # deals in lots. Convert once here; filled_quantity is reported in units.
        lots = await self._data._units_to_lots(order.epic, order.quantity)
        submitted_at = datetime.now(timezone.utc)
        try:
            if order.type is OrderType.MARKET:
                if order.side is Side.BUY:
                    resp = await self._data._bounded(
                        lambda c: c.create_market_buy_order(order.epic, lots, sl, tp)
                    )
                else:
                    resp = await self._data._bounded(
                        lambda c: c.create_market_sell_order(order.epic, lots, sl, tp)
                    )
                # A market order fills into a position immediately. The trade
                # response carries no fill price, so read it back off the position
                # (matching Capital/IG, which surface the fill level) — best-effort.
                position_id = resp.get("positionId")
                # Read the fill level back (best-effort, bounded — never blocks).
                fill_price = await self._fill_price(position_id)
                result = OrderResult(
                    client_order_id=order.client_order_id,
                    status=OrderStatus.FILLED,
                    deal_reference=resp.get("orderId"),
                    deal_id=position_id,
                    filled_quantity=order.quantity,
                    fill_price=fill_price,
                    reason=resp.get("stringCode", ""),
                    submitted_at=submitted_at,
                    resolved_at=datetime.now(timezone.utc),
                )
            else:  # LIMIT — rests until the market reaches limit_level
                if order.limit_level is None:
                    return OrderResult(
                        client_order_id=order.client_order_id,
                        status=OrderStatus.REJECTED,
                        reason="limit order requires limit_level",
                        resolved_at=datetime.now(timezone.utc),
                    )
                opts = _mt5_expiration(order.expires_at)
                if order.side is Side.BUY:
                    resp = await self._data._bounded(
                        lambda c: c.create_limit_buy_order(
                            order.epic, lots, order.limit_level, sl, tp,
                            *((opts,) if opts else ()),
                        )
                    )
                else:
                    resp = await self._data._bounded(
                        lambda c: c.create_limit_sell_order(
                            order.epic, lots, order.limit_level, sl, tp,
                            *((opts,) if opts else ()),
                        )
                    )
                result = OrderResult(
                    client_order_id=order.client_order_id,
                    status=OrderStatus.PENDING,
                    deal_reference=resp.get("orderId"),
                    deal_id=resp.get("orderId"),  # working order id
                    submitted_at=submitted_at,
                    resolved_at=datetime.now(timezone.utc),
                )
        except Exception as exc:
            result = self._fail(order.client_order_id, exc)
            result.submitted_at = submitted_at

        async with self._lock:
            self._ledger[order.client_order_id] = result
        return result

    async def get_account_summary(self) -> dict:
        """Real account figures for the dock's account strip, read from MetaApi's
        terminal state (never the paper defaults). MT5 `balance` EXCLUDES floating
        P&L (equity includes it), matching the cash-balance convention the dock's
        `liveBalanceInclPnl=false` path expects. We also pass `equity` and `margin`
        through verbatim so the dock uses MT5's own margin/margin-level rather than
        re-deriving them (which would drift by swap/commission)."""
        info = await self._data.read(lambda c: c.get_account_information())
        self._data.note_account_info(info)  # keeps the selector's broker label fresh
        balance = info.get("balance")
        equity = info.get("equity")
        pnl = equity - balance if (equity is not None and balance is not None) else None
        return {
            "balance": balance,
            "available": info.get("freeMargin"),
            "profitLoss": pnl,
            "currency": info.get("currency"),
            "equity": equity,
            "margin": info.get("margin"),
        }

    async def get_positions(self, epic: str | None = None) -> list[Position]:
        raw = await self._data.read(lambda c: c.get_positions())
        out: list[Position] = []
        for p in raw:
            symbol = p.get("symbol")
            if epic is not None and symbol != epic:
                continue
            cs = await self._data._contract_size(symbol)
            out.append(
                Position(
                    epic=symbol,
                    side=_pos_side(p.get("type", "")),
                    quantity=(p.get("volume", 0.0) or 0.0) * cs,  # lots → units
                    open_level=p.get("openPrice"),
                    deal_id=str(p.get("id")),
                    stop_level=_lvl(p.get("stopLoss")),
                    take_profit_level=_lvl(p.get("takeProfit")),
                    upnl=p.get("profit"),
                    created_at=p.get("time"),
                )
            )
        return out

    async def close_position(self, deal_id: str, quantity: float | None = None) -> OrderResult:
        try:
            if quantity is None:
                resp = await self._data._bounded(lambda c: c.close_position(deal_id))
            else:
                # quantity is in units; MetaApi's partial close wants lots. Look up
                # the position's symbol to get the contractSize (close_position has
                # only the deal_id). If the position can't be found, fall back to
                # passing the value through (×1) rather than guessing.
                positions = await self._data.read(lambda c: c.get_positions())
                current = {str(p.get("id")): p for p in positions}.get(str(deal_id))
                symbol = current.get("symbol") if current else None
                lots = (
                    await self._data._units_to_lots(symbol, quantity)
                    if symbol
                    else quantity
                )
                resp = await self._data._bounded(
                    lambda c: c.close_position_partially(deal_id, lots)
                )
        except Exception as exc:
            return self._fail(f"close-{deal_id}", exc)
        return OrderResult(
            client_order_id=f"close-{deal_id}",
            status=OrderStatus.FILLED,
            deal_id=deal_id,
            deal_reference=resp.get("orderId"),
            filled_quantity=quantity or 0.0,
            reason=resp.get("stringCode", ""),
            resolved_at=datetime.now(timezone.utc),
        )

    async def modify_position(
        self,
        deal_id: str,
        *,
        stop_level: float | None = None,
        take_profit_level: float | None = None,
        clear_stop: bool = False,
        clear_take_profit: bool = False,
    ) -> OrderResult:
        # MT5 modify replaces BOTH levels, so fetch the current position and carry
        # the untouched one forward; 0 removes a level. The pre-fetch goes through
        # read() so a dropped connection self-heals like every other read.
        positions = await self._data.read(lambda c: c.get_positions())
        current = {str(p.get("id")): p for p in positions}.get(str(deal_id))
        cur_sl = current.get("stopLoss") if current else None
        cur_tp = current.get("takeProfit") if current else None
        new_sl = 0 if clear_stop else (stop_level if stop_level is not None else cur_sl)
        new_tp = 0 if clear_take_profit else (take_profit_level if take_profit_level is not None else cur_tp)
        try:
            resp = await self._data._bounded(
                lambda c: c.modify_position(deal_id, new_sl, new_tp)
            )
        except Exception as exc:
            return self._fail(f"modify-{deal_id}", exc)
        return OrderResult(
            client_order_id=f"modify-{deal_id}",
            status=OrderStatus.FILLED,
            deal_id=deal_id,
            reason=resp.get("stringCode", ""),
            resolved_at=datetime.now(timezone.utc),
        )

    async def get_working_orders(self, epic: str | None = None) -> list[WorkingOrder]:
        raw = await self._data.read(lambda c: c.get_orders())
        out: list[WorkingOrder] = []
        for o in raw:
            symbol = o.get("symbol")
            if epic is not None and symbol != epic:
                continue
            cs = await self._data._contract_size(symbol)
            out.append(
                WorkingOrder(
                    epic=symbol,
                    side=_pos_side(o.get("type", "")),
                    quantity=(o.get("volume", o.get("currentVolume", 0.0)) or 0.0) * cs,
                    limit_level=o.get("openPrice"),
                    order_id=str(o.get("id")),
                    stop_level=_lvl(o.get("stopLoss")),
                    take_profit_level=_lvl(o.get("takeProfit")),
                    created_at=o.get("time"),
                    expires_at=o.get("expirationTime"),
                )
            )
        return out

    async def modify_working_order(
        self,
        order_id: str,
        *,
        limit_level: float | None = None,
        stop_level: float | None = None,
        take_profit_level: float | None = None,
        clear_stop: bool = False,
        clear_take_profit: bool = False,
        expires_at: datetime | None = None,
        clear_expiry: bool = False,
    ) -> OrderResult:
        orders = await self._data.read(lambda c: c.get_orders())
        current = {str(o.get("id")): o for o in orders}.get(str(order_id))
        if current is None:
            return OrderResult(
                client_order_id=f"modify-{order_id}",
                status=OrderStatus.REJECTED,
                reason="working order not found",
                resolved_at=datetime.now(timezone.utc),
            )
        new_price = limit_level if limit_level is not None else current.get("openPrice")
        cur_sl = current.get("stopLoss")
        cur_tp = current.get("takeProfit")
        new_sl = 0 if clear_stop else (stop_level if stop_level is not None else cur_sl)
        new_tp = 0 if clear_take_profit else (take_profit_level if take_profit_level is not None else cur_tp)

        # MT5's ORDER_MODIFY cannot change a pending order's expiration (MetaApi/MT5
        # protocol limitation — verified against the SDK, the trade-API docs, and a
        # live account; the SDK sends the field but the server drops it). A genuine
        # expiry change must be done by cancel-and-replace; a level-only edit keeps
        # the cheap in-place modify.
        if _mt5_expiry_changes(current, expires_at, clear_expiry):
            return await self._replace_working_order(
                current, new_price, new_sl, new_tp, expires_at, clear_expiry
            )

        try:
            resp = await self._data._bounded(
                lambda c: c.modify_order(order_id, new_price, new_sl, new_tp)
            )
        except Exception as exc:
            return self._fail(f"modify-{order_id}", exc)
        return OrderResult(
            client_order_id=f"modify-{order_id}",
            status=OrderStatus.FILLED,
            deal_id=order_id,
            reason=resp.get("stringCode", ""),
            resolved_at=datetime.now(timezone.utc),
        )

    async def _replace_working_order(
        self,
        current: dict,
        new_price: float,
        new_sl: float,
        new_tp: float,
        expires_at: datetime | None,
        clear_expiry: bool,
    ) -> OrderResult:
        """Change a pending order's expiration by cancel-and-replace (MT5 can't
        amend expiration in place). NON-ATOMIC: there's a window between the cancel
        and the recreate. If the recreate fails, roll back by recreating the
        original order so the account is never left silently orderless."""
        order_id = str(current.get("id"))
        symbol = current.get("symbol")
        side = _pos_side(current.get("type", ""))
        lots = current.get("volume") or current.get("currentVolume")
        sl_arg = _lvl(new_sl)  # 0/None → None (no stop)
        tp_arg = _lvl(new_tp)
        exp_opts = None if clear_expiry else _mt5_expiration(expires_at)

        def _create(price, sl, tp, opts):
            # Limit-only: this project has no stop-entry order path, so a working
            # order is always a limit. If STOP orders are ever added, this must
            # branch on the original order type too, or it would silently recreate a
            # stop as a limit at the stop price (wrong side of the market).
            def run(c):
                fn = (
                    c.create_limit_buy_order
                    if side is Side.BUY
                    else c.create_limit_sell_order
                )
                return fn(symbol, lots, price, sl, tp, *((opts,) if opts else ()))

            return run

        # 1. Cancel the existing order. If THIS fails, nothing changed — reject and
        # leave the original order intact.
        try:
            await self._data._bounded(lambda c: c.cancel_order(order_id))
        except Exception as exc:
            return self._fail(f"replace-{order_id}", exc)

        # 2. Recreate with the merged levels + the new expiration.
        try:
            resp = await self._data._bounded(_create(new_price, sl_arg, tp_arg, exp_opts))
        except Exception as exc:
            # An AMBIGUOUS create failure (timeout / connection drop — anything but a
            # clean server reject) may have ALREADY placed the replacement on the
            # server; recreating the original now would leave TWO live orders. Only a
            # TradeException means the server definitively rejected and NO order was
            # placed, so only then is a rollback safe. Otherwise → UNKNOWN so the
            # caller reconciles (refetches working orders), with NO second create.
            if not isinstance(exc, TradeException):
                return self._fail(f"replace-{order_id}", exc)
            # Clean reject: the order was cancelled but not replaced. Recreate the
            # ORIGINAL (its pre-cancel price/SL/TP + original expiration) so real
            # money isn't left exposed with no resting order.
            orig_opts = _order_original_expiration(current)
            try:
                await self._data._bounded(
                    _create(
                        current.get("openPrice"),
                        _lvl(current.get("stopLoss")),
                        _lvl(current.get("takeProfit")),
                        orig_opts,
                    )
                )
                restored = True
            except Exception:
                log.exception("MT5 expiry cancel-replace rollback FAILED for %s", order_id)
                restored = False
            reason = (
                f"expiry change failed; original order restored: {exc}"
                if restored
                else f"expiry change failed AND rollback failed — order {order_id} "
                f"is CANCELLED with no replacement: {exc}"
            )
            return OrderResult(
                client_order_id=f"replace-{order_id}",
                status=OrderStatus.REJECTED,
                reason=reason,
                resolved_at=datetime.now(timezone.utc),
            )

        # The replacement is a fresh pending order with a new ticket id.
        return OrderResult(
            client_order_id=f"replace-{order_id}",
            status=OrderStatus.PENDING,
            deal_id=resp.get("orderId"),
            reason=resp.get("stringCode", ""),
            resolved_at=datetime.now(timezone.utc),
        )

    async def cancel_working_order(self, order_id: str) -> OrderResult:
        try:
            resp = await self._data._bounded(lambda c: c.cancel_order(order_id))
        except Exception as exc:
            return self._fail(f"cancel-{order_id}", exc)
        return OrderResult(
            client_order_id=f"cancel-{order_id}",
            status=OrderStatus.FILLED,
            deal_id=order_id,
            reason=resp.get("stringCode", ""),
            resolved_at=datetime.now(timezone.utc),
        )


def register(registry: "BrokerRegistry", *, token: str, account_id: str, region: str = "london") -> MT5Broker:
    """Wire the MT5/AvaTrade account: the "mt5" data broker, the in-app paper
    simulator ("mt5:paper", fills priced off live MT5 quotes) and the real-money
    dealing account ("mt5:live"). Caller gates this on mt5_settings.has()."""
    from auto_trader.brokers import paper_exec

    broker = MT5Broker(token=token, account_id=account_id, region=region)
    registry.add_data("mt5", broker)
    paper_exec.register(registry, broker, broker_id="mt5")  # mt5:paper
    registry.add_exec("mt5:live", MT5ExecutionBroker(broker))
    broker.start_display_name_fetch()  # real broker name for the selector label
    return broker
