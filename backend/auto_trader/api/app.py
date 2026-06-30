"""FastAPI surface for the frontend.

Milestone 1 is request/response only (no WebSocket): fetch candles, run a
backtest, return candles + fills + trades + equity for the chart to render.

Run:  uvicorn auto_trader.api.app:app --reload --port 8000
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager, suppress
from datetime import datetime, timezone
from typing import Any, TypeVar

log = logging.getLogger(__name__)

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from auto_trader.brokers import ig_stream
from auto_trader.brokers.base import ExecutionBroker, MarketDataBroker
from auto_trader.brokers.capital_stream import (
    SECONDS_INTERVALS,
    StreamFatalError,
    stream_candles,
    stream_tick_candles,
)
from auto_trader.brokers.ig import IGAllowanceExceeded, IGBroker
from auto_trader.brokers.paper_exec import PaperExecutionBroker
from auto_trader.brokers.registry import BrokerRegistry, build_registry
from auto_trader.core.broker_health import (
    BrokerHealth,
    BrokerTimeout,
    BrokerUnavailable,
)
from auto_trader.core.models import (
    Candle,
    Order,
    OrderResult,
    OrderSource,
    OrderStatus,
    OrderType,
    Resolution,
    Side,
)
from auto_trader.core.state_store import STATE_STORE
from auto_trader.core.tick_store import TICK_STORE
from auto_trader.core.candle_cache import CANDLE_CACHE
from auto_trader.engine.backtest import BacktestEngine
from auto_trader.strategy.sma_cross import SmaCross

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
    while True:
        await asyncio.sleep(_TRIGGER_INTERVAL)
        try:
            if await broker.check_triggers():
                await _broadcast_state(
                    {"key": f"{TRADES_DIRTY_PREFIX}{account}", "origin": ""}
                )
        except Exception:  # never let one bad tick kill the driver
            log.exception("paper trigger check failed")


def _configure_logging() -> None:
    """Prefix every log line with a timestamp. uvicorn's default access/error
    formatters omit it; we override them in place, and give the app's own
    `auto_trader.*` logger a timestamped handler — so request logs AND app messages
    are all timestamped. Run from lifespan (after uvicorn has installed its
    handlers) so we override the live formatters."""
    fmt = logging.Formatter(
        "%(asctime)s %(levelname)s %(name)s %(message)s", datefmt="%Y-%m-%d %H:%M:%S"
    )
    for name in ("uvicorn", "uvicorn.access", "uvicorn.error"):
        for handler in logging.getLogger(name).handlers:
            handler.setFormatter(fmt)
    app_log = logging.getLogger("auto_trader")
    if not app_log.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(fmt)
        app_log.addHandler(handler)
        app_log.setLevel(logging.INFO)
        app_log.propagate = False  # the handler above logs it; don't double via root


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _registry
    _configure_logging()
    _registry = build_registry()
    # Periodic batch-flush of recorded ticks to sqlite (sub-minute history).
    flusher = asyncio.create_task(TICK_STORE.run_flusher())
    # Paper limit/SL/TP trigger driver — one per registered paper executor, so
    # every broker's paper account triggers (not just Capital's). Discovered by
    # type from the registry, so adding a broker needs no edit here. (A paper
    # executor only fills resting orders for epics with a live tick, so IG paper
    # triggers wait on IG streaming — deferred — while Capital's work today.)
    triggers = [
        asyncio.create_task(_run_paper_triggers(b, key))
        for key, b in _registry.exec.items()
        if isinstance(b, PaperExecutionBroker)
    ]
    try:
        yield
    finally:
        for task in (flusher, *triggers):
            task.cancel()
        with suppress(asyncio.CancelledError):
            await flusher  # lets run_flusher do its final flush
        for task in triggers:
            with suppress(asyncio.CancelledError):
                await task
        await _registry.aclose()
        _registry = None


app = FastAPI(title="Auto Trader API", version="0.1.0", lifespan=lifespan)

# Vite dev server origins.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# --- response models (lightweight-charts friendly: unix-second timestamps) ---


class CandleDTO(BaseModel):
    time: int
    open: float
    high: float
    low: float
    close: float
    volume: float


class MarkerDTO(BaseModel):
    time: int
    side: str
    price: float
    reason: str


class TradeDTO(BaseModel):
    side: str
    quantity: float
    entry_time: int
    entry_price: float
    exit_time: int
    exit_price: float
    pnl: float


class EquityDTO(BaseModel):
    time: int
    value: float


class MarketDTO(BaseModel):
    epic: str
    name: str | None
    status: str | None
    type: str | None = None
    pricePrecision: int | None = None


class BacktestResponse(BaseModel):
    epic: str
    resolution: str
    candles: list[CandleDTO]
    markers: list[MarkerDTO]
    trades: list[TradeDTO]
    equity: list[EquityDTO]
    summary: dict


def _ts(dt: datetime) -> int:
    return int(dt.timestamp())


def _candle_dto(c: Candle) -> CandleDTO:
    return CandleDTO(
        time=_ts(c.time),
        open=c.open,
        high=c.high,
        low=c.low,
        close=c.close,
        volume=c.volume,
    )


def _parse_resolution(raw: str) -> Resolution:
    """Validate a native Capital resolution string (422 on anything else).

    Replaces FastAPI's automatic enum coercion, which we dropped so seconds
    intervals can be handled explicitly instead of 422-ing before the handler."""
    try:
        return Resolution(raw)
    except ValueError:
        raise HTTPException(422, f"unknown resolution '{raw}'") from None


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}


@app.get("/api/brokers")
async def brokers() -> dict:
    # Selector payload: registered data brokers + execution accounts. The frontend
    # populates the toolbar broker/account dropdown from this.
    assert _registry is not None, "registry not initialised"
    return _registry.describe()


@app.get("/api/markets", response_model=list[MarketDTO])
async def markets(
    q: str = Query(""), broker_id: str = Query("capital", alias="broker")
) -> list[MarketDTO]:
    # Keyword search. The symbol-search modal uses this while the user types; its
    # default/category browsing comes from /api/markets/all (filtered client-side).
    broker = get_data(broker_id)  # 404 on unknown broker — surface, don't mask as 502
    found = await guarded(broker_id, lambda: broker.search_markets(q), "market search")
    return [MarketDTO(**m) for m in found]


@app.get("/api/markets/all", response_model=list[MarketDTO])
async def all_markets(
    broker_id: str = Query("capital", alias="broker"),
) -> list[MarketDTO]:
    # The full instrument catalogue (~4000), one upstream call. The modal caches
    # this and filters by instrumentType for its category chips.
    broker = get_data(broker_id)
    found = await guarded(broker_id, lambda: broker.all_markets(), "market list")
    return [MarketDTO(**m) for m in found]


@app.get("/api/market/{epic}")
async def market_meta(
    epic: str, broker_id: str = Query("capital", alias="broker")
) -> dict[str, object]:
    # Display precision + open/closed status for one epic, from the platform's own
    # single-market snapshot (one upstream call). The chart calls this on load so a
    # symbol persisted without precision (the bulk list omits it, e.g. OIL_CRUDE)
    # still renders at the right scale, and polls it so the tab badge / price label
    # flip when the market closes while the chart is open.
    broker = get_data(broker_id)
    meta = await guarded(broker_id, lambda: broker.get_market_meta(epic), "market lookup")
    meta = meta or {}
    return {
        "epic": epic,
        "pricePrecision": meta.get("pricePrecision"),
        # `closed` is derived from the instrument's opening hours (authoritative on
        # both demo and live); `status` is the raw marketStatus, kept for reference.
        "closed": meta.get("closed"),
        "nextOpen": meta.get("nextOpen"),
        "status": meta.get("status"),
    }


@app.get("/api/market/{epic}/details")
async def market_details(
    epic: str, broker_id: str = Query("capital", alias="broker")
) -> dict[str, object]:
    # Full broker-provided instrument detail (instrument + dealingRules + snapshot),
    # passed through verbatim for the chart's instrument-details modal. Fetched once
    # on modal-open — NOT polled (unlike /api/market/{epic}); the snapshot section is
    # a point-in-time quote and that's fine for a click-to-open view.
    broker = get_data(broker_id)
    detail = await guarded(broker_id, lambda: broker.get_market_detail(epic), "market lookup")
    if detail is None:
        raise HTTPException(status_code=404, detail=f"unknown market '{epic}'")
    return detail


@app.get("/api/favorites", response_model=list[MarketDTO])
async def favorites(
    broker_id: str = Query("capital", alias="broker"),
) -> list[MarketDTO]:
    # The account's FAVORITES watchlist — the modal's opening view.
    broker = get_data(broker_id)
    found = await guarded(broker_id, lambda: broker.favorites(), "favorites")
    return [MarketDTO(**m) for m in found]


@app.put("/api/favorites/{epic}", status_code=204)
async def add_favorite(
    epic: str, broker_id: str = Query("capital", alias="broker")
) -> None:
    # Add an epic to the FAVORITES watchlist (creates the list on first add).
    broker = get_data(broker_id)
    try:
        await broker.add_favorite(epic)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"add favorite failed: {e}") from e


@app.delete("/api/favorites/{epic}", status_code=204)
async def remove_favorite(
    epic: str, broker_id: str = Query("capital", alias="broker")
) -> None:
    # Remove an epic from the FAVORITES watchlist.
    broker = get_data(broker_id)
    try:
        await broker.remove_favorite(epic)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"remove favorite failed: {e}") from e


# --- order execution (paper now; demo/live later) ----------------------------


class OrderRequest(BaseModel):
    epic: str
    side: str  # "buy" | "sell"
    quantity: float
    client_order_id: str  # caller-generated idempotency key (UUID)
    account: str = "capital:paper"  # registry key "{broker_id}:{env}"
    source: str = "manual"  # "manual" | "strategy"
    type: str = "market"  # "market" | "limit"
    limit_level: float | None = None  # required when type == "limit"
    stop_level: float | None = None
    take_profit_level: float | None = None
    confirm: bool = False  # required for real-money (live) orders


class LevelsRequest(BaseModel):
    # Body for editing an open position's or resting order's levels. None = leave
    # unchanged (a combined Apply sends whichever lines the user dragged). To
    # REMOVE a level (the edit form's toggle-off), set its clear_* flag — None
    # alone can't mean "clear" without breaking partial drag updates.
    limit_level: float | None = None
    stop_level: float | None = None
    take_profit_level: float | None = None
    clear_stop: bool = False
    clear_take_profit: bool = False


class WorkingOrderDTO(BaseModel):
    epic: str
    side: str
    quantity: float
    limit_level: float
    order_id: str
    stop_level: float | None = None
    take_profit_level: float | None = None
    created_at: datetime | None = None


class OrderResultDTO(BaseModel):
    client_order_id: str
    status: str
    deal_reference: str | None = None
    deal_id: str | None = None
    filled_quantity: float = 0.0
    fill_price: float | None = None
    reason: str = ""


class PositionDTO(BaseModel):
    epic: str
    side: str
    quantity: float
    open_level: float
    deal_id: str
    stop_level: float | None = None
    take_profit_level: float | None = None
    upnl: float | None = None
    created_at: datetime | None = None
    leverage: float | None = None
    margin: float | None = None


def _order_result_dto(r: OrderResult) -> OrderResultDTO:
    return OrderResultDTO(
        client_order_id=r.client_order_id,
        status=r.status.value,
        deal_reference=r.deal_reference,
        deal_id=r.deal_id,
        filled_quantity=r.filled_quantity,
        fill_price=r.fill_price,
        reason=r.reason,
    )


def _position_dto(p) -> PositionDTO:
    return PositionDTO(
        epic=p.epic,
        side=p.side.value,
        quantity=p.quantity,
        open_level=p.open_level,
        deal_id=p.deal_id,
        stop_level=p.stop_level,
        take_profit_level=p.take_profit_level,
        upnl=p.upnl,
        created_at=p.created_at,
        leverage=p.leverage,
        margin=p.margin,
    )


@app.post("/api/orders", response_model=OrderResultDTO)
async def place_order(req: OrderRequest) -> OrderResultDTO:
    try:
        side = Side(req.side)
        source = OrderSource(req.source)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e

    broker = get_exec(req.account)

    # Real-money safety gates (no live executor exists in P1, but enforce here so
    # the contract holds the moment one is added):
    if broker.is_real_money:
        if not req.confirm:
            raise HTTPException(
                status_code=422, detail="live orders require confirm=true"
            )
        if source is OrderSource.STRATEGY:
            raise HTTPException(
                status_code=403, detail="automated orders are not allowed on live"
            )

    try:
        order_type = OrderType(req.type)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e

    order = Order(
        epic=req.epic,
        side=side,
        quantity=req.quantity,
        client_order_id=req.client_order_id,
        type=order_type,
        limit_level=req.limit_level,
        stop_level=req.stop_level,
        take_profit_level=req.take_profit_level,
        source=source,
    )
    try:
        result = await broker.place_order(order)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"order failed: {e}") from e
    if result.status is OrderStatus.REJECTED:
        raise HTTPException(status_code=422, detail=result.reason or "order rejected")
    return _order_result_dto(result)


class QuoteDTO(BaseModel):
    bid: float | None = None
    ask: float | None = None
    mid: float | None = None


@app.get("/api/quote/{epic}", response_model=QuoteDTO)
async def quote(epic: str, account: str = Query("capital:paper")) -> QuoteDTO:
    broker = get_exec(account)
    q = getattr(broker, "quote", None)
    if q is None:  # only the paper executor exposes a synthetic quote in P1
        raise HTTPException(status_code=404, detail="quote unavailable for account")
    try:
        return QuoteDTO(**await q(epic))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"quote failed: {e}") from e


class AccountSummaryDTO(BaseModel):
    # Real per-account figures from the broker (live dealing accounts only). Paper/IG
    # accounts have no summary → 404, and the dock falls back to its configured paper
    # balance. All optional so a partial broker payload still renders.
    balance: float | None = None
    available: float | None = None
    deposit: float | None = None
    profitLoss: float | None = None
    currency: str | None = None


@app.get("/api/account", response_model=AccountSummaryDTO)
async def account_summary(account: str = Query("capital:paper")) -> AccountSummaryDTO:
    """The account's real balance/available/currency (live dealing accounts). 404 when
    the account has no real summary (paper sim), so the dock keeps its paper figures."""
    broker = get_exec(account)
    fn = getattr(broker, "get_account_summary", None)
    if fn is None:
        raise HTTPException(status_code=404, detail="account summary unavailable")
    try:
        return AccountSummaryDTO(**await fn())
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"account summary failed: {e}") from e


@app.get("/api/positions", response_model=list[PositionDTO])
async def positions(
    account: str = Query("capital:paper"), epic: str = Query("")
) -> list[PositionDTO]:
    broker = get_exec(account)
    try:
        found = await broker.get_positions(epic or None)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"positions failed: {e}") from e
    return [_position_dto(p) for p in found]


@app.delete("/api/positions/{deal_id}", response_model=OrderResultDTO)
async def close_position(
    deal_id: str,
    account: str = Query("capital:paper"),
    quantity: float | None = Query(None),
) -> OrderResultDTO:
    broker = get_exec(account)
    try:
        result = await broker.close_position(deal_id, quantity)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"close failed: {e}") from e
    if result.status is OrderStatus.REJECTED:
        raise HTTPException(status_code=404, detail=result.reason or "close rejected")
    return _order_result_dto(result)


@app.put("/api/positions/{deal_id}", response_model=OrderResultDTO)
async def modify_position(
    deal_id: str, req: LevelsRequest, account: str = Query("capital:paper")
) -> OrderResultDTO:
    # Edit an open position's SL/TP (the combined Apply after dragging lines).
    broker = get_exec(account)
    try:
        result = await broker.modify_position(
            deal_id,
            stop_level=req.stop_level,
            take_profit_level=req.take_profit_level,
            clear_stop=req.clear_stop,
            clear_take_profit=req.clear_take_profit,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"modify failed: {e}") from e
    if result.status is OrderStatus.REJECTED:
        raise HTTPException(status_code=422, detail=result.reason or "modify rejected")
    return _order_result_dto(result)


def _working_order_dto(w) -> WorkingOrderDTO:
    return WorkingOrderDTO(
        epic=w.epic,
        side=w.side.value,
        quantity=w.quantity,
        limit_level=w.limit_level,
        order_id=w.order_id,
        stop_level=w.stop_level,
        take_profit_level=w.take_profit_level,
        created_at=w.created_at,
    )


@app.get("/api/orders/working", response_model=list[WorkingOrderDTO])
async def working_orders(
    account: str = Query("capital:paper"), epic: str = Query("")
) -> list[WorkingOrderDTO]:
    broker = get_exec(account)
    try:
        found = await broker.get_working_orders(epic or None)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"working orders failed: {e}") from e
    return [_working_order_dto(w) for w in found]


@app.put("/api/orders/working/{order_id}", response_model=OrderResultDTO)
async def modify_working_order(
    order_id: str, req: LevelsRequest, account: str = Query("capital:paper")
) -> OrderResultDTO:
    broker = get_exec(account)
    try:
        result = await broker.modify_working_order(
            order_id,
            limit_level=req.limit_level,
            stop_level=req.stop_level,
            take_profit_level=req.take_profit_level,
            clear_stop=req.clear_stop,
            clear_take_profit=req.clear_take_profit,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"modify failed: {e}") from e
    if result.status is OrderStatus.REJECTED:
        raise HTTPException(status_code=422, detail=result.reason or "modify rejected")
    return _order_result_dto(result)


@app.delete("/api/orders/working/{order_id}", response_model=OrderResultDTO)
async def cancel_working_order(
    order_id: str, account: str = Query("capital:paper")
) -> OrderResultDTO:
    broker = get_exec(account)
    try:
        result = await broker.cancel_working_order(order_id)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"cancel failed: {e}") from e
    if result.status is OrderStatus.REJECTED:  # unknown order
        raise HTTPException(status_code=404, detail=result.reason or "no such order")
    return _order_result_dto(result)


# --- chart workspace state (localStorage mirror, backend-wins-on-load sync) --


class StateValue(BaseModel):
    # The PUT body. `value` is any JSON the frontend stored under this key — we
    # persist it opaquely (never inspect it), exactly like a localStorage value.
    value: Any


# Live fan-out: every browser tab/device holding the app open subscribes here, so a
# PUT/DELETE from one is pushed to the others without a reload. This is a simple
# pub/sub registry (unlike /ws/candles, which is per-connection upstream streaming).
# `origin` on each write identifies the writing tab so it can ignore its own echo.
_state_subscribers: set[WebSocket] = set()

# Max seconds to wait on one client's send before dropping it as too slow/stuck, so
# fan-out (and the writer's request that awaits it) can't be held hostage by one socket.
_BROADCAST_SEND_TIMEOUT = 5.0


async def _broadcast_state(message: dict[str, Any]) -> None:
    """Push one change to every subscriber. Sends CONCURRENTLY with a per-client
    timeout so a slow/dead client can't block or break the writer's request: a serial
    `await ws.send_json` loop let one slow-but-alive socket apply backpressure and
    stall the PUT/DELETE that awaits this. Clients that error OR time out are dropped."""

    async def _send(ws: WebSocket) -> WebSocket | None:
        try:
            await asyncio.wait_for(ws.send_json(message), timeout=_BROADCAST_SEND_TIMEOUT)
            return None
        except Exception:
            return ws  # errored or too slow → drop it

    # Snapshot the set: a concurrent /ws/state connect/disconnect would otherwise
    # mutate it during iteration ("Set changed size during iteration").
    results = await asyncio.gather(*(_send(ws) for ws in list(_state_subscribers)))
    for ws in results:
        if ws is not None:
            _state_subscribers.discard(ws)


@app.get("/api/state")
async def get_state() -> dict[str, Any]:
    """The whole workspace snapshot ({key: parsed JSON value}) for one startup
    hydrate. Keys are the frontend's exact localStorage keys; values are parsed
    back from their stored JSON strings."""
    raw = await STATE_STORE.get_all()
    out: dict[str, Any] = {}
    for k, v in raw.items():
        try:
            out[k] = json.loads(v)
        except json.JSONDecodeError:
            continue  # skip a corrupt row rather than fail the whole hydrate
    return out


@app.put("/api/state/{key}", status_code=204)
async def put_state(
    key: str, body: StateValue, origin: str = Query("")
) -> None:
    """Upsert one key. Mirrors a single localStorage.setItem from the browser, then
    pushes it to other tabs. `origin` is the writing tab's id (it ignores its echo)."""
    await STATE_STORE.set(key, json.dumps(body.value))
    await _broadcast_state({"key": key, "value": body.value, "origin": origin})


