"""Backend price-alert engine: in-memory registry + tick evaluation + firing
pipeline. Port of frontend/src/lib/alertEngine.ts's move-detection, baseline,
and arming semantics — see that file's comments for the "why" behind them.

`evaluate_alert` (alert_eval.py) is the pure crossing/once/every logic;
`AlertStore` (alert_store.py) is dumb persistence. This module is the glue that
drives every active alert off live ticks even with no browser tab open:

- a registry `dict[(broker, epic) -> list[(user_id, row)]]`, built at start
  from `AlertStore.list_all()` and mutated by `on_alert_changed` (the API
  router calls this after every alert write/delete);
- per-alert engine-owned state keyed `(user_id, alert_id)`: `baseline`
  (previous intrabar `(subject, level)` pair; close-mode alerts read the
  previous closed bar from the hub instead), `last_fired_bar`, and `sig` (the
  kind's signature of the alert's evaluation params: a changed sig on a KNOWN
  key means the alert was reconfigured, so its baseline and last-fired bar
  reset); "every" fires at most once per bar (alert_eval.py);
- `on_tick` evaluates every alert on a (broker, epic) against one price
  sample, prunes expired alerts, and on a fire runs `_fire`: record
  triggered-history, broadcast to `/ws/state`, then best-effort notifiers
  (Web Push / Telegram register later — a notifier failure never blocks
  evaluation for anyone else);
- `_expiry_loop` sweeps every 30s so an alert with no incoming ticks (its feed
  reconciled away, or the epic simply illiquid) still gets pruned on expiry;
- `price_side_for` mirrors the frontend's `priceSide` setting (bid/mid/ask)
  out of `STATE_STORE`'s per-user mirrored settings JSON, with a small TTL
  cache since it's read on every tick per alert owner.

Feed spawning (subscribing to broker tick streams for the (broker, epic) pairs
`feeds_needed()` reports) is Task 4 — `_reconcile_feeds` is a no-op here.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any, Awaitable, Callable

from auto_trader.core.alert_bars import Sample, candle_ms, period_start
from auto_trader.core.alert_eval import Pair, evaluate_alert
from auto_trader.core.alert_indicators import IndicatorHub, Loader, SeriesKey
from auto_trader.core.alert_kinds import AlertKind, kind_of
from auto_trader.core.alert_store import AlertStore
from auto_trader.core.models import Candle
from auto_trader.core.state_store import STATE_STORE
from auto_trader.indicators.alertable import IndicatorKey

log = logging.getLogger(__name__)

_EXPIRY_SWEEP_SECONDS = 30
_PRICE_SIDE_TTL_SECONDS = 30
_SETTINGS_KEY = "auto-trader.settings"

# Module-level so tests can monkeypatch them small.
POLL_INTERVAL = 5.0
BACKOFF_MIN = 5.0
BACKOFF_MAX = 60.0
_BROKER_RETRY_SECONDS = 60.0
# A streaming attempt that goes this long without yielding a single bar is
# treated as a dead/hung stream (no error, no signal — just silence) rather
# than left to block forever: _stream_feed gives up and _feed_loop retries.
STREAM_STALE_SECONDS = 300.0
# Consecutive streaming attempts that each ended without yielding a single
# bar before _feed_loop stops retrying streaming and falls back to polling
# for one backoff cycle.
_STREAM_FAILURE_THRESHOLD = 2

# A `line` alert's reference bar rolls forward once it is this many bars
# behind the newest close, so it never leaves the 2000-bar seed.
LINE_REBASE_BARS = 1000


def _is_broker_paused(exc: BaseException) -> bool:
    """True when `exc` or anything in its cause/context chain is the MT5
    paused-account error: the stream helpers wrap it in a RuntimeError, so the
    original sits one link down the chain. Any other error class can opt in
    with a truthy `broker_paused` attribute (oanor's spent monthly quota)."""
    from auto_trader.brokers.mt5 import MT5PausedError

    seen: set[int] = set()
    cur: BaseException | None = exc
    while cur is not None and id(cur) not in seen:
        if isinstance(cur, MT5PausedError) or getattr(cur, "broker_paused", False):
            return True
        seen.add(id(cur))
        cur = cur.__cause__ or cur.__context__
    return False

class AlertEngine:
    """Singleton (`ALERT_ENGINE` below) driving every user's price alerts off
    live ticks. Construct + `configure()` are split so tests can build a fresh
    instance with injected seams without touching the module singleton."""

    def __init__(self) -> None:
        self._store: AlertStore | None = None
        self._get_broker: Callable[[str], Any] | None = None
        self._broadcast: Callable[[str, dict], Awaitable[None]] | None = None
        self._notifiers: list[Callable[[str, dict], Awaitable[None]]] | None = None

        # registry: (broker, epic) -> [(user_id, row), ...]
        self._registry: dict[tuple[str, str], list[tuple[str, dict]]] = {}

        # per-alert engine-owned tick state, keyed (user_id, alert_id)
        self._last_fired_bar: dict[tuple[str, str], int] = {}
        self._baseline: dict[tuple[str, str], Pair | None] = {}
        self._hub: IndicatorHub | None = None
        # status debounce: key -> (status, since_monotonic); last broadcast status
        self._status_seen: dict[tuple[str, str], tuple[str, float]] = {}
        self._status_sent: dict[tuple[str, str], str] = {}
        self._status_task: asyncio.Task | None = None
        self._sig: dict[tuple[str, str], str] = {}
        # Held-line signature per alert (nearest-trendline alerts): a change
        # at a close drops the intrabar baseline so a switch is never a cross.
        self._level_sig: dict[tuple[str, str], tuple | None] = {}

        # price-side cache: user_id -> (side, cached_at_monotonic)
        self._price_side_cache: dict[str, tuple[str, float]] = {}

        # Telegram "Snooze" mutes: (user_id, alert_id) -> epoch-ms until which
        # firings are suppressed. In-memory only, by design: losing snoozes on
        # restart means an alert may fire again — the safe direction (a missed
        # alert would not be).
        self._snoozed: dict[tuple[str, str], int] = {}

        self._reconcile_event = asyncio.Event()
        self._expiry_task: asyncio.Task | None = None
        self._reconciler_task: asyncio.Task | None = None
        # (broker, epic) -> running feed task. One task per pair, so on_tick is
        # never invoked concurrently for the same feed (Task 3's contract).
        self._feed_tasks: dict[tuple[str, str], asyncio.Task] = {}
        # (broker, epic) -> tasks cancelled by a reconcile but not yet unwound.
        # A respawn for the same pair (delete-then-recreate an alert between two
        # reconciles) must wait for these to actually finish before starting a
        # new feed loop — cancel() only lands at the old task's next suspension
        # point, and on_tick has awaits in it, so the old and new task could
        # otherwise both be inside on_tick for the same (broker, epic) at once.
        self._draining: dict[tuple[str, str], set[asyncio.Task]] = {}

    # ---- configuration ----

    def configure(
        self,
        store: AlertStore,
        get_broker: Callable[[str], Any],
        broadcast: Callable[[str, dict], Awaitable[None]],
        notifiers: list[Callable[[str, dict], Awaitable[None]]] | None = None,
        load_bars: Loader | None = None,
    ) -> None:
        self._store = store
        self._get_broker = get_broker
        self._broadcast = broadcast
        # Stored by reference (not copied) so a caller (lifespan) can append a
        # notifier — e.g. web push, Telegram — registered after configure().
        self._notifiers = notifiers if notifiers is not None else []
        # Indicator alerts need closed bars; without a loader (most tests)
        # they simply never become ready and never fire.
        self._hub = IndicatorHub(load_bars) if load_bars is not None else None

    # ---- lifecycle ----

    async def start(self) -> None:
        assert self._store is not None, "configure() must be called before start()"
        # Recreated (not reused from __init__) so it binds to THIS start()'s
        # running loop. ALERT_ENGINE is a module singleton; a stale Event still
        # bound to a previous, now-closed loop (e.g. a prior app lifespan —
        # every `with TestClient(app) as c:` cycle spins up its own loop) makes
        # `.wait()` raise "bound to a different event loop" synchronously,
        # before any suspension point — `_reconciler_loop`'s `except Exception`
        # then retries with no await in between, busy-spinning the CPU forever.
        self._reconcile_event = asyncio.Event()
        # Same class of bug as the Event above: engine-owned per-alert state
        # left over from a PRIOR lifespan (ALERT_ENGINE is a module singleton;
        # tests cycle multiple app lifespans against it) must not leak into
        # this one — a stale `baseline` could misread the first tick of a
        # freshly (re)started engine as a crossing.
        self._registry.clear()
        self._last_fired_bar.clear()
        self._status_seen.clear()
        self._status_sent.clear()
        self._baseline.clear()
        self._level_sig.clear()
        self._sig.clear()
        self._price_side_cache.clear()
        self._snoozed.clear()
        all_rows = await self._store.list_all()
        for user_id, row in all_rows:
            key = (row["broker"], row["epic"])
            self._registry.setdefault(key, []).append((user_id, row))
        await self._rebuild_last_fired()
        self._safe_sync_needs()
        self._status_task = asyncio.create_task(self._status_loop())
        self._reconcile_feeds()
        self._expiry_task = asyncio.create_task(self._expiry_loop())
        self._reconciler_task = asyncio.create_task(self._reconciler_loop())

    async def stop(self) -> None:
        draining = [t for tasks in self._draining.values() for t in tasks]
        tasks = [
            t for t in (
                self._expiry_task, self._reconciler_task, self._status_task,
                *self._feed_tasks.values(), *draining,
            )
            if t is not None
        ]
        self._expiry_task = None
        self._reconciler_task = None
        self._status_task = None
        self._feed_tasks = {}
        self._draining = {}
        for task in tasks:
            task.cancel()
        if tasks:
            # gather(..., return_exceptions=True) absorbs each CHILD task's
            # outcome (including its own CancelledError from the cancel()
            # above) without swallowing OUR cancellation: if stop() itself is
            # cancelled while awaiting this gather, that CancelledError still
            # propagates normally instead of being reported as a clean stop.
            await asyncio.gather(*tasks, return_exceptions=True)

    def _reconcile_feeds(self) -> None:
        """Diff `feeds_needed()` against the running feed tasks: spawn a
        `_feed_loop` for any pair with no task yet, cancel any running task
        whose pair is no longer needed (its alerts were deleted/deactivated).

        Cancellation runs BEFORE spawning: a pair dropped and re-added between
        two reconciles must not let its new feed task start running (and
        calling `on_tick`) before the old one has actually finished unwinding
        — see `_draining`/`_feed_spawn`."""
        needed = self.feeds_needed()
        for key in self._feed_tasks.keys() - needed:
            task = self._feed_tasks.pop(key)
            task.cancel()
            self._drain(key, task)
        for key in needed - self._feed_tasks.keys():
            self._feed_tasks[key] = asyncio.create_task(self._feed_spawn(key))

    def _drain(self, key: tuple[str, str], task: asyncio.Task) -> None:
        """Track `task` (cancelled, still unwinding) under `key` until it
        actually finishes. A per-task done-callback discards just that task —
        NOT the whole `key` bucket — so a second cancel-then-respawn for the
        same pair while the first is still draining doesn't orphan it (a
        wholesale `pop(key)` on the next respawn would lose track of it and
        `stop()` would then never await it)."""
        bucket = self._draining.setdefault(key, set())
        bucket.add(task)

        def _done(t: asyncio.Task, key: tuple[str, str] = key) -> None:
            still = self._draining.get(key)
            if still is not None:
                still.discard(t)
                if not still:
                    self._draining.pop(key, None)

        task.add_done_callback(_done)

    async def _feed_spawn(self, key: tuple[str, str]) -> None:
        """Wait out any still-draining previous task(s) for this pair (from a
        cancel-then-respawn race across two reconciles), then run the feed.

        Uses `asyncio.wait` (not individually awaiting each with a swallowing
        try/except) so a cancel arriving on THIS task while it's waiting on
        the drain still propagates — an except-BaseException here would
        discard that cancellation, let `_feed_loop` start anyway, and hang
        `stop()` forever awaiting a task that never finishes."""
        olds = set(self._draining.get(key, ()))
        if olds:
            await asyncio.wait(olds)
        await self._feed_loop(*key)

    async def _feed_loop(self, broker_id: str, epic: str) -> None:
        """Keep `on_tick` fed for one (broker, epic) pair forever (until
        cancelled by `_reconcile_feeds`/`stop`). Prefers the broker's native
        tick stream; falls back to polling `get_quote` when the broker doesn't
        stream, or when streaming keeps failing. A feed error never escapes
        this task — it's logged and retried with backoff."""
        # A mutable single-element holder (not a plain local) so _poll_feed and
        # _stream_feed — which each normally run forever and only return via an
        # exception or cancellation — can reset it on EVERY successful sample,
        # not just after a full clean return from the loop below. Otherwise a
        # feed that fails once, backs off, then succeeds a thousand times in a
        # row before failing again would still use the fully-escalated 60s
        # backoff on that second failure instead of starting fresh from 5s.
        backoff = [BACKOFF_MIN]

        def reset_backoff() -> None:
            backoff[0] = BACKOFF_MIN

        # Consecutive streaming attempts that ended (staleness timeout, or a
        # generator that simply stopped) without ever yielding a bar. Reset
        # on any attempt that yields at least one; once it hits the
        # threshold, one polling cycle runs before streaming is retried —
        # the fallback this loop's docstring promises.
        stream_failures = 0

        while True:
            try:
                assert self._get_broker is not None
                try:
                    broker = self._get_broker(broker_id)
                except Exception:
                    log.warning("alert feed: broker %s not available, retrying", broker_id, exc_info=True)
                    await asyncio.sleep(_BROKER_RETRY_SECONDS)
                    continue

                if getattr(broker, "supports_streaming", False):
                    if stream_failures >= _STREAM_FAILURE_THRESHOLD:
                        log.warning(
                            "alert feed for %s/%s: streaming failed %d times in a row "
                            "without a bar, polling for %.1fs before retrying streaming",
                            broker_id, epic, stream_failures, backoff[0],
                        )
                        await self._poll_feed(
                            broker, broker_id, epic, reset_backoff, max_duration=backoff[0],
                        )
                        stream_failures = 0
                    else:
                        yielded = await self._stream_feed(broker, broker_id, epic, reset_backoff)
                        stream_failures = 0 if yielded else stream_failures + 1
                else:
                    await self._poll_feed(broker, broker_id, epic, reset_backoff)
                # These helpers normally run forever (or, for streaming, until
                # staleness/end-of-generator); reaching here means one
                # returned cleanly. Sleep before retrying so that can never
                # busy-spin.
                reset_backoff()
                await asyncio.sleep(POLL_INTERVAL)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                if _is_broker_paused(e):
                    # Deliberate operator state, not a fault: one line, no
                    # traceback, straight to the slowest retry cadence.
                    backoff[0] = BACKOFF_MAX
                    log.info(
                        "alert feed for %s/%s: broker paused, retrying in %.0fs",
                        broker_id, epic, backoff[0],
                    )
                    await asyncio.sleep(backoff[0])
                    continue
                log.warning("alert feed for %s/%s failed, backing off %.1fs", broker_id, epic, backoff[0], exc_info=True)
                await asyncio.sleep(backoff[0])
                backoff[0] = min(backoff[0] * 2, BACKOFF_MAX)

    async def _stream_feed(
        self, broker: Any, broker_id: str, epic: str,
        reset_backoff: Callable[[], None] = lambda: None,
    ) -> bool:
        """Runs one streaming attempt for (broker_id, epic). Returns True if
        at least one bar was fed to `on_tick` before the stream ended; False
        if it ended (staleness timeout, or the generator simply stopping)
        without ever yielding one. `_feed_loop` uses that to decide whether
        to keep retrying streaming or fall back to polling for a cycle.

        Each `__anext__()` is bounded by `STREAM_STALE_SECONDS` — a stream
        that goes silent (no error, just nothing) would otherwise block this
        task forever with no signal at all. CancelledError is never caught
        here, so `_feed_loop`'s/`stop()`'s cancellation semantics are
        unchanged."""
        # Imported lazily — these pull in websocket/MetaApi client deps that
        # the core package (and its tests) shouldn't need to import eagerly.
        from auto_trader.brokers import ig_stream, mt5_stream
        from auto_trader.brokers.capital_stream import stream_candles as capital_stream_candles
        from auto_trader.brokers.ig import IGBroker
        from auto_trader.brokers.mt5 import MT5Broker
        from auto_trader.brokers.mt5_mcp import MT5MCPBroker
        from auto_trader.core.models import Resolution

        if isinstance(broker, IGBroker):
            if not ig_stream.streamable(Resolution.MINUTE.seconds):
                await self._poll_feed(broker, broker_id, epic, reset_backoff)
                return True
            stream = ig_stream.stream_candles(broker, epic, Resolution.MINUTE, "mid")
        elif isinstance(broker, (MT5Broker, MT5MCPBroker)):
            stream = mt5_stream.stream_candles(broker, epic, Resolution.MINUTE, "mid")
        else:
            stream = capital_stream_candles(broker, epic, Resolution.MINUTE, "mid")

        stream_iter = stream.__aiter__()
        yielded_any = False
        while True:
            try:
                bar = await asyncio.wait_for(stream_iter.__anext__(), timeout=STREAM_STALE_SECONDS)
            except StopAsyncIteration:
                return yielded_any
            except asyncio.TimeoutError:
                log.warning(
                    "alert feed stream for %s/%s went silent for %.0fs, "
                    "abandoning this stream attempt",
                    broker_id, epic, STREAM_STALE_SECONDS,
                )
                await stream_iter.aclose()
                return yielded_any
            yielded_any = True
            reset_backoff()
            await self.on_tick(broker_id, epic, bar.candle.close, bar.bid, bar.ask, bar=bar.candle)

    async def _poll_feed(
        self, broker: Any, broker_id: str, epic: str,
        reset_backoff: Callable[[], None] = lambda: None,
        *, max_duration: float | None = None,
    ) -> None:
        """Polls `get_quote` forever, feeding `on_tick`, unless `max_duration`
        is given — then it returns after that many seconds (used by
        `_feed_loop`'s streaming-fallback cycle, so streaming gets retried
        rather than polling taking over permanently)."""
        deadline = time.monotonic() + max_duration if max_duration is not None else None
        while True:
            bid, ask = await broker.get_quote(epic)
            reset_backoff()
            if bid is not None and ask is not None:
                mid = (bid + ask) / 2
            elif bid is not None:
                mid = bid
            elif ask is not None:
                mid = ask
            else:
                mid = None
            if mid is not None:
                await self.on_tick(broker_id, epic, mid, bid, ask)
            if deadline is not None and time.monotonic() >= deadline:
                return
            await asyncio.sleep(POLL_INTERVAL)

    async def _reconciler_loop(self) -> None:
        while True:
            try:
                await self._reconcile_event.wait()
                self._reconcile_event.clear()
                self._reconcile_feeds()
            except asyncio.CancelledError:
                raise
            except Exception:
                # A sleep here is required, not cosmetic: `wait()` can raise
                # synchronously (no suspension point reached) — e.g. the stale-
                # loop Event bug this module guards against above — and with no
                # await between the raise and the retry this would busy-spin
                # the CPU at 100% forever instead of backing off.
                log.warning("alert feed reconciler failed", exc_info=True)
                await asyncio.sleep(1)

    # ---- registry maintenance ----

    def on_alert_changed(self, user_id: str, row: dict | None, alert_id: str) -> None:
        """Router calls this after every alert write. `row=None` means the
        alert was deleted. Synchronous — all callers run on the event loop."""
        # Remove any existing entry for this (user_id, alert_id) from wherever
        # it currently sits in the registry (its (broker, epic) may itself be
        # changing is not supported by the API, but this stays correct either
        # way by scanning all buckets).
        for key, entries in list(self._registry.items()):
            kept = [(u, r) for (u, r) in entries if not (u == user_id and r["id"] == alert_id)]
            if kept:
                self._registry[key] = kept
            else:
                del self._registry[key]

        state_key = (user_id, alert_id)
        if row is None:
            self._forget(state_key)
        else:
            key = (row["broker"], row["epic"])
            self._registry.setdefault(key, []).append((user_id, row))
            if not row.get("active", 1):
                # An inactive alert is skipped by on_tick, so its baseline
                # would otherwise freeze at whatever price it last saw while
                # active. Forget its tick state now so a later re-enable
                # starts with an empty baseline — the first tick after
                # re-enabling can't misread the price drift while it was off
                # as a crossing. The last-fired bar is KEPT: toggling an
                # alert off and on must not let it fire twice in one bar.
                self._forget(state_key, keep_last_fired=True)

        self._safe_sync_needs()
        self._reconcile_event.set()

    def _forget(self, state_key: tuple[str, str], *, keep_last_fired: bool = False) -> None:
        if not keep_last_fired:
            self._last_fired_bar.pop(state_key, None)
        self._status_seen.pop(state_key, None)
        self._status_sent.pop(state_key, None)
        self._baseline.pop(state_key, None)
        self._sig.pop(state_key, None)
        self._level_sig.pop(state_key, None)
        self._snoozed.pop(state_key, None)

    def _reset_on_level_switch(self, state_key: tuple[str, str], sig: tuple | None) -> bool:
        """Drop the intrabar baseline when the watched line changed."""
        if sig == self._level_sig.get(state_key):
            return False
        self._level_sig[state_key] = sig
        self._baseline[state_key] = None
        return True

    # ---- snooze (Telegram inline button) ----

    def snooze(self, user_id: str, alert_id: str, seconds: float) -> None:
        """Suppress firings for one alert until now+seconds. Evaluation state
        (baseline) keeps advancing normally — only the fire is muted, and a
        muted fire does not record a last-fired bar."""
        self._snoozed[(user_id, alert_id)] = int(time.time() * 1000 + seconds * 1000)

    def _is_snoozed(self, state_key: tuple[str, str], now_ms: int) -> bool:
        until = self._snoozed.get(state_key)
        if until is None:
            return False
        if until <= now_ms:
            del self._snoozed[state_key]
            return False
        return True

    def feeds_needed(self) -> set[tuple[str, str]]:
        return {
            key
            for key, entries in self._registry.items()
            if any(row.get("active", 1) for _, row in entries)
        }

    def feeds_status(self) -> list[dict]:
        """Admin-console view of the live feeds: one row per registered
        (broker, epic) with whether its task is running and how many alerts
        ride it. Read-only; never mutates engine state."""
        rows = []
        for (broker, epic), entries in sorted(self._registry.items()):
            task = self._feed_tasks.get((broker, epic))
            rows.append(
                {
                    "broker": broker,
                    "epic": epic,
                    "running": bool(task and not task.done()),
                    "alerts": len(entries),
                }
            )
        return rows

    # ---- price side (mirrored frontend setting) ----

    def price_side_for(self, user_id: str) -> str:
        """Sync cache read — safe to call from the hot on_tick path and easy
        for tests to monkeypatch with a plain lambda. A cache miss returns the
        "mid" default immediately; `on_tick` awaits `_refresh_price_side` to
        (re)populate the cache asynchronously once the TTL lapses, so the next
        tick sees the refreshed value without ever blocking the event loop on
        a store read."""
        cached = self._price_side_cache.get(user_id)
        return cached[0] if cached is not None else "mid"

    async def _refresh_price_side(self, user_id: str) -> None:
        cached = self._price_side_cache.get(user_id)
        if cached is not None and time.monotonic() - cached[1] < _PRICE_SIDE_TTL_SECONDS:
            return
        prev_side = cached[0] if cached is not None else None

        side = "mid"
        try:
            raw_all = await STATE_STORE.get_all(user_id)
            raw = raw_all.get(_SETTINGS_KEY)
            if raw:
                parsed = json.loads(raw)
                candidate = parsed.get("priceSide")
                if candidate in ("bid", "mid", "ask"):
                    side = candidate
        except Exception:
            # A transient store error is not a setting change: keep the
            # cached side, or a bid/ask user would read as a flip to "mid"
            # (baselines cleared, hub series dropped and cold-reseeded).
            side = prev_side or "mid"

        self._price_side_cache[user_id] = (side, time.monotonic())

        # The hub's needs were registered under whatever price_side_for
        # returned BEFORE this resolution - "mid" on a cache miss, same as
        # price_side_for's own default. Resync whenever the side actually
        # differs from that, not only on a FLIP (prev_side is not None):
        # a user's very FIRST resolution to a non-mid side is not a flip,
        # but the hub is still on the wrong SeriesKey until this runs.
        if side != (prev_side or "mid"):
            self._safe_sync_needs()
        # A side flip (e.g. mid -> bid) mid-session means every existing
        # baseline for this user was sampled on the OLD side; comparing it
        # against a price on the new side can misread as a crossing. Port
        # of alertEngine.ts's setPriceSide, which clears baselines for the
        # same reason. The first-ever resolution (prev_side is None) is
        # exempt: there is no stale baseline to clear.
        if prev_side is not None and side != prev_side:
            self._clear_baselines_for_user(user_id)

    def _clear_baselines_for_user(self, user_id: str) -> None:
        for entries in self._registry.values():
            for owner, row in entries:
                if owner == user_id:
                    self._baseline[(owner, row["id"])] = None

    # ---- indicator series + status ----

    def _series_key(self, user_id: str, row: dict, kind: AlertKind) -> SeriesKey:
        return (row["broker"], row["epic"], kind.bar_resolution(row["params"]),
                self.price_side_for(user_id))

    def _sync_needs(self) -> None:
        """Tell the hub which series/indicators active indicator alerts need."""
        if self._hub is None:
            return
        needs: dict[SeriesKey, set[IndicatorKey]] = {}
        for entries in self._registry.values():
            for user_id, row in entries:
                try:
                    kind = kind_of(row)
                    ind = kind.indicator_key(row["params"]) if kind and row.get("active", 1) else None
                    if ind is not None:
                        needs.setdefault(self._series_key(user_id, row, kind), set()).add(ind)
                except Exception:
                    # One malformed row must not drop every other alert's
                    # series (nor raise out of on_tick / a CRUD call).
                    log.warning("alert %s: indicator needs skipped", row.get("id"), exc_info=True)
        self._hub.set_needs(needs)

    def _safe_sync_needs(self) -> None:
        """`_sync_needs` for every caller: a broken indicator row (or a hub
        error) must not take price alerts or a CRUD call down with it."""
        try:
            self._sync_needs()
        except Exception:
            log.warning("alert indicator needs sync failed", exc_info=True)

    async def _rebuild_last_fired(self) -> None:
        """Map each alert's latest fire time back onto its bar, so a restart
        inside a bar cannot fire an "every" alert a second time in it."""
        assert self._store is not None
        rows = {(u, r["id"]): r for entries in self._registry.values() for u, r in entries}
        for user_id, alert_id, t in await self._store.last_fired_times():
            row = rows.get((user_id, alert_id))
            kind = kind_of(row) if row else None
            if kind is not None:
                self._last_fired_bar[(user_id, alert_id)] = period_start(
                    t, kind.bar_resolution(row["params"])
                )

    def status(self, user_id: str, alert_id: str) -> str | None:
        """"ok" / "waiting_for_data" for an active indicator alert; None for a
        price alert, a paused alert or an unknown id."""
        for entries in self._registry.values():
            for owner, row in entries:
                if owner == user_id and row["id"] == alert_id:
                    return self._row_status(user_id, row)
        return None

    def statuses(self, user_id: str) -> dict[str, str]:
        """`status` for every one of a user's alerts that has one, in a
        single registry pass (GET /api/alerts would otherwise scan the
        whole registry once per row)."""
        out: dict[str, str] = {}
        for entries in self._registry.values():
            for owner, row in entries:
                if owner != user_id:
                    continue
                try:
                    st = self._row_status(user_id, row)
                except Exception:
                    log.warning("alert %s: status failed", row.get("id"), exc_info=True)
                    continue
                if st is not None:
                    out[row["id"]] = st
        return out

    def _row_status(self, user_id: str, row: dict) -> str | None:
        """`status` for a row already in hand (no registry scan). A paused
        row has no series registered, so it reports nothing (like a price
        alert) rather than "waiting_for_data" forever."""
        if not row.get("active", 1):
            return None
        kind = kind_of(row)
        ind = kind.indicator_key(row["params"]) if kind else None
        if ind is None:
            return None
        ok = self._hub is not None and self._hub.ready(self._series_key(user_id, row, kind), ind)
        return "ok" if ok else "waiting_for_data"

    _STATUS_HOLD_SECONDS = 10.0

    async def _status_loop(self) -> None:
        while True:
            try:
                await asyncio.sleep(2)
                await self._broadcast_status_changes()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.warning("alert status loop failed", exc_info=True)

    async def _broadcast_status_changes(self) -> None:
        """Debounced: a status must hold for _STATUS_HOLD_SECONDS before it
        is announced, so a flapping series does not spam clients. The
        broadcast is the generic "alerts changed" nudge; clients refetch."""
        assert self._broadcast is not None
        now = time.monotonic()
        changed: dict[str, tuple[str, str]] = {}
        for entries in self._registry.values():
            for user_id, row in entries:
                key = (user_id, row["id"])
                st = self._row_status(user_id, row)
                if st is None:
                    continue
                seen = self._status_seen.get(key)
                if seen is None or seen[0] != st:
                    self._status_seen[key] = (st, now)
                    continue
                if now - seen[1] >= self._STATUS_HOLD_SECONDS and self._status_sent.get(key) != st:
                    self._status_sent[key] = st
                    changed[user_id] = (row["broker"], row["epic"])
        for user_id, (broker, epic) in changed.items():
            await self._broadcast(user_id, {
                "key": "__alerts__:changed",
                "value": {"broker": broker, "epic": epic, "origin": "engine"},
            })

    # ---- tick evaluation ----

    async def on_tick(
        self, broker: str, epic: str, mid: float, bid: float | None, ask: float | None,
        *, t_ms: int | None = None, bar: Candle | None = None,
    ) -> None:
        # Callers must not invoke on_tick concurrently for the same (broker,
        # epic): one feed task per pair guarantees it (see _feed_tasks). The
        # awaits that touch storage or the candle cache (price-side refresh,
        # hub sample) run before the per-alert loop for that reason.
        assert self._store is not None, "configure() must be called before on_tick()"
        entries = list(self._registry.get((broker, epic), []))
        now_ms = int(time.time() * 1000)
        t_ms = now_ms if t_ms is None else t_ms

        for owner in {user_id for user_id, _ in entries}:
            await self._refresh_price_side(owner)

        closed: set[SeriesKey] = set()
        if self._hub is not None and self._hub.has_feed(broker, epic):
            try:
                closed = await self._hub.on_sample(broker, epic, Sample(t_ms, mid, bid, ask, bar))
            except Exception:
                # Never let the hub back off the whole feed: price alerts on
                # this (broker, epic) still evaluate below.
                log.warning("alert indicator hub sample failed for %s/%s", broker, epic, exc_info=True)
                closed = set()

        for user_id, row in entries:
            if not row.get("active", 1):
                continue
            expires_at = row.get("expires_at")
            if expires_at is not None and expires_at <= now_ms:
                await self._expire_one(user_id, row)
                continue
            try:
                await self._evaluate_one(user_id, row, mid, bid, ask, t_ms, now_ms, closed)
                await self._maybe_rebase_line(user_id, row, closed)
            except Exception:
                # One bad alert must not stop every other alert on this feed
                # (an escaping error backs the whole feed task off).
                log.warning("alert evaluation failed for user=%s alert=%s", user_id, row["id"], exc_info=True)

    async def _evaluate_one(
        self, user_id: str, row: dict, mid: float, bid: float | None, ask: float | None,
        t_ms: int, now_ms: int, closed: set[SeriesKey],
    ) -> None:
        state_key = (user_id, row["id"])
        kind = kind_of(row)
        if kind is None:
            return
        params = row.get("params", {})

        sig = kind.sig(params)
        prev_sig = self._sig.get(state_key)
        if prev_sig is not None and prev_sig != sig:
            self._baseline[state_key] = None
            self._last_fired_bar.pop(state_key, None)
        self._sig[state_key] = sig

        side = self.price_side_for(user_id)
        price = bid if side == "bid" and bid is not None else ask if side == "ask" and ask is not None else mid

        ind = kind.indicator_key(params)
        # One bar clock for every alert: the period the sample falls in.
        # A close-mode fire happens in the bar AFTER the one that closed,
        # so its next chance is the following close; a restart rebuilds
        # this from the fire time with the same function.
        bar_open = period_start(t_ms, kind.bar_resolution(params))
        if kind.eval_on(params) == "close":
            # Close mode needs no baseline of its own: the previous pair
            # is the closed bar before the last one, read from the hub.
            # Restart-safe, and intrabar ticks cannot move it.
            skey = self._series_key(user_id, row, kind)
            if self._hub is None or skey not in closed:
                return
            last, before = self._hub.last_closed(skey), self._hub.prev_closed(skey)
            vals = self._hub.values(skey, ind, intrabar=False)
            pvals = self._hub.prev_values(skey, ind)
            cur, prev = kind.resolve_close(params, last, before, vals, pvals)
            if cur is None:
                return
            record_price = last.close
        else:
            vals = None
            if ind is not None:
                skey = self._series_key(user_id, row, kind)
                vals = self._hub.values(skey, ind, intrabar=True) if self._hub else None
                if vals is None:
                    self._baseline[state_key] = None  # no stale pair across a gap
                    return
                self._reset_on_level_switch(state_key, kind.level_sig(params, vals))
            cur = kind.resolve(params, price, vals)
            if cur is None:
                return
            record_price = price
            prev = self._baseline.get(state_key)
            self._baseline[state_key] = cur

        result = evaluate_alert(
            prev, cur, params.get("condition"), params.get("trigger"),
            bar_open, self._last_fired_bar.get(state_key),
        )
        if result.fired and not self._is_snoozed(state_key, now_ms):
            # Record last_fired_bar ONLY when the fire actually happens:
            # a snoozed "fire" must not block the real one once the
            # snooze lapses (test_telegram_rich_alerts.py pins a second
            # crossing in the same minute, right after snooze, still
            # firing).
            self._last_fired_bar[state_key] = bar_open
            await self._fire(user_id, row, record_price, cur, kind, t_ms)
        if result.remove:
            await self._delete_and_forget(user_id, row)

    async def _maybe_rebase_line(self, user_id: str, row: dict, closed: set[SeriesKey]) -> None:
        """Roll a `line` alert's reference bar forward once it is more than
        LINE_REBASE_BARS behind the newest close: one multiply from the
        stored reference, persisted, then the hub need swapped in place.
        sig excludes tRef/pRef, so baseline and last-fired bar survive."""
        if row.get("kind") != "line" or self._hub is None or not row.get("active", 1):
            return
        kind = kind_of(row)
        if kind is None:
            return
        skey = self._series_key(user_id, row, kind)
        if skey not in closed:
            return
        p = row["params"]
        n = self._hub.bars_after(skey, int(p["tRef"]))
        last = self._hub.last_closed(skey)
        if n is None or n <= LINE_REBASE_BARS or last is None:
            return
        assert self._store is not None and self._broadcast is not None
        patch = {"tRef": candle_ms(last), "pRef": p["pRef"] + p["slope"] * n}
        saved = await self._store.update(user_id, row["id"], {"params": patch})
        if saved is None:
            return
        row["params"] = saved["params"]  # the registry holds this same dict
        self._safe_sync_needs()
        await self._broadcast(user_id, {
            "key": "__alerts__:changed",
            "value": {"broker": row["broker"], "epic": row["epic"], "origin": "engine"},
        })

    async def _expire_one(self, user_id: str, row: dict) -> None:
        await self._delete_and_forget(user_id, row)

    async def _delete_and_forget(self, user_id: str, row: dict) -> None:
        assert self._store is not None and self._broadcast is not None
        alert_id = row["id"]
        await self._store.delete(user_id, alert_id)
        self._forget((user_id, alert_id))
        for key, entries in list(self._registry.items()):
            kept = [(u, r) for (u, r) in entries if not (u == user_id and r["id"] == alert_id)]
            if kept:
                self._registry[key] = kept
            else:
                del self._registry[key]
        self._safe_sync_needs()
        await self._broadcast(
            user_id,
            {
                "key": "__alerts__:changed",
                "value": {"broker": row["broker"], "epic": row["epic"], "origin": "engine"},
            },
        )

    async def _fire(
        self, user_id: str, row: dict, price: float, pair: Pair, kind: AlertKind, fired_at: int,
    ) -> None:
        assert self._store is not None and self._broadcast is not None
        params = row.get("params", {})
        # The resolved level: the fixed level for a price alert, the
        # indicator line (or the fixed value) for an indicator alert.
        level = pair[1]
        condition = params.get("condition")

        # The sample time: equal to now for live feeds, and the value the
        # restart rebuild maps back through `period_start`.
        now_ms = fired_at
        triggered_id = await self._store.add_triggered(
            user_id,
            {
                "time": now_ms,
                "alert_id": row["id"],
                "broker": row["broker"],
                "epic": row["epic"],
                "kind": row.get("kind", "price_level"),
                "price": price,
                "level": level,
                "condition": condition,
                "message": row.get("message", ""),
                "precision": row.get("precision", 2),
                # The fired alert's full definition, so the Telegram "Re-arm"
                # button can recreate a `once` alert after it deletes itself.
                "alert_json": json.dumps(row),
            },
        )

        payload = {
            "id": row["id"],
            "broker": row["broker"],
            "epic": row["epic"],
            "kind": row.get("kind", "price_level"),
            "price": price,
            "level": level,
            "condition": condition,
            "message": row.get("message", ""),
            "precision": row.get("precision", 2),
            "notify": row.get("notify", {}),
            # Notifier-facing extras: which trigger mode fired (drives which
            # inline buttons Telegram shows), the chart timeframe the alert was
            # created from (drives the snapshot), and the triggered rowid (the
            # re-arm callback reference). `time` is the firing moment (ms
            # epoch) so notifiers (Telegram caption) can stamp it.
            "trigger": params.get("trigger"),
            "timeframe": params.get("timeframe"),
            "triggered_id": triggered_id,
            "time": now_ms,
        }
        payload.update(kind.payload_extras(params, pair))
        await self._broadcast(user_id, {"key": "__alerts__:fired", "value": payload})

        for notifier in self._notifiers or []:
            try:
                await notifier(user_id, payload)
            except Exception:
                log.warning("alert notifier failed for user=%s alert=%s", user_id, row["id"], exc_info=True)

    # ---- expiry sweep ----

    async def _expiry_loop(self) -> None:
        while True:
            try:
                await asyncio.sleep(_EXPIRY_SWEEP_SECONDS)
                await self._sweep_expired()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.warning("alert expiry sweep failed", exc_info=True)

    async def _sweep_expired(self) -> None:
        now_ms = int(time.time() * 1000)
        expired: list[tuple[str, dict]] = []
        for entries in self._registry.values():
            for user_id, row in entries:
                expires_at = row.get("expires_at")
                if expires_at is not None and expires_at <= now_ms:
                    expired.append((user_id, row))
        for user_id, row in expired:
            await self._delete_and_forget(user_id, row)


ALERT_ENGINE = AlertEngine()
