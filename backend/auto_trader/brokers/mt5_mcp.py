"""MetaTrader 5 broker via the terminal's own built-in MCP server (AvaTrade).

MT5 build 6180+ ships an MCP server inside the desktop terminal
(Tools > Options > MCP, default http://127.0.0.1:22346/mcp, bearer API key). It
exposes account info, positions/orders, candle history, Market Watch and the
trade calls we need, so a locally running, logged-in terminal (native Windows,
or the macOS app under Wine) replaces the custom REST bridge the 2026-07-11
spec planned. Registered as the "mt5-self" data broker with "mt5-self:paper"
and the real-money "mt5-self:live" beside the MetaApi "mt5", which stays: the
two are permanent alternatives for the same account, not a migration.

Transport is a thin JSON-RPC-over-HTTP client (initialize, then tools/call),
not the `mcp` SDK: the SDK's task-group lifetime does not fit a long-lived
broker, and three calls do not justify it. Tool results are JSON packed into
`content[0].text`; `isError` is the terminal refusing the call.

Conventions that match the MetaApi adapter:
- `epic` IS the MT5 symbol verbatim ("EURUSD", "#NVIDIA").
- MT5 speaks LOTS; the app speaks instrument units. Convert at this boundary.

What the MCP cannot do, and how it surfaces:
- No push stream. Live ticks are POLLED: one Market Watch read per round
  (6 ms for every selected row) tells which subscribed symbols moved, and
  `get_chart_ticks_history` then returns every tick since the last one, so
  no tick is skipped between rounds. The same four hooks the MetaApi broker
  exposes (`_ensure_stream`, `register_tick_queue`, `unregister_tick_queue`,
  `get_forming_candle`) sit on top, so `mt5_stream.stream_candles` folds the
  ticks into bars unchanged for both brokers.
- Higher-timeframe series lag inside the terminal until something rebuilds
  them, while M1 is current. The candle reads therefore rebuild the newest
  bars of any timeframe above M1 from M1 (`_patch_tail`).
- A symbol must be in Market Watch before history/quotes work; a miss adds it
  (this changes the user's Market Watch, visibility only).
- No partial close and no pending-order price/expiry change: REJECTED with a
  reason. Partial close is NOT emulated with an opposite order: on a hedging
  account that opens a second position instead of reducing the first.
- Timestamps are broker server time, naive. `server_utc_offset_minutes`
  (0 on Ava-Real 1-MT5, verified 2026-09-23) converts them to UTC.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Any

import httpx

from auto_trader.brokers._mt5_symbols import MT5_CATEGORIES, _classify_symbol, avatrade_ticker
from auto_trader.brokers._prices import pick_side
from auto_trader.brokers.base import ExecutionBroker, MarketDataBroker
from auto_trader.core.broker_health import BrokerReconnecting, BrokerTimeout
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

BROKER_ID = "mt5-self"
_PROTOCOL = "2025-06-18"

_PERIOD = {
    Resolution.MINUTE: "M1",
    Resolution.MINUTE_5: "M5",
    Resolution.MINUTE_15: "M15",
    Resolution.MINUTE_30: "M30",
    Resolution.HOUR: "H1",
    Resolution.HOUR_4: "H4",
    Resolution.DAY: "D1",
    Resolution.WEEK: "W1",
}

# One history call returns at most this many bars (the tool's own default is
# 100000). When a page comes back full, the next page ends at its oldest bar.
_PAGE = 50_000
_MAX_PAGES = 20
# The M1 tail rebuild covers at most this far back past the end of the last
# bar the terminal has; a higher-timeframe series staler than that is
# returned as the terminal has it. Measured from the bar's END, or a W1 series
# one week stale (last bar opened 11 days ago) would never be rebuilt.
_TAIL_MAX = timedelta(days=8)
# Lazy history download: a reply whose oldest bar sits more than _LOAD_GAP
# after what was asked for (and after what the symbol has) is still loading.
# The gap clears a long weekend or holiday so a real market pause never trips it.
_LOAD_GAP = timedelta(days=5)
_LOAD_RETRIES = 3
_LOAD_WAIT = 3.0
_STABLE_FOR = 12.0
# After a terminal restart, M1 history ends where the terminal last saved it
# until it catches up (observed: GBPUSD M1 two days stale on the first reply,
# current about 2 s later). An M1 reply whose newest bar sits more than
# _TAIL_LAG behind the symbol's last tick is still syncing.
_TAIL_LAG = timedelta(minutes=10)
# Tick polling: one Market Watch read per round while any chart is subscribed
# (ticks arrive up to _POLL_INTERVAL late; the fold stamps them on receipt).
# A round that fails waits _POLL_BACKOFF before the next.
_POLL_INTERVAL = 0.5
_POLL_BACKOFF = 5.0
_TICK_PAGE = 5_000
# Ticks older than this are never delivered: after an outage (a sleeping Mac)
# the gap's backlog would otherwise all fold into the CURRENT bar, since the
# fold stamps ticks on receipt.
_CATCHUP = timedelta(seconds=2 * _POLL_BACKOFF)

# MT5 trade server return codes that mean the request went through
# (DONE, PLACED, DONE_PARTIAL). Anything else with a retcode is a rejection.
_RETCODE_OK = {10008, 10009, 10010}

_ACCOUNT_ENV = {"real": "live", "demo": "demo"}


class MCPError(RuntimeError):
    """A protocol-level failure talking to the terminal's MCP server."""


class MCPAuthError(MCPError):
    """401 from the terminal: the configured key is wrong. Not retryable; fix
    MT5MCP_KEY from Tools > Options > MCP."""


class MCPToolError(MCPError):
    """The terminal refused the tool call (`isError`): unknown symbol, trade
    rejected, trading disabled, and so on. The message is the terminal's text."""


def _parse_body(text: str) -> dict:
    """A JSON-RPC response arrives either as plain JSON or as an SSE stream
    whose last `data:` line carries it."""
    text = text.strip()
    if not text:
        return {}
    if text.startswith("{"):
        return json.loads(text)
    data = [ln[5:].strip() for ln in text.splitlines() if ln.startswith("data:")]
    if not data:
        raise MCPError(f"unparseable MCP response: {text[:200]}")
    return json.loads(data[-1])


