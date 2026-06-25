"""FastAPI surface for the frontend.

Milestone 1 is request/response only (no WebSocket): fetch candles, run a
backtest, return candles + fills + trades + equity for the chart to render.

Run:  uvicorn auto_trader.api.app:app --reload --port 8000
"""

from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager, suppress
from datetime import datetime, timezone
from typing import Any

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from auto_trader.brokers.capital import CapitalComBroker
from auto_trader.brokers.capital_stream import (
    SECONDS_INTERVALS,
    stream_candles,
    stream_tick_candles,
)
from auto_trader.core.models import Candle, Resolution
from auto_trader.core.state_store import STATE_STORE
from auto_trader.core.tick_store import TICK_STORE
from auto_trader.engine.backtest import BacktestEngine
from auto_trader.strategy.sma_cross import SmaCross

# A single shared broker reuses its ~10-min session across requests. Creating a
# new one per request would re-authenticate every time and trip the session
# rate limit (1 req/s on /session).
_broker: CapitalComBroker | None = None


def get_broker() -> CapitalComBroker:
    assert _broker is not None, "broker not initialised"
    return _broker


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _broker
    _broker = CapitalComBroker()
    # Periodic batch-flush of recorded ticks to sqlite (sub-minute history).
    flusher = asyncio.create_task(TICK_STORE.run_flusher())
    try:
        yield
    finally:
        flusher.cancel()
        with suppress(asyncio.CancelledError):
            await flusher  # lets run_flusher do its final flush
        await _broker.aclose()
        _broker = None


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


async def _load_candles(
    epic: str, resolution: Resolution, bars: int, price_side: str = "mid"
) -> list[Candle]:
    """Most-recent `bars` candles. Recent-bars mode is weekend-proof: a fixed
    date window returns 404 when the market is closed, whereas `max` without
    from/to always returns the latest available data."""
    return await get_broker().get_recent_candles(epic, resolution, bars, price_side)


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


@app.get("/api/markets", response_model=list[MarketDTO])
async def markets(q: str = Query("")) -> list[MarketDTO]:
    # Keyword search. The symbol-search modal uses this while the user types; its
    # default/category browsing comes from /api/markets/all (filtered client-side).
    try:
        found = await get_broker().search_markets(q)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"market search failed: {e}") from e
    return [MarketDTO(**m) for m in found]


@app.get("/api/markets/all", response_model=list[MarketDTO])
async def all_markets() -> list[MarketDTO]:
    # The full instrument catalogue (~4000), one upstream call. The modal caches
    # this and filters by instrumentType for its category chips.
    try:
        found = await get_broker().all_markets()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"market list failed: {e}") from e
    return [MarketDTO(**m) for m in found]


@app.get("/api/market/{epic}")
async def market_meta(epic: str) -> dict[str, object]:
    # Display precision + open/closed status for one epic, from the platform's own
    # single-market snapshot (one upstream call). The chart calls this on load so a
    # symbol persisted without precision (the bulk list omits it, e.g. OIL_CRUDE)
    # still renders at the right scale, and polls it so the tab badge / price label
    # flip when the market closes while the chart is open.
    try:
        meta = await get_broker().get_market_meta(epic)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"market lookup failed: {e}") from e
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
async def market_details(epic: str) -> dict[str, object]:
    # Full broker-provided instrument detail (instrument + dealingRules + snapshot),
    # passed through verbatim for the chart's instrument-details modal. Fetched once
    # on modal-open — NOT polled (unlike /api/market/{epic}); the snapshot section is
    # a point-in-time quote and that's fine for a click-to-open view.
    try:
        detail = await get_broker().get_market_detail(epic)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"market lookup failed: {e}") from e
    if detail is None:
        raise HTTPException(status_code=404, detail=f"unknown market '{epic}'")
    return detail


@app.get("/api/favorites", response_model=list[MarketDTO])
async def favorites() -> list[MarketDTO]:
    # The account's FAVORITES watchlist — the modal's opening view.
    try:
        found = await get_broker().favorites()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"favorites failed: {e}") from e
    return [MarketDTO(**m) for m in found]


@app.put("/api/favorites/{epic}", status_code=204)
async def add_favorite(epic: str) -> None:
    # Add an epic to the FAVORITES watchlist (creates the list on first add).
    try:
        await get_broker().add_favorite(epic)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"add favorite failed: {e}") from e


@app.delete("/api/favorites/{epic}", status_code=204)
async def remove_favorite(epic: str) -> None:
    # Remove an epic from the FAVORITES watchlist.
    try:
        await get_broker().remove_favorite(epic)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"remove favorite failed: {e}") from e


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
    try:
        if from_ts is not None and to_ts is not None:
            # Validate the window before hitting the broker: an out-of-range
            # epoch would crash datetime.fromtimestamp (surfaced as a confusing
            # 502), and an inverted window would silently return an empty 200.
            # Both are client errors -> 422.
            if from_ts > to_ts:
                raise HTTPException(422, "from_ts must be <= to_ts")
            try:
                start = datetime.fromtimestamp(from_ts, tz=timezone.utc)
                end = datetime.fromtimestamp(to_ts, tz=timezone.utc)
            except (OverflowError, OSError, ValueError) as e:
                raise HTTPException(422, f"from_ts/to_ts out of range: {e}") from e
            loaded = await get_broker().get_candles(epic, resolution, start, end, price_side)
        else:
            loaded = await _load_candles(epic, resolution, bars, price_side)
    except HTTPException:
        raise  # already a deliberate client error (e.g. 422 validation); don't mask as 502
    except Exception as e:  # surface broker/auth errors as 502
        raise HTTPException(status_code=502, detail=f"data fetch failed: {e}") from e
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
) -> BacktestResponse:
    if fast >= slow:
        raise HTTPException(422, "fast period must be < slow period")
    try:
        candle_data = await _load_candles(epic, resolution, bars)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"data fetch failed: {e}") from e
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
    # Bid (sell) / mid / ask (buy) — global chart setting; unknown values fall
    # back to mid in pick_side, so a bad param can't break the stream.
    price_side = websocket.query_params.get("priceSide", "mid")
    # Sub-minute intervals are built by bucketing the tick stream; native ones
    # merge the OHLC + tick channels. Sub-minute is mid-only (served from the
    # single-price TICK_STORE), so price_side intentionally doesn't apply there.
    if res_raw in SECONDS_INTERVALS:
        stream = stream_tick_candles(get_broker(), epic, SECONDS_INTERVALS[res_raw])
    else:
        try:
            resolution = Resolution(res_raw)
        except ValueError:
            await websocket.send_json({"type": "error", "detail": f"bad resolution {res_raw}"})
            await websocket.close()
            return
        stream = stream_candles(get_broker(), epic, resolution, price_side)

    async def forward() -> None:
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
