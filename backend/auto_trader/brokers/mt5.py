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
        # Per-symbol MetaApi specification cache (contractSize/volumeStep/digits are
        # static), plus a set tracking which symbols we've already warned about
        # missing a contractSize, so the fallback warning fires at most once each.
        self._spec_cache: dict[str, dict] = {}
        self._warned_no_contract: set[str] = set()

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
        # order.quantity is in instrument units (the app's convention); MetaApi
        # deals in lots. Convert once here; filled_quantity is reported in units.
        lots = await self._data._units_to_lots(order.epic, order.quantity)
        submitted_at = datetime.now(timezone.utc)
        try:
            if order.type is OrderType.MARKET:
                if order.side is Side.BUY:
                    resp = await conn.create_market_buy_order(order.epic, lots, sl, tp)
                else:
                    resp = await conn.create_market_sell_order(order.epic, lots, sl, tp)
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
                    resp = await conn.create_limit_buy_order(order.epic, lots, order.limit_level, sl, tp)
                else:
                    resp = await conn.create_limit_sell_order(order.epic, lots, order.limit_level, sl, tp)
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
        conn = await self._data._ensure()
        try:
            if quantity is None:
                resp = await conn.close_position(deal_id)
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
                resp = await conn.close_position_partially(deal_id, lots)
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
        current = {str(o.get("id")): o for o in orders}.get(str(order_id))
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
