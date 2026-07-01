"""Live OHLC streaming from Capital.com, normalized to mid-price candles.

Two channels feed each forming bar over a single socket:

- `OHLCMarketData.subscribe` is the authoritative bar structure. Capital streams
  bid and ask as SEPARATE `ohlc.event` messages, both keyed by the bar open time
  `t` (ms), re-sending the forming bar as price moves. We mid them per-field. It
  also carries the bar OPEN (which a tick can't give) and `lastTradedVolume`.
  Keying trap: a new bar's bid can arrive while we still hold the previous bar's
  ask, so whenever `t` advances we clear BOTH sides first.

- `marketData.subscribe` gives tick `quote` events (bid/ofr/timestamp) that fire
  on essentially every price change — far more often than the OHLC channel pushes
  the forming bar. We mid each tick and fold it into the CURRENT bar's
  close/high/low. This is what makes the last candle move as rapidly as the
  capital.com platform's own chart; the OHLC channel alone updates in lumps.

The OHLC `t` drives bar identity; ticks only update the bar OHLC last announced
(tick timestamp >= current_t), so we never need bar-boundary alignment math for
DAY/WEEK. When `t` advances, all per-bar tick/OHLC state resets.

Lifecycle: ping keeps the socket alive; on any close/error we re-authenticate via
REST for fresh tokens and resubscribe, which makes the ~10-min token expiry a
non-issue. The async generator's `finally` cancels the ping task, so a consumer
that stops iterating (browser disconnect) tears everything down.

Stream URL is the same host for demo and live; demo tokens stream demo data.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import AsyncIterator
from typing import NamedTuple

import websockets

from auto_trader.brokers.capital import CapitalComBroker, PriceSide, pick_side
from auto_trader.config import settings
from auto_trader.core.models import Candle, Resolution
from auto_trader.core.tick_store import TICK_STORE
from datetime import datetime, timezone

log = logging.getLogger(__name__)

# CAPITAL_STREAM_DEBUG=1 — emit a per-second tick->candle latency summary so the
# debug output is visible regardless of uvicorn's log config. Self-contained
# handler (propagate off) so it neither depends on nor pollutes app logging.
_DEBUG = settings.stream_debug
if _DEBUG and not any(getattr(h, "_stream_dbg", False) for h in log.handlers):
    _h = logging.StreamHandler()
    _h.setFormatter(logging.Formatter("%(asctime)s [stream-dbg] %(message)s"))
    _h._stream_dbg = True  # type: ignore[attr-defined]
    log.addHandler(_h)
    log.setLevel(logging.INFO)
    log.propagate = False


class _StreamDebug:
    """Per-second tick->candle latency summary (CAPITAL_STREAM_DEBUG=1).

    One line per second per open stream, surfacing three things:

    - `ticks`/`yielded`: how many quote ticks arrived vs how many produced a
      candle. They should match 1:1 — a gap means ticks were swallowed (stale /
      pre-first-bar), so the candle isn't tracking every tick.
    - `age_ms` = wall_now - tick.timestamp: how fresh the data folded into the
      candle is. Small and STABLE => ticks are reflected immediately. A steadily
      GROWING age_ms is the backpressure signal: a slow consumer stalls
      send_json, which stalls the upstream socket read, so ticks sit unread and
      the live candle falls behind the real feed.
    - `mid`/`close`: the last tick's mid and the resulting candle close — they
      match, which is the direct proof that the tick *is* the candle's close.
    """

    __slots__ = ("epic", "label", "t0", "ticks", "yields", "ages", "last_mid", "last_close")

    def __init__(self, epic: str, label: str) -> None:
        self.epic = epic
        self.label = label
        self.t0 = time.monotonic()
        self.ticks = 0
        self.yields = 0
        self.ages: list[int] = []
        self.last_mid: float | None = None
        self.last_close: float | None = None

    def saw_tick(self, tick_ts: int | None, mid: float) -> None:
        self.ticks += 1
        if tick_ts is not None:
            self.ages.append(int(time.time() * 1000) - tick_ts)
        self.last_mid = mid

    def saw_yield(self, close: float) -> None:
        self.yields += 1
        self.last_close = close
        if time.monotonic() - self.t0 >= 1.0:
            self._flush()

    def _flush(self) -> None:
        if self.ages:
            self.ages.sort()
            mn, md, mx = self.ages[0], self.ages[len(self.ages) // 2], self.ages[-1]
        else:
            mn = md = mx = -1
        log.info(
            "%s %s ticks=%d yielded=%d age_ms(min/med/max)=%d/%d/%d mid=%s close=%s",
            self.epic, self.label, self.ticks, self.yields, mn, md, mx,
            self.last_mid, self.last_close,
        )
        self.t0 = time.monotonic()
        self.ticks = 0
        self.yields = 0
        self.ages.clear()

STREAM_URL = "wss://api-streaming-capital.backend-capital.com/connect"
PING_INTERVAL = 300  # seconds; must be < 600 (server drops idle connections at 10m)
RECONNECT_BACKOFF = 3  # seconds; base delay between reconnect attempts
RECONNECT_BACKOFF_MAX = 60  # cap for the exponential backoff on repeated failures
RECONNECT_MAX_FAILURES = 10  # consecutive failed connects (no bar) before giving up


# Sub-minute intervals the API can't serve natively: built live by bucketing the
# tick `quote` stream into N-second bins. Live-only — there is NO sub-minute
# history endpoint. Keys are sent verbatim by the frontend as the `resolution`.
# Single-sourced: the candles endpoint and the /ws/candles router both import this.
SECONDS_INTERVALS: dict[str, int] = {
    "SECOND": 1,
    "SECOND_5": 5,
    "SECOND_10": 10,
    "SECOND_15": 15,
    "SECOND_30": 30,
    "SECOND_45": 45,
}


def _mid_field(bid: dict | None, ask: dict | None, key: str, side: PriceSide = "mid") -> float | None:
    """Pick bid/mid/ask for one OHLC field across the bid/ask OHLC events.

    None (not 0.0) when the field is absent: a partial OHLC packet missing e.g. "o"
    must NOT fabricate a 0.0 price — that injected a zero-spike into the candle and
    corrupted indicators. Callers drop the bar (open/close) or skip the value (high/
    low) on None. Mirrors the REST parser, which also refuses to fabricate 0.0."""
    b = bid.get(key) if bid else None
    a = ask.get(key) if ask else None
    chosen = pick_side(b, a, side)
    return float(chosen) if chosen is not None else None


def _quote_mid(payload: dict, side: PriceSide = "mid") -> float | None:
    """Pick bid/mid/ask from a `quote` event's bid/ofr; None if neither present."""
    return pick_side(payload.get("bid"), payload.get("ofr"), side)