class MT5MCPClient:
    """Minimal MCP client over streamable HTTP: one session, re-initialized
    when the terminal restarts and forgets it. Calls are serialized by the
    terminal anyway, so there is no attempt at concurrency here."""

    def __init__(self, url: str, key: str, http: httpx.AsyncClient | None = None) -> None:
        self._url = url
        self._key = key
        self._http = http or httpx.AsyncClient()
        self._session: str | None = None
        self._init_lock = asyncio.Lock()
        self._next_id = 0

    async def aclose(self) -> None:
        await self._http.aclose()

    def _headers(self) -> dict[str, str]:
        h = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "Authorization": f"Bearer {self._key}",
            "MCP-Protocol-Version": _PROTOCOL,
        }
        if self._session:
            h["Mcp-Session-Id"] = self._session
        return h

    async def _post(self, method: str, params: dict | None, *, notify: bool = False, timeout: float) -> dict:
        body: dict[str, Any] = {"jsonrpc": "2.0", "method": method, "params": params or {}}
        if not notify:
            self._next_id += 1
            body["id"] = self._next_id
        try:
            resp = await self._http.post(self._url, json=body, headers=self._headers(), timeout=timeout)
        except httpx.TimeoutException as exc:
            raise BrokerTimeout(f"{BROKER_ID}: {method} timed out") from exc
        except httpx.TransportError as exc:
            # Terminal closed, restarting, or MCP disabled in its options.
            raise BrokerReconnecting(BROKER_ID) from exc
        if resp.status_code == 401:
            raise MCPAuthError(f"{BROKER_ID}: MCP key rejected (check MT5MCP_KEY)")
        if resp.status_code in (400, 404) and self._session:
            # Unknown session: the terminal restarted. The caller re-initializes.
            self._session = None
            raise _SessionLost()
        if resp.status_code >= 400:
            raise MCPError(f"{BROKER_ID}: HTTP {resp.status_code} on {method}")
        self._session = resp.headers.get("Mcp-Session-Id") or self._session
        return _parse_body(resp.text)

    async def _ensure_session(self) -> None:
        async with self._init_lock:
            if self._session:
                return
            init = await self._post(
                "initialize",
                {"protocolVersion": _PROTOCOL, "capabilities": {}, "clientInfo": {"name": "chartkar", "version": "1"}},
                timeout=10.0,
            )
            if "error" in init:
                raise MCPError(f"{BROKER_ID}: initialize failed: {init['error']}")
            await self._post("notifications/initialized", None, notify=True, timeout=10.0)

    async def call(self, tool: str, args: dict | None = None, *, timeout: float = 20.0) -> Any:
        """Run one tool. Returns the decoded JSON payload (or the raw text when
        it is not JSON). Raises MCPToolError when the terminal refuses."""
        for attempt in (0, 1):
            await self._ensure_session()
            try:
                msg = await self._post("tools/call", {"name": tool, "arguments": args or {}}, timeout=timeout)
            except _SessionLost:
                if attempt:
                    raise MCPError(f"{BROKER_ID}: MCP session lost twice") from None
                continue
            break
        if "error" in msg:
            raise MCPError(f"{BROKER_ID}: {tool}: {msg['error']}")
        result = msg.get("result") or {}
        content = result.get("content") or []
        text = content[0].get("text", "") if content else ""
        if result.get("isError"):
            raise MCPToolError(text or f"{tool} failed")
        try:
            return json.loads(text) if text else {}
        except json.JSONDecodeError:
            return text


class _SessionLost(Exception):
    pass


def _f(v: Any) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _lvl(v: Any) -> float | None:
    """MT5 reports an absent stop/target as 0 (or omits it). Normalise to None."""
    f = _f(v)
    return f if f else None


def _first(d: dict, *keys: str) -> Any:
    for k in keys:
        if d.get(k) not in (None, ""):
            return d[k]
    return None


def _upnl(p: dict) -> float | None:
    """Open P&L with swap, in account currency. MT5's `profit` leaves swap
    out while equity counts it (profit + swaps == equity - balance, checked
    on a live account)."""
    profit = _f(p.get("profit"))
    return None if profit is None else profit + (_f(p.get("swaps")) or 0.0)


def _side(action: Any) -> Side:
    return Side.BUY if "buy" in str(action or "").lower() else Side.SELL