@app.delete("/api/state/{key}", status_code=204)
async def delete_state(key: str, origin: str = Query("")) -> None:
    """Remove one key (mirrors localStorage.removeItem / purgeScope), then push the
    removal to other tabs."""
    await STATE_STORE.delete(key)
    await _broadcast_state({"key": key, "deleted": True, "origin": origin})


@app.websocket("/ws/state")
async def ws_state(websocket: WebSocket) -> None:
    """Subscribe to workspace-state changes from other tabs/devices. Each message
    is {key, value, origin} for an upsert or {key, deleted:true, origin} for a
    removal. The client applies it to localStorage and ignores its own origin."""
    await websocket.accept()
    _state_subscribers.add(websocket)
    try:
        # We never expect client messages; receive() returns/raises on disconnect.
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        _state_subscribers.discard(websocket)


@app.get("/api/candles", response_model=list[CandleDTO])
async def candles(
    epic: str = Query("EURUSD"),
    resolution: str = Query(Resolution.MINUTE_5.value),
    bars: int = Query(500, ge=1, le=1000),
    from_ts: int | None = Query(None, description="window start, unix seconds"),
    to_ts: int | None = Query(None, description="window end, unix seconds"),
    price_side: str = Query("mid", alias="priceSide", pattern="^(bid|mid|ask)$"),
    broker_id: str = Query("capital", alias="broker"),
) -> list[CandleDTO]:
    """Candles for an epic. With from_ts/to_ts -> that date window (used by the
    chart's scroll-back). Without -> most-recent `bars` (weekend-proof).

    Sub-minute (seconds) intervals have no history endpoint upstream, so they're
    served from our own tick recorder (warmed while the epic is streamed) and
    extended live over the socket. Scroll-back (from_ts/to_ts) isn't supported
    for them — the chart disables it for live-only intervals."""
    if resolution in SECONDS_INTERVALS:
        return [
            _candle_dto(c)
            for c in await TICK_STORE.bars(epic, SECONDS_INTERVALS[resolution], bars)
        ]
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
    # A date window may legitimately be empty (market closed); only 404 when no
    # window was requested at all (likely a bad epic).
    if not loaded and from_ts is None:
        raise HTTPException(404, f"no data for epic '{epic}' (unknown epic or no history)")
    return [_candle_dto(c) for c in loaded]