class StreamFatalError(RuntimeError):
    """A PERMANENT stream fault the client must NOT retry — e.g. an unknown/invalid
    epic whose subscription will fail identically forever. The /ws relay surfaces it
    as a fatal error frame so the browser stops reconnecting (a plain RuntimeError
    stays recoverable: a transient outage the client should keep retrying). Without
    this an invalid epic produces an endless open/close reconnect storm."""


class LiveBar(NamedTuple):
    """One forming candle plus the current raw bid/ask, for the live socket frame.

    `candle` is the price_side-adjusted OHLC the chart plots; `bid`/`ask` are the
    freshest raw spread sides (independent of price_side), used for the optional
    bid & ask price lines/labels. They are None until the first quote names them.
    """

    candle: Candle
    bid: float | None
    ask: float | None


class _BarState:
    """Merge OHLC sides and ticks into one mid-price bar for open time `t`.

    OHLC owns open/volume and gives a high/low/close baseline; ticks push
    close (and stretch high/low) between OHLC pushes. `t` advancing resets it.
    """

    __slots__ = (
        "t", "bid", "ask", "tick_open", "tick_high", "tick_low", "tick_close", "volume"
    )

    def __init__(self) -> None:
        self.t: int | None = None
        self.bid: dict | None = None
        self.ask: dict | None = None
        self.tick_open: float | None = None
        self.tick_high: float | None = None
        self.tick_low: float | None = None
        self.tick_close: float | None = None
        self.volume: float = 0.0

    def roll(self, t: int) -> None:
        self.t = t
        self.bid = self.ask = None
        self.tick_open = self.tick_high = self.tick_low = self.tick_close = None
        self.volume = 0.0

    def apply_ohlc(self, payload: dict) -> None:
        if payload.get("priceType") == "ask":
            self.ask = payload
        else:
            self.bid = payload
        vol = payload.get("lastTradedVolume")
        if vol is not None:
            self.volume = float(vol)

    def apply_tick(self, mid: float) -> None:
        if self.tick_open is None:  # pin open to the FIRST tick of the bar
            self.tick_open = mid
        self.tick_close = mid
        self.tick_high = mid if self.tick_high is None else max(self.tick_high, mid)
        self.tick_low = mid if self.tick_low is None else min(self.tick_low, mid)

    def candle(self, side: PriceSide = "mid") -> Candle | None:
        """Merged bar, or None if nothing priced this bar yet."""
        have_ohlc = self.bid is not None or self.ask is not None
        if not have_ohlc and self.tick_close is None:
            return None

        # Open is fixed for the life of the bar: Capital's true OHLC open once it
        # arrives, otherwise the FIRST tick's price (a tick-rolled bar has no OHLC
        # yet). Never `tick_close`, which would make the open crawl every tick.
        ohlc_o = _mid_field(self.bid, self.ask, "o", side) if have_ohlc else None
        # Explicit None check, not `or`: a legitimate 0.0 open must not fall through
        # to tick_open (_mid_field preserves 0.0 and returns None only when absent).
        open_ = ohlc_o if ohlc_o is not None else self.tick_open
        ohlc_c = _mid_field(self.bid, self.ask, "c", side) if have_ohlc else None
        close = self.tick_close if self.tick_close is not None else ohlc_c
        if open_ is None or close is None:
            return None  # incomplete bar (missing OHLC field) — don't emit a 0-spike

        highs = [v for v in (
            _mid_field(self.bid, self.ask, "h", side) if have_ohlc else None,
            self.tick_high, open_, close,
        ) if v is not None]
        lows = [v for v in (
            _mid_field(self.bid, self.ask, "l", side) if have_ohlc else None,
            self.tick_low, open_, close,
        ) if v is not None]

        return Candle(
            time=datetime.fromtimestamp(self.t / 1000, tz=timezone.utc),
            open=float(open_),
            high=max(highs),
            low=min(lows),
            close=float(close),
            volume=self.volume,
        )


