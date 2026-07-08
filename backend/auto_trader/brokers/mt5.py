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
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING

from metaapi_cloud_sdk import MetaApi
from metaapi_cloud_sdk.clients.metaapi.trade_exception import TradeException
from metaapi_cloud_sdk.clients.timeout_exception import TimeoutException
from metaapi_cloud_sdk.logger import LoggerManager

from auto_trader.brokers.base import ExecutionBroker, MarketDataBroker
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


def _is_closed(c: Candle, resolution: Resolution, now: datetime) -> bool:
    """True once the bar's interval has fully elapsed. MetaApi returns the current
    forming bar as the last element; we drop it so callers see closed bars only
    (matching the Capital/IG contract and the candle cache)."""
    return c.time + timedelta(seconds=resolution.seconds) <= now


def _pos_side(raw_type: str) -> Side:
    """MT5 position/order type string -> Side. Buys contain "_BUY"."""
    return Side.BUY if "BUY" in (raw_type or "").upper() else Side.SELL


def _lvl(v: float | None) -> float | None:
    """MT5 reports absent stop/target as 0 (or None). Normalise both to None."""
    return v if v else None


class MT5Broker(MarketDataBroker):
    """Market data + the shared MetaApi connection for one AvaTrade MT5 account.

    Holds the single RPC connection the execution broker also trades through, so
    only one MetaApi session exists per account. Streaming isn't wired yet
    (supports_streaming stays False): charts load REST history and the live price
    comes from get_quote polling, same as the IG adapter.
    """

    def __init__(self, *, token: str, account_id: str, region: str = "london") -> None:
        self._token = token
        self._account_id = account_id
        self._region = region
        self._api: MetaApi | None = None
        self._acct = None
        self._conn = None
        self._synced = False
        self._lock = asyncio.Lock()

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

    async def read(self, make_coro):
        """Run a read-only RPC coroutine, reconnecting ONCE if the connection has
        dropped (MetaApi raises TimeoutException when the socket is stale). Safe to
        retry precisely because the caller has no side effects — never route a trade
        through here, only reads (quotes, positions, orders, catalogue)."""
        conn = await self._ensure()
        try:
            return await make_coro(conn)
        except TimeoutException:
            self._synced = False  # drop the stale connection; _ensure re-syncs
            conn = await self._ensure()
            return await make_coro(conn)

    async def aclose(self) -> None:
        """Close the connection on shutdown. The account is left DEPLOYED — tearing
        it down would stop live trading and re-deploying is slow + costs a deploy
        charge; deployment is managed in the MetaApi dashboard, not per process."""
        conn, self._conn, self._synced = self._conn, None, False
        if conn is not None:
            try:
                await conn.close()
            except Exception:  # best-effort on shutdown
                log.debug("mt5: error closing connection", exc_info=True)

    # --- candles --------------------------------------------------------------

    async def get_candles(
        self,
        epic: str,
        resolution: Resolution,
        start: datetime,
        end: datetime,
        price_side: str = "mid",
    ) -> list[Candle]:
        """Closed candles in [start, end], ascending. Pages backward from `end`
        (MetaApi returns ≤1000 bars up to and including the anchor time).

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
        now = datetime.now(timezone.utc)
        return sorted(
            (c for c in by_time.values() if _is_closed(c, resolution, now)),
            key=lambda c: c.time,
        )

    async def get_recent_candles(
        self,
        epic: str,
        resolution: Resolution,
        count: int,
        price_side: str = "mid",
    ) -> list[Candle]:
        """Most recent `count` CLOSED candles (robust when the market is shut).
        Over-fetches by one to absorb dropping the forming bar."""
        await self._ensure()
        tf = _TIMEFRAME[resolution]
        batch = await self._acct.get_historical_candles(epic, tf, None, count + 1)
        now = datetime.now(timezone.utc)
        closed = [c for c in (_to_candle(r) for r in batch) if _is_closed(c, resolution, now)]
        closed.sort(key=lambda c: c.time)
        return closed[-count:]

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
        """Full MT5 symbol list. Stocks are '#'-prefixed on AvaTrade; we tag those
        SHARES and everything else CURRENCIES for the symbol-search modal's filter."""
        try:
            conn = await self._ensure()
            syms = await conn.get_symbols()
        except Exception:
            log.debug("mt5: get_symbols failed", exc_info=True)
            return []
        return [
            {
                "epic": s,
                "name": s.lstrip("#"),
                "status": "TRADEABLE",
                "type": "SHARES" if s.startswith("#") else "CURRENCIES",
            }
            for s in syms
        ]

    async def search_markets(self, query: str, limit: int = 20) -> list[dict]:
        q = (query or "").upper()
        markets = await self.all_markets()
        hits = [m for m in markets if q in m["epic"].upper()]
        return hits[:limit]

    async def get_market_meta(self, epic: str) -> dict | None:
        """Display precision (decimal digits) + tradeable status for one symbol."""
        try:
            conn = await self._ensure()
            spec = await conn.get_symbol_specification(epic)
        except Exception:
            log.debug("mt5: get_symbol_specification failed for %s", epic, exc_info=True)
            return None
        if not spec:
            return None
        return {
            "epic": epic,
            "precision": spec.get("digits"),
            "minVolume": spec.get("minVolume"),
            "volumeStep": spec.get("volumeStep"),
            "status": "TRADEABLE",
        }


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
        if isinstance(exc, TimeoutException):
            # The socket was stale — force a reconnect before the next call so we
            # don't compound a dropped connection. We do NOT retry the trade: an
            # UNKNOWN must be reconciled via get_positions, never blindly re-sent.
            self._data._synced = False
        return OrderResult(
            client_order_id=client_order_id,
            status=OrderStatus.UNKNOWN,
            reason=str(exc),
            resolved_at=datetime.now(timezone.utc),
        )

    async def _fill_price(self, conn, position_id) -> float | None:
        """Open level of the just-filled position, or None if it can't be read
        (never fail a confirmed fill just because the price lookup didn't land)."""
        if position_id is None:
            return None
        try:
            for p in await conn.get_positions():
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

        conn = await self._data._ensure()
        sl = order.stop_level
        tp = order.take_profit_level
        submitted_at = datetime.now(timezone.utc)
        try:
            if order.type is OrderType.MARKET:
                if order.side is Side.BUY:
                    resp = await conn.create_market_buy_order(order.epic, order.quantity, sl, tp)
                else:
                    resp = await conn.create_market_sell_order(order.epic, order.quantity, sl, tp)
                # A market order fills into a position immediately. The trade
                # response carries no fill price, so read it back off the position
                # (matching Capital/IG, which surface the fill level) — best-effort.
                position_id = resp.get("positionId")
                fill_price = await self._fill_price(conn, position_id)
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
                if order.side is Side.BUY:
                    resp = await conn.create_limit_buy_order(order.epic, order.quantity, order.limit_level, sl, tp)
                else:
                    resp = await conn.create_limit_sell_order(order.epic, order.quantity, order.limit_level, sl, tp)
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
            if epic is not None and p.get("symbol") != epic:
                continue
            out.append(
                Position(
                    epic=p.get("symbol"),
                    side=_pos_side(p.get("type", "")),
                    quantity=p.get("volume", 0.0),
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
        conn = await self._data._ensure()
        try:
            if quantity is None:
                resp = await conn.close_position(deal_id)
            else:
                resp = await conn.close_position_partially(deal_id, quantity)
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
        current = {p.get("id"): p for p in positions}.get(_maybe_int(deal_id))
        conn = await self._data._ensure()
        cur_sl = current.get("stopLoss") if current else None
        cur_tp = current.get("takeProfit") if current else None
        new_sl = 0 if clear_stop else (stop_level if stop_level is not None else cur_sl)
        new_tp = 0 if clear_take_profit else (take_profit_level if take_profit_level is not None else cur_tp)
        try:
            resp = await conn.modify_position(deal_id, new_sl, new_tp)
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
            if epic is not None and o.get("symbol") != epic:
                continue
            out.append(
                WorkingOrder(
                    epic=o.get("symbol"),
                    side=_pos_side(o.get("type", "")),
                    quantity=o.get("volume", o.get("currentVolume", 0.0)),
                    limit_level=o.get("openPrice"),
                    order_id=str(o.get("id")),
                    stop_level=_lvl(o.get("stopLoss")),
                    take_profit_level=_lvl(o.get("takeProfit")),
                    created_at=o.get("time"),
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
    ) -> OrderResult:
        orders = await self._data.read(lambda c: c.get_orders())
        current = {o.get("id"): o for o in orders}.get(_maybe_int(order_id))
        conn = await self._data._ensure()
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
        try:
            resp = await conn.modify_order(order_id, new_price, new_sl, new_tp)
        except Exception as exc:
            return self._fail(f"modify-{order_id}", exc)
        return OrderResult(
            client_order_id=f"modify-{order_id}",
            status=OrderStatus.FILLED,
            deal_id=order_id,
            reason=resp.get("stringCode", ""),
            resolved_at=datetime.now(timezone.utc),
        )

    async def cancel_working_order(self, order_id: str) -> OrderResult:
        conn = await self._data._ensure()
        try:
            resp = await conn.cancel_order(order_id)
        except Exception as exc:
            return self._fail(f"cancel-{order_id}", exc)
        return OrderResult(
            client_order_id=f"cancel-{order_id}",
            status=OrderStatus.FILLED,
            deal_id=order_id,
            reason=resp.get("stringCode", ""),
            resolved_at=datetime.now(timezone.utc),
        )


def _maybe_int(v):
    """Position/order ids come back as ints from MetaApi but we carry them as str
    (the domain contract). Coerce for dict lookups against raw MetaApi payloads."""
    try:
        return int(v)
    except (TypeError, ValueError):
        return v


def register(registry: "BrokerRegistry", *, token: str, account_id: str, region: str = "london") -> MT5Broker:
    """Wire the MT5/AvaTrade account: the "mt5" data broker, the in-app paper
    simulator ("mt5:paper", fills priced off live MT5 quotes) and the real-money
    dealing account ("mt5:live"). Caller gates this on mt5_settings.has()."""
    from auto_trader.brokers import paper_exec

    broker = MT5Broker(token=token, account_id=account_id, region=region)
    registry.add_data("mt5", broker)
    paper_exec.register(registry, broker, broker_id="mt5")  # mt5:paper
    registry.add_exec("mt5:live", MT5ExecutionBroker(broker))
    return broker
