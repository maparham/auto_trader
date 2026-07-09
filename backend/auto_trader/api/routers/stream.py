"""Live candle streaming WebSocket relay."""

from __future__ import annotations

import asyncio
import logging
from contextlib import suppress
from datetime import datetime, timezone

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from auto_trader.brokers import ig_stream, mt5_stream
from auto_trader.brokers.capital_stream import (
    SECONDS_INTERVALS,
    StreamFatalError,
    stream_candles,
    stream_tick_candles,
)
from auto_trader.brokers.ig import IGBroker
from auto_trader.brokers.mt5 import MT5Broker
from auto_trader.core.candle_aggregate import (
    DERIVED,
    aggregate_candle_stream,
    is_derived,
)
from auto_trader.core.candle_cache import CANDLE_CACHE
from auto_trader.core.models import Candle, Resolution

from .. import deps
from .charts import _candle_dto

log = logging.getLogger(__name__)

router = APIRouter()


@router.websocket("/ws/candles")
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
    assert deps._registry is not None, "registry not initialised"
    broker = deps._registry.data.get(broker_id)
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
    is_mt5 = isinstance(broker, MT5Broker)
    # Sub-minute intervals are built by bucketing the tick stream; native ones merge
    # the OHLC + tick channels. Sub-minute is mid-only (served from the single-price
    # TICK_STORE), so price_side intentionally doesn't apply there.
    if res_raw in SECONDS_INTERVALS:
        if is_ig or is_mt5:
            # IG/MT5 sub-minute streaming + tick history aren't built yet (the chart
            # disables scroll-back for these anyway); stop the client retrying.
            return await _fatal(f"{broker_id}: seconds intervals not streamed yet")
        stream = stream_tick_candles(broker, epic, SECONDS_INTERVALS[res_raw])
    elif is_derived(res_raw):
        # Derived timeframes stream by re-folding the native base (DAY/WEEK) stream
        # into the forming aggregate bucket. IG base-bar streaming isn't wired. MT5
        # streams its base (DAY/WEEK) natively, so we fold it here — but only for
        # MONTH (the scoped set is DAY/WEEK/MONTH); the wider derived TFs (2W/3W/6W,
        # 2M/3M, 1Y) stay on REST for MT5 for now. Fatal stops the client retrying.
        if is_ig or (is_mt5 and res_raw != "MONTH"):
            return await _fatal(f"{broker_id}: {res_raw} is not streamed live")
        rule = DERIVED[res_raw]
        base = rule.base
        # The base bar stream is broker-specific: MT5 folds ticks into DAY bars via
        # its own streamer; Capital uses its OHLC+tick websocket. Same LiveBar shape,
        # so aggregate_candle_stream consumes either.
        base_stream_candles = mt5_stream.stream_candles if is_mt5 else stream_candles

        async def _seed(bucket_ts: int) -> list[Candle]:
            # Closed base bars already elapsed in the current bucket (reconnect
            # mid-bucket); empty at a live rollover. Best-effort: a broker/breaker
            # failure here must NOT propagate into the relay's `async for` (forward()
            # only catches StreamFatalError/RuntimeError, so anything else would kill
            # the socket silently). Degrade to an unseeded bucket instead — the
            # forming aggregate then builds from live base bars going forward.
            start = datetime.fromtimestamp(bucket_ts, tz=timezone.utc)
            now = datetime.now(timezone.utc)
            base_key = (broker_id, epic, base.value, price_side)

            async def fetch_range(s, e):
                return await broker.get_candles(epic, base, s, e, price_side)

            try:
                return await CANDLE_CACHE.window(base_key, base.seconds, start, now, fetch_range)
            except Exception:
                log.warning("derived seed fetch failed for %s %s; unseeded", epic, res_raw)
                return []

        stream = aggregate_candle_stream(
            base_stream_candles(broker, epic, base, price_side), rule, _seed
        )
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
        elif is_mt5:
            # MT5 folds quote ticks into buckets: intraday + DAY on the plain epoch
            # bucket (DAY = 00:00 UTC, where AvaTrade opens dailies), WEEK phased to
            # the broker's actual week-open (see mt5_stream._bucket_ms). MONTH rides
            # the derived path above; seconds aren't wired.
            stream = mt5_stream.stream_candles(broker, epic, resolution, price_side)
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