async def _ping_loop(ws, cst: str, token: str) -> None:
    while True:
        await asyncio.sleep(PING_INTERVAL)
        await ws.send(
            json.dumps(
                {
                    "destination": "ping",
                    "correlationId": "ping",
                    "cst": cst,
                    "securityToken": token,
                }
            )
        )


def _subscribe(destination: str, corr: str, cst: str, token: str, payload: dict) -> str:
    return json.dumps(
        {
            "destination": destination,
            "correlationId": corr,
            "cst": cst,
            "securityToken": token,
            "payload": payload,
        }
    )


async def stream_candles(
    broker: CapitalComBroker, epic: str, resolution: Resolution, price_side: PriceSide = "mid"
) -> AsyncIterator[LiveBar]:
    """Yield bid/mid/ask LiveBars for `epic` as they form. Reconnects on failure."""
    backoff = RECONNECT_BACKOFF
    failures = 0
    while True:
        ping_task: asyncio.Task | None = None
        progressed = False  # did this connection actually deliver a bar?
        try:
            # Inside the try so a re-auth failure (HTTP 5xx / missing creds) is
            # retried with backoff instead of killing the generator.
            await broker._ensure_session()
            cst, token = broker._cst, broker._security_token
            async with websockets.connect(STREAM_URL) as ws:
                # Authoritative bar structure (open/volume + a high/low/close baseline).
                await ws.send(
                    _subscribe(
                        "OHLCMarketData.subscribe", "sub-ohlc", cst, token,
                        {"epics": [epic], "resolutions": [resolution.value], "type": "classic"},
                    )
                )
                # Tick quotes — fold into the forming bar so the last candle moves
                # tick-by-tick like the capital.com platform chart.
                await ws.send(
                    _subscribe("marketData.subscribe", "sub-tick", cst, token, {"epics": [epic]})
                )
                ping_task = asyncio.create_task(_ping_loop(ws, cst, token))

                bar = _BarState()
                # Seed the forming bar from the latest REST candle so it carries the
                # in-progress bucket's real open/high/low/close/volume from the first
                # frame. Capital pushes the authoritative OHLC event lazily (~13s after
                # subscribe), and `quote` ticks carry neither open nor volume — so
                # without this the bar cold-starts from the connect-time tick: its open
                # jumps to the current price and volume reads 0, collapsing the full
                # forming candle the client just loaded from /api/candles until the
                # first OHLC arrives. Best-effort: a failed/slow fetch must not stall or
                # kill the stream (this runs on every (re)connect — see the loop). Only
                # seed the CURRENT bucket; a stale bar from a rollover in the fetch gap
                # must not pin the live bar to an already-closed bucket (the tick path
                # rolls forward instead).
                if resolution.seconds < Resolution.DAY.seconds:
                    try:
                        recent = await broker.get_recent_candles(epic, resolution, 1, price_side)
                    except Exception:  # noqa: BLE001 — best-effort; fall back to cold start
                        recent = []
                    if recent:
                        seed = recent[-1]
                        step = resolution.seconds * 1000
                        seed_t = int(seed.time.timestamp() * 1000)
                        now_ms = int(time.time() * 1000)
                        if (now_ms // step) * step == seed_t:
                            bar.t = seed_t
                            bar.tick_open = seed.open
                            bar.tick_high = seed.high
                            bar.tick_low = seed.low
                            bar.tick_close = seed.close
                            bar.volume = seed.volume
                dbg = _StreamDebug(epic, resolution.value) if _DEBUG else None
                # Freshest raw spread sides for the optional bid & ask price lines.
                # Independent of price_side and the forming bar; None until known.
                last_bid: float | None = None
                last_ask: float | None = None

                async for raw in ws:
                    msg = json.loads(raw)
                    dest = msg.get("destination")

                    if dest == "ohlc.event":
                        p = msg.get("payload")
                        t = p.get("t") if p else None
                        if t is None:
                            continue  # malformed frame: skip, keep the stream alive
                        # Only ever advance forward. A late OHLC push for an
                        # already-closed bar (Capital sends them seconds late, and
                        # the tick clock may have rolled us forward) must NOT roll
                        # the forming bar backward and discard its accumulated ticks.
                        if bar.t is None or t > bar.t:
                            bar.roll(t)
                        elif t < bar.t:
                            continue  # stale bar, ignore
                        bar.apply_ohlc(p)
                        # Track the spread side from the OHLC close so the bid/ask
                        # lines have a value before the first tick `quote` arrives.
                        c = p.get("c")
                        if c is not None:
                            if p.get("priceType") == "ask":
                                last_ask = float(c)
                            else:
                                last_bid = float(c)

                    elif dest == "quote":
                        p = msg.get("payload")
                        if not p:
                            continue  # malformed frame: skip, keep the stream alive
                        if bar.t is None:
                            # Cold start. Capital pushes the FIRST ohlc.event lazily
                            # (~13s after subscribe, then ~once a bar), so gating on it
                            # froze the live candle for that whole gap — invisible on a
                            # busy epic whose ticks flood in the instant the gate opens,
                            # but a dead chart on a thin one (e.g. OIL_CRUDE, ~1 tick/s).
                            # Bootstrap bar 1 from the tick clock for intraday — the same
                            # epoch bucket the rollover below uses, so it aligns with
                            # Capital's `t`. DAY/WEEK still need OHLC to anchor (their bar
                            # boundary isn't a plain epoch bucket).
                            ts0 = p.get("timestamp")
                            if ts0 is None or resolution.seconds >= Resolution.DAY.seconds:
                                continue
                            step0 = resolution.seconds * 1000
                            bar.roll((ts0 // step0) * step0)
                        mid = _quote_mid(p, price_side)
                        if mid is None:
                            continue
                        # Freshest spread sides for the bid/ask lines (the quote is
                        # more current than the lazily-pushed OHLC close above).
                        bid_q, ask_q = p.get("bid"), p.get("ofr")
                        if bid_q is not None:
                            last_bid = float(bid_q)
                        if ask_q is not None:
                            last_ask = float(ask_q)
                        ts = p.get("timestamp")
                        if dbg is not None:  # count every priced tick that arrived
                            dbg.saw_tick(ts, mid)
                        # Record the raw tick FIRST — before any display-rollover
                        # branching — so the sub-minute history store's fidelity
                        # doesn't depend on this bar's live display state. ALWAYS the
                        # canonical mid, never the price_side value: this store is
                        # persisted and shared (every seconds chart reads it back), so
                        # baking bid/ask in would corrupt sub-minute history for good.
                        if ts is not None:
                            store_mid = mid if price_side == "mid" else _quote_mid(p)
                            if store_mid is not None:
                                TICK_STORE.record(broker.broker_id, epic, ts, store_mid)
                        # Drive rollover off the TICK CLOCK for intraday resolutions.
                        # The OHLC channel pushes a new bar's first event lazily
                        # (seconds-to-a-minute late), so without this the forming
                        # candle freezes on the old bar and folds in next-bar ticks
                        # until OHLC catches up — a ~1-bar lag. Epoch buckets align
                        # with Capital's `t` below a day; DAY/WEEK stay OHLC-driven
                        # (their bar alignment isn't a plain epoch bucket).
                        if ts is not None and resolution.seconds < Resolution.DAY.seconds:
                            step = resolution.seconds * 1000
                            bucket = (ts // step) * step
                            if bucket < bar.t:
                                continue  # stale tick from an already-closed bar
                            if bucket > bar.t:
                                bar.roll(bucket)  # new bar now, don't wait on OHLC
                        elif ts is not None and ts < bar.t:
                            continue
                        bar.apply_tick(mid)

                    else:
                        continue  # acks, ping replies, errors

                    candle = bar.candle(price_side)
                    if candle is not None:
                        if dbg is not None and dest == "quote":
                            dbg.saw_yield(candle.close)
                        progressed = True  # a real bar moved → connection is healthy
                        yield LiveBar(candle, last_bid, last_ask)
        except (websockets.ConnectionClosed, OSError):
            pass  # expected drop / token expiry — reconnect quietly
        except Exception as e:  # noqa: BLE001 — re-auth failure or a malformed
            # frame must not kill the feed; log and reconnect (see module docstring).
            log.warning("stream_candles(%s) error, reconnecting: %r", epic, e)
        finally:
            if ping_task:
                ping_task.cancel()
        # Reconnect reusing the broker's CURRENT session. We deliberately do NOT
        # null broker._cst here: the broker is a process-wide singleton shared by
        # every open chart's stream, and Capital rate-limits POST /session to ~1/s
        # (a 2nd call within a second returns 429). Nulling on every drop forced a
        # fresh re-auth per reconnect; with several charts, staggered reconnects
        # collided on /session, got 429, threw, and reconnect-stormed — the chart
        # "lag / not updating" symptom. _ensure_session() already refreshes on its
        # own 9-min TTL (< Capital's 10-min expiry), so a reconnect inside the TTL
        # reuses the valid session and makes no /session call at all.
        #
        # A connection that delivered bars is healthy: reset the backoff so a routine
        # drop reconnects fast. Repeated failures BEFORE any bar (e.g. missing creds,
        # a persistent outage) grow the delay (capped) and, after RECONNECT_MAX_FAILURES
        # in a row, give up by raising — surfacing the error to the consumer instead of
        # spinning forever on a fixed 3s loop.
        if progressed:
            failures = 0
            backoff = RECONNECT_BACKOFF
        else:
            failures += 1
            if failures >= RECONNECT_MAX_FAILURES:
                raise RuntimeError(
                    f"stream_candles({epic}) failed to connect after {failures} attempts"
                )
            backoff = min(backoff * 2, RECONNECT_BACKOFF_MAX)
        await asyncio.sleep(backoff)


class _TickBar:
    """Accumulate ticks into fixed N-second OHLC bars (sub-minute charts).

    Unlike `_BarState`, nothing from Capital anchors these bars — the OHLC stream
    only advances every minute — so the bar boundary is computed purely from the
    tick timestamp: `bucket = floor(ts / step_ms) * step_ms`. Quiet buckets emit
    nothing (standard tick-chart behavior): the next tick simply opens a later
    bar, so bars are contiguous by index but may skip empty time slots. Volume is
    0 — `quote` events carry no traded volume.
    """

    __slots__ = ("step_ms", "t", "open", "high", "low", "close")

    def __init__(self, bucket_seconds: int) -> None:
        self.step_ms = bucket_seconds * 1000
        self.t: int | None = None
        self.open = self.high = self.low = self.close = 0.0

    def apply_tick(self, ts_ms: int, mid: float) -> Candle | None:
        bucket = (ts_ms // self.step_ms) * self.step_ms
        if self.t is not None and bucket < self.t:
            # Stale tick from an already-closed bar (out-of-order quote). Drop it:
            # rewinding self.t here would emit a candle older than one already sent
            # and discard the in-progress bar's accumulated high/low. Mirrors the
            # `bucket < bar.t: continue` guard the OHLC (_BarState) path uses.
            return None
        if bucket != self.t:  # first tick of a new bar
            self.t = bucket
            self.open = self.high = self.low = self.close = mid
        else:
            self.close = mid
            self.high = max(self.high, mid)
            self.low = min(self.low, mid)
        return Candle(
            time=datetime.fromtimestamp(self.t / 1000, tz=timezone.utc),
            open=self.open,
            high=self.high,
            low=self.low,
            close=self.close,
            volume=0.0,
        )


async def stream_tick_candles(
    broker: CapitalComBroker, epic: str, bucket_seconds: int
) -> AsyncIterator[LiveBar]:
    """Yield N-second mid-price LiveBars built from the tick `quote` stream.

    For sub-minute intervals the OHLC channel is useless (it only rolls every
    minute), so we subscribe to ticks alone and bin them. Reconnects on failure,
    same as `stream_candles`.

    Mid-only by design: these bars come from TICK_STORE, which holds ONE canonical
    mid per tick, so the global bid/mid/ask price side does NOT apply to seconds
    charts (history and live would otherwise disagree by half a spread). Native
    resolutions honor the side; sub-minute stays mid.
    """
    backoff = RECONNECT_BACKOFF
    failures = 0
    while True:
        ping_task: asyncio.Task | None = None
        progressed = False  # did this connection actually deliver a bar?
        try:
            # Inside the try so a re-auth failure is retried with backoff.
            await broker._ensure_session()
            cst, token = broker._cst, broker._security_token
            async with websockets.connect(STREAM_URL) as ws:
                await ws.send(
                    _subscribe("marketData.subscribe", "sub-tick", cst, token, {"epics": [epic]})
                )
                ping_task = asyncio.create_task(_ping_loop(ws, cst, token))

                bar = _TickBar(bucket_seconds)
                dbg = _StreamDebug(epic, f"{bucket_seconds}s") if _DEBUG else None
                async for raw in ws:
                    msg = json.loads(raw)
                    if msg.get("destination") != "quote":
                        continue  # acks, ping replies, errors
                    p = msg.get("payload")
                    if not p:
                        continue  # malformed frame: skip, keep the stream alive
                    ts = p.get("timestamp")
                    mid = _quote_mid(p)  # canonical mid; sub-minute is mid-only
                    if ts is None or mid is None:
                        continue
                    TICK_STORE.record(broker.broker_id, epic, ts, mid)  # warm sub-minute history
                    candle = bar.apply_tick(ts, mid)
                    if candle is None:
                        continue  # stale out-of-order tick; nothing to emit
                    progressed = True  # a real bar moved → connection is healthy
                    # Raw spread sides for the optional bid & ask lines (the candle
                    # itself stays mid for sub-minute; see the docstring).
                    bid_q, ask_q = p.get("bid"), p.get("ofr")
                    if dbg is not None:
                        dbg.saw_tick(ts, mid)
                        dbg.saw_yield(candle.close)
                    yield LiveBar(
                        candle,
                        float(bid_q) if bid_q is not None else None,
                        float(ask_q) if ask_q is not None else None,
                    )
        except (websockets.ConnectionClosed, OSError):
            pass  # expected drop / token expiry — reconnect quietly
        except Exception as e:  # noqa: BLE001 — re-auth failure or a malformed
            # frame must not kill the feed; log and reconnect.
            log.warning("stream_tick_candles(%s) error, reconnecting: %r", epic, e)
        finally:
            if ping_task:
                ping_task.cancel()
        # Reuse the shared session on reconnect (see stream_candles for why we no
        # longer null broker._cst here): _ensure_session()'s 9-min TTL handles
        # refresh, and nulling per-drop caused /session 429 reconnect storms.
        # Progress-aware backoff (see stream_candles): reset after a healthy run,
        # grow (capped) on repeated barren failures, and give up after too many.
        if progressed:
            failures = 0
            backoff = RECONNECT_BACKOFF
        else:
            failures += 1
            if failures >= RECONNECT_MAX_FAILURES:
                raise RuntimeError(
                    f"stream_tick_candles({epic}) failed to connect after {failures} attempts"
                )
            backoff = min(backoff * 2, RECONNECT_BACKOFF_MAX)
        await asyncio.sleep(backoff)