class MT5MCPBroker(MarketDataBroker):
    """Market data for the account logged into the local MT5 terminal, plus
    the shared MCP client the execution broker trades through."""

    supports_streaming = True
    CATEGORIES = MT5_CATEGORIES

    READ_BUDGET = 20.0
    HISTORY_BUDGET = 60.0

    def __init__(self, *, url: str, key: str, server_utc_offset_minutes: int = 0,
                 client: MT5MCPClient | None = None) -> None:
        self.client = client or MT5MCPClient(url, key)
        self._offset = timedelta(minutes=server_utc_offset_minutes)
        self._symbols: dict[str, dict] = {}
        # (epic, period) -> (oldest bar seen, monotonic time it last moved)
        self._depth: dict[tuple[str, str], tuple[datetime, float]] = {}
        # (epic, period) -> (newest bar seen, monotonic time it last moved)
        self._tail: dict[tuple[str, str], tuple[datetime | None, float]] = {}
        self._label_task: asyncio.Task | None = None
        # Live ticks: consumer queues per symbol (mt5_stream folds them),
        # the poller feeding them, and the newest tick time delivered per
        # symbol (where the next tick-history read starts).
        self._tick_subs: dict[str, set[asyncio.Queue]] = {}
        self._sub_refcount: dict[str, int] = {}
        self._stream_lock = asyncio.Lock()
        self._poll_task: asyncio.Task | None = None
        self._last_tick: dict[str, datetime] = {}

    async def aclose(self) -> None:
        for task in (self._label_task, self._poll_task):
            if task is not None:
                task.cancel()
        self._label_task = self._poll_task = None
        await self.client.aclose()

    # --- time -----------------------------------------------------------------

    def _to_utc(self, s: str) -> datetime:
        """Server-time "2026.09.22 20:00:00" (or ISO) -> aware UTC."""
        s = str(s).replace(".", "-", 2).replace("T", " ").rstrip("Z")
        return datetime.fromisoformat(s).replace(tzinfo=timezone.utc) - self._offset

    def _to_server(self, dt: datetime, *, ms: bool = False) -> str:
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        srv = dt.astimezone(timezone.utc) + self._offset
        text = srv.strftime("%Y-%m-%dT%H:%M:%S")
        return f"{text}.{srv.microsecond // 1000:03d}" if ms else text

    def _bucket(self, t: datetime, res: Resolution) -> datetime:
        """Open time of the `res` bar containing UTC `t`, aligned the way MT5
        aligns bars: on the server clock, weeks opening on Sunday."""
        srv = t + self._offset
        if res is Resolution.WEEK:
            day = srv.replace(hour=0, minute=0, second=0, microsecond=0)
            start = day - timedelta(days=(day.weekday() + 1) % 7)
        else:
            secs = res.seconds
            epoch = int(srv.timestamp())
            start = datetime.fromtimestamp(epoch - epoch % secs, tz=timezone.utc)
        return start - self._offset

    # --- tool helpers ---------------------------------------------------------

    async def call(self, tool: str, args: dict | None = None, *, timeout: float | None = None) -> Any:
        return await self.client.call(tool, args, timeout=timeout or self.READ_BUDGET)

    async def _select(self, symbol: str) -> None:
        await self.call("add_marketwatch_symbol", {"symbol": symbol})

    async def _symbol_call(self, tool: str, args: dict, *, timeout: float | None = None) -> Any:
        """A per-symbol read that needs the symbol in Market Watch: on the
        terminal's "symbol not found", add it and retry once."""
        try:
            return await self.call(tool, args, timeout=timeout)
        except MCPToolError as exc:
            if "not found" not in str(exc).lower():
                raise
            await self._select(args["symbol"])
            return await self.call(tool, args, timeout=timeout)

    # --- candles --------------------------------------------------------------

    def _to_candle(self, row: dict) -> Candle:
        return Candle(
            time=self._to_utc(row["time"]),
            open=float(row["open"]),
            high=float(row["high"]),
            low=float(row["low"]),
            close=float(row["close"]),
            volume=float(row.get("tick_volume") or 0),
        )

    async def _history(self, epic: str, period: str, start: datetime, end: datetime,
                       limit: int = _PAGE) -> list[Candle]:
        """Bars with open time in [start, end), ascending, complete or not at
        all. The terminal downloads history lazily: the first request for a
        symbol can return only the part it already holds (observed: AUDUSD M1
        starting weeks late, full ~6 s later). A reply that stops well short of
        `start` is retried until it stops changing; one still changing after
        the retries is raised as retryable, so a caller never caches a range
        the terminal was midway through loading."""
        # `data_available_from` overstates real depth (EURUSD reports 1993, its
        # D1 starts in 2011), so a short reply is only "loading" while its oldest
        # bar keeps moving. Deep loads advance in steps several seconds apart,
        # so the oldest bar must hold still for _STABLE_FOR before a short reply
        # counts as all the terminal has. The clock is kept per series across
        # calls, so a known hard limit answers at once next time. The newest
        # bar gets the same treatment against the last tick (_tail_behind).
        key = (epic, period)
        for attempt in range(_LOAD_RETRIES + 1):
            bars, available_from = await self._history_once(epic, period, start, end, limit)
            loading = (
                await self._tail_behind(epic, period, bars, start, end)
                and not self._settled(self._tail, key, bars[-1].time if bars else None)
            ) or (
                self._looks_truncated(bars, start, available_from, limit)
                and not self._settled(self._depth, key, bars[0].time)
            )
            if not loading:
                return bars
            if attempt < _LOAD_RETRIES:
                await asyncio.sleep(_LOAD_WAIT)
        raise BrokerReconnecting(f"{BROKER_ID}: {epic} {period} history still loading in the terminal")

    @staticmethod
    def _settled(clock: dict, key: tuple[str, str], mark: datetime | None) -> bool:
        """True once `mark` has held still for _STABLE_FOR, timed across calls."""
        now = time.monotonic()
        seen = clock.get(key)
        if seen is None or seen[0] != mark:
            clock[key] = (mark, now)
            return False
        return now - seen[1] >= _STABLE_FOR

    async def _tail_behind(self, epic: str, period: str, bars: list[Candle],
                           start: datetime, end: datetime) -> bool:
        """An M1 reply reaching the present whose newest bar trails the
        symbol's last tick (Market Watch `update_time`) by more than _TAIL_LAG.
        Higher timeframes lag by design and are rebuilt from M1 instead. No
        tick time (symbol not selected yet, read failed) means no check."""
        if period != "M1":
            return False
        now = datetime.now(timezone.utc)
        newest = bars[-1].time if bars else None
        if end < now - _TAIL_LAG or (newest is not None and newest >= now - _TAIL_LAG):
            return False  # a past window (scroll-back), or already current
        try:
            row = await self._market_row(epic, fresh=True)
            tick = self._to_utc(row["update_time"]) if row and row.get("update_time") else None
        except Exception:
            log.debug("%s: tick time read failed for %s", BROKER_ID, epic, exc_info=True)
            return False
        if tick is None or not start <= tick < end:
            return False
        return newest is None or tick - newest > _TAIL_LAG

    @staticmethod
    def _looks_truncated(bars: list[Candle], start: datetime, available_from: datetime | None,
                         limit: int) -> bool:
        if not bars or len(bars) >= limit:
            return False  # empty (closed window) or a full newest-N answer
        floor = max(start, available_from) if available_from else start
        return bars[0].time - floor > _LOAD_GAP

    async def _history_once(self, epic: str, period: str, start: datetime, end: datetime,
                            limit: int) -> tuple[list[Candle], datetime | None]:
        available_from: datetime | None = None
        out: dict[datetime, Candle] = {}
        to = end
        for _ in range(_MAX_PAGES):
            data = await self._symbol_call(
                "get_chart_history",
                {"symbol": epic, "period": period, "datetime_from": self._to_server(start),
                 "datetime_to": self._to_server(to), "limit": limit},
                timeout=self.HISTORY_BUDGET,
            )
            rows = (data or {}).get("history") or [] if isinstance(data, dict) else []
            if available_from is None and isinstance(data, dict) and data.get("data_available_from"):
                try:
                    available_from = self._to_utc(data["data_available_from"])
                except ValueError:
                    pass
            batch = [self._to_candle(r) for r in rows]
            for c in batch:
                out[c.time] = c
            if len(rows) < limit or not batch or limit < _PAGE:
                break
            oldest = min(c.time for c in batch)
            if oldest <= start:
                break
            to = oldest
        return sorted(out.values(), key=lambda c: c.time), available_from

    async def _patch_tail(self, epic: str, res: Resolution, bars: list[Candle],
                          start: datetime, end: datetime) -> list[Candle]:
        """Rebuild the newest `res` bars from M1, which the terminal keeps
        current while higher timeframes lag. Only when the window reaches the
        present; bars before the last returned one are left as they are."""
        if res is Resolution.MINUTE:
            return bars
        now = datetime.now(timezone.utc)
        if end < now - timedelta(seconds=2 * res.seconds):
            return bars
        tail_from = bars[-1].time if bars else self._bucket(max(start, now - timedelta(seconds=res.seconds)), res)
        if tail_from + timedelta(seconds=res.seconds) < now - _TAIL_MAX:
            return bars
        minutes = await self._history(epic, "M1", tail_from, now + timedelta(minutes=1))
        if not minutes:
            return bars
        rebuilt: dict[datetime, list[Candle]] = {}
        for m in minutes:
            rebuilt.setdefault(self._bucket(m.time, res), []).append(m)
        merged = {c.time: c for c in bars}
        for t, ms in rebuilt.items():
            if t < tail_from or not (start <= t <= end):
                continue
            merged[t] = Candle(
                time=t,
                open=ms[0].open,
                high=max(m.high for m in ms),
                low=min(m.low for m in ms),
                close=ms[-1].close,
                volume=sum(m.volume for m in ms),
            )
        return sorted(merged.values(), key=lambda c: c.time)

    async def get_candles(self, epic: str, resolution: Resolution, start: datetime,
                          end: datetime, price_side: str = "mid") -> list[Candle]:
        """Candles in [start, end], ascending, forming bar included (matching
        Capital/IG). MT5 candles are one bid-based series, so `price_side` is
        accepted for parity and not applied."""
        period = _PERIOD[resolution]
        bars = await self._history(epic, period, start, end + timedelta(seconds=1))
        bars = [c for c in bars if start <= c.time <= end]
        return await self._patch_tail(epic, resolution, bars, start, end)

    async def get_recent_candles(self, epic: str, resolution: Resolution, count: int,
                                 price_side: str = "mid") -> list[Candle]:
        """The newest `count` bars regardless of date. The window is padded
        for weekends and holidays; the tool returns the newest `limit` bars in
        it."""
        now = datetime.now(timezone.utc)
        span = timedelta(seconds=resolution.seconds * count * 3) + timedelta(days=10)
        bars = await self._history(epic, _PERIOD[resolution], now - span, now + timedelta(days=1), limit=count)
        bars = await self._patch_tail(epic, resolution, bars, now - span, now + timedelta(days=1))
        return bars[-count:]

    async def get_forming_candle(self, epic: str, resolution: Resolution,
                                 price_side: str = "mid") -> Candle | None:
        """The current, still-forming bar, for mt5_stream to seed its fold
        from. The newest bar of any timeframe is rebuilt from M1, so this is
        current even where the terminal's own series lags. None on failure
        (the stream cold-starts)."""
        try:
            bars = await self.get_recent_candles(epic, resolution, 1, price_side)
        except Exception:
            log.debug("%s: get_forming_candle failed for %s", BROKER_ID, epic, exc_info=True)
            return None
        return bars[-1] if bars else None

    # --- live ticks (polled) ---------------------------------------------------
    # Same surface as MT5Broker's MetaApi stream, so mt5_stream.stream_candles
    # drives either broker: _ensure_stream, register/unregister_tick_queue.

    async def _ensure_stream(self) -> None:
        """Reachability check standing in for MetaApi's connect: a terminal
        that is down raises here (mt5_stream turns it into a recoverable
        error, and the chart keeps retrying) rather than in the per-symbol
        subscribe, which it reports as a permanent fault."""
        if self._poll_task is not None and not self._poll_task.done():
            return
        await self.call("get_marketwatch_symbols", {"limit": 1})

    async def register_tick_queue(self, symbol: str) -> asyncio.Queue:
        """Register a consumer queue for `symbol`'s ticks. The first consumer
        selects the symbol in Market Watch (only selected rows carry a price
        and an update time) and starts the poller if it is idle."""
        q: asyncio.Queue = asyncio.Queue()
        async with self._stream_lock:
            first = not self._tick_subs.get(symbol)
            self._tick_subs.setdefault(symbol, set()).add(q)
            self._sub_refcount[symbol] = self._sub_refcount.get(symbol, 0) + 1
            if first:
                try:
                    await self._select(symbol)
                except BaseException:
                    # An unknown symbol (or a cancel mid-subscribe) must leave no
                    # orphan registration that would block the symbol for good.
                    self._tick_subs.pop(symbol, None)
                    self._sub_refcount.pop(symbol, None)
                    raise
            if self._poll_task is None or self._poll_task.done():
                self._poll_task = asyncio.create_task(self._poll_ticks())
        return q

    async def unregister_tick_queue(self, symbol: str, q: asyncio.Queue) -> None:
        """Drop a consumer queue. The last consumer of a symbol forgets it; the
        poller exits by itself once no symbol is left."""
        async with self._stream_lock:
            subs = self._tick_subs.get(symbol)
            if subs:
                subs.discard(q)
            self._sub_refcount[symbol] = max(0, self._sub_refcount.get(symbol, 0) - 1)
            if self._sub_refcount[symbol] == 0:
                self._sub_refcount.pop(symbol, None)
                self._tick_subs.pop(symbol, None)
                self._last_tick.pop(symbol, None)

    async def _poll_ticks(self) -> None:
        """One loop per terminal while anything is subscribed. Each round reads
        Market Watch once and pulls tick history only for the subscribed
        symbols whose row moved (update_time is whole seconds, so bid/ask are
        part of the mark). The terminal serves one call at a time, so a trade
        waiting on a confirmation dialog can hold a round up; it resumes."""
        seen: dict[str, tuple] = {}
        failing = False
        while self._tick_subs:
            try:
                data = await self.call("get_marketwatch_symbols",
                                       {"include_hidden": False, "limit": 100_000})
                rows = {r.get("symbol"): r for r in ((data or {}).get("symbols") or [])}
                for symbol in list(self._tick_subs):
                    row = rows.get(symbol)
                    if row is None:
                        continue
                    mark = (row.get("update_time"), row.get("bid"), row.get("ask"))
                    if seen.get(symbol) == mark:
                        continue
                    seen[symbol] = mark
                    await self._deliver_ticks(symbol)
                if failing:
                    log.info("%s: tick poll recovered", BROKER_ID)
                    failing = False
                await asyncio.sleep(_POLL_INTERVAL)
            except asyncio.CancelledError:
                raise
            except Exception:
                # Warn once per outage (a sleeping Mac stops the terminal for
                # hours), then keep retrying quietly.
                log.log(logging.DEBUG if failing else logging.WARNING,
                        "%s: tick poll failed, retrying every %.0fs", BROKER_ID, _POLL_BACKOFF, exc_info=True)
                failing = True
                await asyncio.sleep(_POLL_BACKOFF)

    async def _deliver_ticks(self, symbol: str) -> None:
        """Every tick newer than the last delivered one onto the symbol's
        queues, as (bid, ask), never reaching back more than _CATCHUP. The
        first read for a symbol starts one poll interval back so a chart's
        first frame is not an old tick."""
        since = self._last_tick.get(symbol)
        now = datetime.now(timezone.utc)
        floor = now - _CATCHUP
        start = max(since, floor) if since is not None else now - timedelta(seconds=_POLL_INTERVAL)
        data = await self._symbol_call(
            "get_chart_ticks_history",
            {"symbol": symbol, "datetime_from": self._to_server(start, ms=True),
             "datetime_to": self._to_server(now + timedelta(minutes=1)), "limit": _TICK_PAGE},
        )
        rows = (data or {}).get("history") or [] if isinstance(data, dict) else []
        for r in rows:
            t = self._to_utc(r["time_ms"])
            if (since is not None and t <= since) or t < floor:
                continue  # already delivered (datetime_from is inclusive), or stale
            bid, ask = _f(r.get("bid")), _f(r.get("ask"))
            if bid is None or ask is None:
                continue
            for q in self._tick_subs.get(symbol, ()):
                q.put_nowait((bid, ask))
            self._last_tick[symbol] = t

    # --- quote + catalogue ----------------------------------------------------

    async def _market_row(self, epic: str, *, fresh: bool = False) -> dict | None:
        """The Market Watch row (spec + live bid/ask when selected), cached for
        spec reads. `fresh` skips the cache for prices."""
        if not fresh and epic in self._symbols:
            return self._symbols[epic]
        data = await self.call("get_marketwatch_symbols", {"symbol": epic, "include_hidden": True})
        rows = data.get("symbols") if isinstance(data, dict) else None
        row = rows[0] if rows else None
        if row:
            self._symbols[epic] = row
        return row

    async def get_quote(self, epic: str) -> tuple[float | None, float | None]:
        """Live (bid, ask) from Market Watch; only selected symbols carry a
        price, so a miss selects the symbol and reads again."""
        try:
            row = await self._market_row(epic, fresh=True)
            if row and row.get("bid") is None:
                await self._select(epic)
                row = await self._market_row(epic, fresh=True)
        except Exception:
            log.debug("%s: get_quote failed for %s", BROKER_ID, epic, exc_info=True)
            return (None, None)
        if not row:
            return (None, None)
        return (_lvl(row.get("bid")), _lvl(row.get("ask")))

    async def all_markets(self) -> list[dict]:
        try:
            data = await self.call("get_marketwatch_symbols", {"include_hidden": True, "limit": 100_000})
        except Exception:
            log.debug("%s: symbol list failed", BROKER_ID, exc_info=True)
            return []
        rows = data.get("symbols") if isinstance(data, dict) else None
        out = []
        for row in rows or []:
            sym = row.get("symbol")
            if not sym:
                continue
            self._symbols.setdefault(sym, row)
            out.append({
                "epic": sym,
                # description is often a contract note ("1 Lot= 100,000 AUD"),
                # so the name is the symbol, as on the MetaApi broker.
                "name": sym.lstrip("#_"),
                "status": "TRADEABLE",
                "type": _classify_symbol(sym),
            })
        return out

    async def search_markets(self, query: str, limit: int = 20) -> list[dict]:
        q = (query or "").upper()
        return [m for m in await self.all_markets() if q in m["epic"].upper()][:limit]

    # --- lots <-> units -------------------------------------------------------

    async def contract_size(self, epic: str) -> float:
        row = await self._market_row(epic)
        cs = _f((row or {}).get("contract_size"))
        return cs if cs else 1.0

    async def units_to_lots(self, epic: str, units: float) -> float:
        """Instrument units -> lots, snapped to the symbol's volume step."""
        lots = units / await self.contract_size(epic)
        step = _f((self._symbols.get(epic) or {}).get("volume_step"))
        if step:
            lots = round(lots / step) * step
        return round(lots, 8)

    async def get_market_meta(self, epic: str) -> dict | None:
        """Precision + sizing bounds in instrument UNITS. The MCP exposes no
        trading sessions, so `closed` stays None (unknown reads as open)."""
        try:
            row = await self._market_row(epic)
        except Exception:
            log.debug("%s: meta failed for %s", BROKER_ID, epic, exc_info=True)
            return None
        if not row:
            return None
        cs = _f(row.get("contract_size")) or 1.0
        vmin, step = _f(row.get("volume_min")), _f(row.get("volume_step"))
        disabled = str(row.get("trade_mode_name") or "").lower() == "disabled"
        return {
            "epic": epic,
            "pricePrecision": row.get("digits"),
            "minVolume": vmin * cs if vmin is not None else None,
            "volumeStep": step * cs if step is not None else None,
            "contractSize": cs,
            "closed": True if disabled else None,
            "nextOpen": None,
            "status": "CLOSED" if disabled else "TRADEABLE",
            "type": _classify_symbol(epic),
            "yahooTicker": avatrade_ticker(epic, row.get("description"), row.get("isin")),
        }

    async def get_market_detail(self, epic: str) -> dict | None:
        """Details popover: the raw Market Watch row verbatim plus the curated
        keys the header reads. No margin tool, so no leverage figure."""
        try:
            row = await self._market_row(epic, fresh=True)
        except Exception:
            log.debug("%s: detail failed for %s", BROKER_ID, epic, exc_info=True)
            return None
        if not row:
            return None
        cs = _f(row.get("contract_size")) or 1.0
        instrument = dict(row)
        instrument.update(epic=epic, name=epic.lstrip("#_"),
                          type=_classify_symbol(epic))
        if row.get("currency_profit"):
            instrument["currency"] = row["currency_profit"]
        snapshot: dict = {}
        if row.get("bid") is not None:
            snapshot["bid"] = row["bid"]
        if row.get("ask") is not None:
            snapshot["offer"] = row["ask"]
        if row.get("digits") is not None:
            snapshot["decimalPlacesFactor"] = row["digits"]
        dealing = {
            out_key: {"value": round(v * cs, 8), "unit": "units"}
            for out_key, key in (("minDealSize", "volume_min"), ("maxDealSize", "volume_max"),
                                 ("dealSizeStep", "volume_step"))
            if (v := _f(row.get(key))) is not None
        }
        return {"instrument": instrument, "dealingRules": dealing, "snapshot": snapshot}

    # --- account label --------------------------------------------------------

    def note_account_info(self, info: dict | None) -> None:
        """Selector label from the account block: "<broker> (live, self-hosted)"."""
        acct = (info or {}).get("account") or {}
        name = acct.get("broker")
        if not name:
            return
        env = _ACCOUNT_ENV.get(str(acct.get("type") or "").lower())
        self.display_name = f"{name} ({env}, self-hosted)" if env else f"{name} (self-hosted)"

    def start_display_name_fetch(self) -> None:
        """One background read of the account's broker name. A no-op outside a
        running loop (unit tests construct brokers directly)."""
        try:
            self._label_task = asyncio.get_running_loop().create_task(self._fetch_display_name())
        except RuntimeError:
            pass

    async def _fetch_display_name(self) -> None:
        # The terminal may not be running yet; poll gently for ~5 minutes.
        for _ in range(60):
            try:
                self.note_account_info(await self.call("get_trading_account_info"))
                return
            except Exception:
                await asyncio.sleep(5.0)