@app.get("/api/backtest", response_model=BacktestResponse)
async def backtest(
    epic: str = Query("EURUSD"),
    resolution: Resolution = Query(Resolution.MINUTE_5),
    bars: int = Query(500, ge=1, le=1000),
    fast: int = Query(9, ge=1),
    slow: int = Query(21, ge=2),
    quantity: float = Query(1.0, gt=0),
    commission_per_side: float = Query(0.0, ge=0),
    slippage: float = Query(0.0, ge=0),
    broker_id: str = Query("capital", alias="broker"),
) -> BacktestResponse:
    if fast >= slow:
        raise HTTPException(422, "fast period must be < slow period")
    # Same breaker as the candles route: bounds the call, fast-fails a down broker
    # so it can't starve the others, and maps IG's spent allowance to an actionable
    # 429 (not a generic 502). Recent-bars mode is weekend-proof (see candles).
    broker = get_data(broker_id)  # 404 on unknown broker (not a breaker failure)
    candle_data = await guarded(
        broker_id,
        lambda: broker.get_recent_candles(epic, resolution, bars),
        "backtest data fetch",
    )
    if not candle_data:
        raise HTTPException(404, f"no data for epic '{epic}' (unknown epic or no history)")

    strategy = SmaCross(fast=fast, slow=slow, quantity=quantity)
    result = BacktestEngine(
        strategy,
        commission_per_side=commission_per_side,
        slippage=slippage,
    ).run(candle_data)

    return BacktestResponse(
        epic=epic,
        resolution=resolution.value,
        candles=[_candle_dto(c) for c in candle_data],
        markers=[
            MarkerDTO(time=_ts(f.time), side=f.side.value, price=f.price, reason=f.reason)
            for f in result.fills
        ],
        trades=[
            TradeDTO(
                side=t.side.value,
                quantity=t.quantity,
                entry_time=_ts(t.entry_time),
                entry_price=t.entry_price,
                exit_time=_ts(t.exit_time),
                exit_price=t.exit_price,
                pnl=t.pnl,
            )
            for t in result.trades
        ],
        equity=[EquityDTO(time=_ts(p.time), value=p.equity) for p in result.equity],
        summary=result.summary(),
    )