class MT5MCPExecutionBroker(ExecutionBroker):
    """Real-money dealing on the account logged into the local terminal.

    Idempotent on client_order_id via a process-local ledger. A terminal
    refusal (`isError`, or a failing retcode) is REJECTED; a timeout or dropped
    connection is UNKNOWN and is never retried, since with "Manual
    confirmation" on the order can still land after we stop waiting.
    """

    # Generous: with Trading = Manual confirmation the call waits on a dialog
    # in the terminal until someone clicks it.
    TRADE_BUDGET = 150.0

    def __init__(self, data: MT5MCPBroker) -> None:
        self._data = data
        self._ledger: dict[str, OrderResult] = {}
        self._lock = asyncio.Lock()

    @property
    def env(self) -> str:
        return "live"

    @property
    def is_real_money(self) -> bool:
        return True

    async def aclose(self) -> None:  # the client is owned by the data broker
        return None

    async def quote(self, epic: str) -> dict[str, float | None]:
        bid, ask = await self._data.get_quote(epic)
        return {"bid": bid, "ask": ask, "mid": pick_side(bid, ask, "mid")}

    # --- helpers --------------------------------------------------------------

    @staticmethod
    def _now() -> datetime:
        return datetime.now(timezone.utc)

    def _result(self, cid: str, status: OrderStatus, reason: str = "", **kw) -> OrderResult:
        return OrderResult(client_order_id=cid, status=status, reason=reason, resolved_at=self._now(), **kw)

    async def _trade(self, cid: str, tool: str, args: dict) -> tuple[OrderResult | None, dict]:
        """Run a trade tool. Returns (failure, payload): failure is None when
        the terminal accepted it."""
        try:
            resp = await self._data.client.call(tool, args, timeout=self.TRADE_BUDGET)
        except MCPToolError as exc:
            return self._result(cid, OrderStatus.REJECTED, str(exc)), {}
        except Exception as exc:
            log.warning("%s: %s raised (state unknown)", BROKER_ID, tool, exc_info=True)
            return self._result(cid, OrderStatus.UNKNOWN, str(exc)), {}
        payload = resp if isinstance(resp, dict) else {"comment": str(resp)}
        inner = payload.get("result") if isinstance(payload.get("result"), dict) else payload
        retcode = _first(inner, "retcode", "return_code")
        if retcode is not None and int(_f(retcode) or 0) not in _RETCODE_OK:
            reason = _first(inner, "comment", "retcode_description", "description") or f"retcode {retcode}"
            return self._result(cid, OrderStatus.REJECTED, f"{reason} ({retcode})"), inner
        return None, inner

    async def _raw_positions(self) -> dict:
        data = await self._data.call("get_trading_open_positions", {"include_orders": True})
        return data if isinstance(data, dict) else {}

    # --- orders ---------------------------------------------------------------

    async def place_order(self, order: Order) -> OrderResult:
        cid = order.client_order_id
        async with self._lock:
            prior = self._ledger.get(cid)
            if prior is not None:
                return prior
            # Claim the id before sending: a duplicate submit while this one
            # waits on the terminal (possibly on a confirmation dialog) gets
            # this UNKNOWN back instead of sending a second order.
            self._ledger[cid] = self._result(cid, OrderStatus.UNKNOWN, "order in flight")
        try:
            result = await self._place(order)
        except Exception as exc:
            log.warning("%s: place_order raised (state unknown)", BROKER_ID, exc_info=True)
            result = self._result(cid, OrderStatus.UNKNOWN, str(exc))
        async with self._lock:
            self._ledger[cid] = result
        return result

    async def _place(self, order: Order) -> OrderResult:
        cid = order.client_order_id
        lots = await self._data.units_to_lots(order.epic, order.quantity)
        args: dict[str, Any] = {"symbol": order.epic, "volume": lots, "comment": cid[:31]}
        if order.stop_level:
            args["sl"] = order.stop_level
        if order.take_profit_level:
            args["tp"] = order.take_profit_level
        submitted_at = self._now()

        if order.type is OrderType.MARKET:
            args["type"] = order.side.value
            fail, res = await self._trade(cid, "trade_send_market_order", args)
            if fail is None:
                position = _first(res, "position", "position_id", "position_ticket")
                price = _lvl(_first(res, "price", "price_open"))
                if position is not None and price is None:
                    price = await self._fill_price(position)
                result = self._result(
                    cid, OrderStatus.FILLED, str(_first(res, "comment") or ""),
                    deal_reference=_str(_first(res, "order", "order_ticket", "deal")),
                    deal_id=_str(position if position is not None else _first(res, "order", "deal")),
                    filled_quantity=order.quantity,
                    fill_price=price,
                )
        else:
            if order.limit_level is None:
                return self._result(cid, OrderStatus.REJECTED, "limit order requires limit_level")
            args["type"] = f"{order.side.value}_limit"
            args["price"] = order.limit_level
            if order.expires_at is not None:
                args["expiration_type"] = "specified"
                args["expiration_time"] = self._data._to_server(order.expires_at)
            fail, res = await self._trade(cid, "trade_send_pending_order", args)
            if fail is None:
                ticket = _str(_first(res, "order", "order_ticket", "ticket"))
                result = self._result(cid, OrderStatus.PENDING, str(_first(res, "comment") or ""),
                                      deal_reference=ticket, deal_id=ticket)
        result = fail or result
        result.submitted_at = submitted_at
        return result

    async def _fill_price(self, position_id: Any) -> float | None:
        """Open level of the just-filled position; None if it can't be read."""
        try:
            for p in (await self._raw_positions()).get("positions") or []:
                if str(p.get("position_id")) == str(position_id):
                    return _lvl(p.get("price_open"))
        except Exception:
            log.debug("%s: fill-price lookup failed", BROKER_ID, exc_info=True)
        return None

    async def get_account_summary(self) -> dict:
        """Real figures for the dock's account strip. MT5 balance excludes
        floating P&L; equity includes it."""
        info = await self._data.call("get_trading_account_info")
        self._data.note_account_info(info)
        acct = (info or {}).get("account") or {}
        balance, equity = _f(acct.get("balance")), _f(acct.get("equity"))
        return {
            "balance": balance,
            "available": _f(acct.get("margin_free")),
            "profitLoss": equity - balance if equity is not None and balance is not None else None,
            "currency": acct.get("currency"),
            "equity": equity,
            "margin": _f(acct.get("margin")),
        }

    async def get_positions(self, epic: str | None = None) -> list[Position]:
        out: list[Position] = []
        for p in (await self._raw_positions()).get("positions") or []:
            symbol = p.get("symbol")
            if epic is not None and symbol != epic:
                continue
            cs = _f(p.get("contract_size")) or await self._data.contract_size(symbol)
            created = p.get("create_time")
            out.append(Position(
                epic=symbol,
                side=_side(p.get("action")),
                quantity=(_f(p.get("volume")) or 0.0) * cs,
                open_level=_f(p.get("price_open")) or 0.0,
                deal_id=str(p.get("position_id")),
                stop_level=_lvl(p.get("stop_loss")),
                take_profit_level=_lvl(p.get("take_profit")),
                upnl=_upnl(p),
                created_at=self._data._to_utc(created) if created else None,
                mark=_lvl(p.get("price_last")),
            ))
        return out

    async def _position(self, deal_id: str) -> dict | None:
        for p in (await self._raw_positions()).get("positions") or []:
            if str(p.get("position_id")) == str(deal_id):
                return p
        return None

    async def close_position(self, deal_id: str, quantity: float | None = None) -> OrderResult:
        cid = f"close-{deal_id}"
        current = await self._position(deal_id)
        if current is None:
            return self._result(cid, OrderStatus.REJECTED, "position not found")
        symbol = current["symbol"]
        full_units = (_f(current.get("volume")) or 0.0) * (_f(current.get("contract_size")) or 1.0)
        if quantity is not None and quantity < full_units - 1e-9:
            return self._result(cid, OrderStatus.REJECTED, "partial close is not supported by the MT5 MCP")
        fail, res = await self._trade(cid, "trade_close_single_position",
                                      {"symbol": symbol, "position_ticket": int(deal_id)})
        if fail:
            return fail
        return self._result(cid, OrderStatus.FILLED, str(_first(res, "comment") or ""),
                            deal_id=deal_id, deal_reference=_str(_first(res, "order", "deal")),
                            filled_quantity=full_units)

    @staticmethod
    def _sltp_args(cur_sl: float | None, cur_tp: float | None, stop_level, take_profit_level,
                   clear_stop: bool, clear_take_profit: bool) -> dict:
        """Only changed levels: the tool rejects unchanged values, and an
        omitted level is kept. 0 removes a level."""
        args: dict[str, float] = {}
        if clear_stop:
            if cur_sl:
                args["sl"] = 0
        elif stop_level is not None and stop_level != cur_sl:
            args["sl"] = stop_level
        if clear_take_profit:
            if cur_tp:
                args["tp"] = 0
        elif take_profit_level is not None and take_profit_level != cur_tp:
            args["tp"] = take_profit_level
        return args

    async def modify_position(self, deal_id: str, *, stop_level: float | None = None,
                              take_profit_level: float | None = None, clear_stop: bool = False,
                              clear_take_profit: bool = False) -> OrderResult:
        cid = f"modify-{deal_id}"
        current = await self._position(deal_id)
        if current is None:
            return self._result(cid, OrderStatus.REJECTED, "position not found")
        args = self._sltp_args(_lvl(current.get("stop_loss")), _lvl(current.get("take_profit")),
                               stop_level, take_profit_level, clear_stop, clear_take_profit)
        if not args:
            return self._result(cid, OrderStatus.FILLED, "no change", deal_id=deal_id)
        fail, res = await self._trade(cid, "trade_modify_sl_tp",
                                      {"symbol": current["symbol"], "position_ticket": int(deal_id), **args})
        return fail or self._result(cid, OrderStatus.FILLED, str(_first(res, "comment") or ""), deal_id=deal_id)

    def _order_row(self, o: dict) -> dict:
        """Pending-order rows, read defensively: their shape is not yet seen
        on a live account."""
        return {
            "id": _first(o, "order_id", "ticket", "order", "order_ticket"),
            "symbol": o.get("symbol"),
            "side": _side(_first(o, "action", "type")),
            "volume": _f(_first(o, "volume_current", "volume", "volume_initial")) or 0.0,
            "price": _f(_first(o, "price_open", "price")),
            "sl": _lvl(_first(o, "stop_loss", "sl")),
            "tp": _lvl(_first(o, "take_profit", "tp")),
            "created": _first(o, "create_time", "setup_time", "time_setup"),
            "expires": _first(o, "expiration_time", "time_expiration"),
            "contract_size": _f(o.get("contract_size")),
        }

    async def _orders(self) -> list[dict]:
        return [self._order_row(o) for o in (await self._raw_positions()).get("orders") or []]

    def _when(self, v: Any) -> datetime | None:
        if not v or str(v).startswith(("1970", "0")):
            return None
        try:
            return self._data._to_utc(v)
        except ValueError:
            return None

    async def get_working_orders(self, epic: str | None = None) -> list[WorkingOrder]:
        out: list[WorkingOrder] = []
        for o in await self._orders():
            if epic is not None and o["symbol"] != epic:
                continue
            cs = o["contract_size"] or await self._data.contract_size(o["symbol"])
            out.append(WorkingOrder(
                epic=o["symbol"],
                side=o["side"],
                quantity=o["volume"] * cs,
                limit_level=o["price"] or 0.0,
                order_id=str(o["id"]),
                stop_level=o["sl"],
                take_profit_level=o["tp"],
                created_at=self._when(o["created"]),
                expires_at=self._when(o["expires"]),
            ))
        return out

    async def _find_order(self, order_id: str) -> dict | None:
        return next((o for o in await self._orders() if str(o["id"]) == str(order_id)), None)

    async def modify_working_order(self, order_id: str, *, limit_level: float | None = None,
                                   stop_level: float | None = None,
                                   take_profit_level: float | None = None,
                                   clear_stop: bool = False, clear_take_profit: bool = False,
                                   expires_at: datetime | None = None,
                                   clear_expiry: bool = False) -> OrderResult:
        cid = f"modify-{order_id}"
        current = await self._find_order(order_id)
        if current is None:
            return self._result(cid, OrderStatus.REJECTED, "working order not found")
        if limit_level is not None and limit_level != current["price"]:
            return self._result(cid, OrderStatus.REJECTED,
                                "changing a pending order's price is not supported by the MT5 MCP")
        if expires_at is not None or clear_expiry:
            return self._result(cid, OrderStatus.REJECTED,
                                "changing a pending order's expiry is not supported by the MT5 MCP")
        args = self._sltp_args(current["sl"], current["tp"], stop_level, take_profit_level,
                               clear_stop, clear_take_profit)
        if not args:
            return self._result(cid, OrderStatus.FILLED, "no change", deal_id=order_id)
        fail, res = await self._trade(cid, "trade_modify_sl_tp",
                                      {"symbol": current["symbol"], "order_ticket": int(order_id), **args})
        return fail or self._result(cid, OrderStatus.FILLED, str(_first(res, "comment") or ""), deal_id=order_id)

    async def cancel_working_order(self, order_id: str) -> OrderResult:
        cid = f"cancel-{order_id}"
        current = await self._find_order(order_id)
        if current is None:
            return self._result(cid, OrderStatus.REJECTED, "working order not found")
        fail, res = await self._trade(cid, "trade_delete_order",
                                      {"symbol": current["symbol"], "order_ticket": int(order_id)})
        return fail or self._result(cid, OrderStatus.FILLED, str(_first(res, "comment") or ""), deal_id=order_id)


def _str(v: Any) -> str | None:
    return None if v is None else str(v)


def register(registry: "BrokerRegistry", *, url: str, key: str,
             server_utc_offset_minutes: int = 0) -> MT5MCPBroker:
    """Wire the local-terminal account: "mt5-self" data, "mt5-self:paper" and
    the real-money "mt5-self:live". Caller gates this on mt5mcp_settings.has()."""
    from auto_trader.brokers import paper_exec

    broker = MT5MCPBroker(url=url, key=key, server_utc_offset_minutes=server_utc_offset_minutes)
    registry.add_data(BROKER_ID, broker)
    paper_exec.register(registry, broker, broker_id=BROKER_ID)
    registry.add_exec(f"{BROKER_ID}:live", MT5MCPExecutionBroker(broker))
    broker.start_display_name_fetch()
    return broker