@app.websocket("/ws/candles")
async def ws_candles(websocket: WebSocket) -> None:
    """Relay live mid-price candles for ?epic=&resolution= to the browser.

    Each forming bar is sent as {"type":"candle","candle":{time,open,...}}. The
    upstream Capital.com stream + ping task are torn down when the browser
    disconnects (stream_candles' finally cancels the ping; closing the generator
    closes the upstream socket)."""
    await websocket.accept()
    epic = websocket.query_params.get("epic", "")
    res_raw = websocket.query_params.get("resolution", Resolution.MINUTE.value)
    broker_id = websocket.query_params.get("broker", "capital")
    # Bid (sell) / mid / ask (buy) — global chart setting; unknown values fall
    # back to mid in pick_side, so a bad param can't break the stream.
    price_side = websocket.query_params.get("priceSide", "mid")
    # Resolve the data broker by id. An unknown broker can never succeed on retry,
    # so it's fatal — the client stops reconnecting to the same bad URL.
    assert _registry is not None, "registry not initialised"
    broker = _registry.data.get(broker_id)
    if broker is None:
        await websocket.send_json(
            {"type": "error", "detail": f"unknown broker {broker_id}", "fatal": True}
        )
        await websocket.close()
        return
    # Only brokers with a live stream wired can be streamed. A non-streaming broker
    # would otherwise be dialed against the wrong upstream, looping reconnects. Send
    # a fatal so the client stops retrying; the chart still shows its REST history.
    if not broker.supports_streaming:
        await websocket.send_json(
            {"type": "error", "detail": f"{broker_id} has no live stream", "fatal": True}
        )
        await websocket.close()
        return

    async def _fatal(detail: str) -> None:
        await websocket.send_json({"type": "error", "detail": detail, "fatal": True})
        await websocket.close()

    is_ig = isinstance(broker, IGBroker)
    # Sub-minute intervals are built by bucketing the tick stream; native ones merge
    # the OHLC + tick channels. Sub-minute is mid-only (served from the single-price
    # TICK_STORE), so price_side intentionally doesn't apply there.
    if res_raw in SECONDS_INTERVALS:
        if is_ig:
            # IG sub-minute streaming + tick history aren't built yet (the chart
            # disables scroll-back for these anyway); stop the client retrying.
            return await _fatal(f"{broker_id}: seconds intervals not streamed yet")
        stream = stream_tick_candles(broker, epic, SECONDS_INTERVALS[res_raw])
    else:
        try:
            resolution = Resolution(res_raw)
        except ValueError:
            # A malformed resolution param can never succeed on retry — fatal, so
            # the client stops reconnecting to the same bad URL.
            return await _fatal(f"bad resolution {res_raw}")
        if is_ig:
            if not ig_stream.streamable(resolution.seconds):
                # IG streams intraday only (daily bars open at 22–23:00 UTC, so a
                # live midnight bucket wouldn't align with REST history).
                return await _fatal(f"{broker_id}: {res_raw} is not streamed live")
            stream = ig_stream.stream_candles(broker, epic, resolution, price_side)
        else:
            stream = stream_candles(broker, epic, resolution, price_side)

    async def forward() -> None:
        try:
            async for bar in stream:
                # bid/ask ride alongside the candle so the client can draw the optional
                # bid & ask price lines; they're null until the first quote names them.
                await websocket.send_json(
                    {
                        "type": "candle",
                        "candle": _candle_dto(bar.candle).model_dump(),
                        "bid": bar.bid,
                        "ask": bar.ask,
                    }
                )
        except StreamFatalError as e:
            # A permanent stream fault (e.g. an unknown/invalid epic — a persisted
            # Capital symbol viewed under IG) would fail identically on every
            # reconnect. Send fatal=True so the client STOPS retrying instead of
            # storming the socket open/closed forever; the chart keeps its REST view.
            with suppress(Exception):
                await websocket.send_json(
                    {"type": "error", "detail": str(e), "fatal": True}
                )
        except RuntimeError as e:
            # stream_candles/stream_tick_candles raise RuntimeError after
            # RECONNECT_MAX_FAILURES. That bundles a permanent fault (missing creds)
            # with a *recoverable* one (a sustained network/Capital outage) — and at
            # this point the two are indistinguishable. Surface it as a RECOVERABLE
            # error frame (fatal=False): the client reports the feed down but keeps
            # reconnecting, so the chart self-heals once connectivity returns instead
            # of staying frozen until a full page reload. A genuinely-bad config then
            # also reconnects forever (a slow ~6.5-min server-side cycle, not a
            # storm), surfacing in the server logs rather than wedging the UI.
            with suppress(Exception):
                await websocket.send_json(
                    {"type": "error", "detail": str(e), "fatal": False}
                )

    async def watch_disconnect() -> None:
        # We never expect client messages; receive() returns/raises on disconnect.
        try:
            while True:
                await websocket.receive_text()
        except WebSocketDisconnect:
            return

    forward_task = asyncio.create_task(forward())
    watch_task = asyncio.create_task(watch_disconnect())
    try:
        # Whichever finishes first (stream error or client disconnect) ends the relay.
        await asyncio.wait(
            {forward_task, watch_task}, return_when=asyncio.FIRST_COMPLETED
        )
    finally:
        # Cancelling forward_task unwinds the generator: its `async with` closes
        # the upstream socket and its `finally` cancels the ping task. Awaiting
        # the cancellation lets that cleanup complete (and avoids "generator
        # already running" from racing an explicit aclose).
        forward_task.cancel()
        watch_task.cancel()
        await asyncio.gather(forward_task, watch_task, return_exceptions=True)
