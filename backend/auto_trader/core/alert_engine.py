"""Backend price-alert engine: in-memory registry + tick evaluation + firing
pipeline. Port of frontend/src/lib/alertEngine.ts's move-detection, baseline,
and arming semantics — see that file's comments for the "why" behind them.

`evaluate_alert` (alert_eval.py) is the pure crossing/once/every logic;
`AlertStore` (alert_store.py) is dumb persistence. This module is the glue that
drives every active alert off live ticks even with no browser tab open:

- a registry `dict[(broker, epic) -> list[(user_id, row)]]`, built at start
  from `AlertStore.list_all()` and mutated by `on_alert_changed` (the API
  router calls this after every alert write/delete);
- per-alert engine-owned state keyed `(user_id, alert_id)`: `armed`,
  `baseline` (previous price sample), and `sig` (a signature of
  level/condition/trigger — a changed sig on a KNOWN key means the alert was
  reconfigured, so its baseline resets and it re-arms, same as the TS engine);
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

from auto_trader.core.alert_eval import evaluate_alert
from auto_trader.core.alert_store import AlertStore
from auto_trader.core.state_store import STATE_STORE

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


def _alert_sig(params: dict) -> str:
    return f"{params.get('level')}|{params.get('condition')}|{params.get('trigger')}"


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
        self._armed: dict[tuple[str, str], bool] = {}
        self._baseline: dict[tuple[str, str], float | None] = {}
        self._sig: dict[tuple[str, str], str] = {}

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
    ) -> None:
        self._store = store
        self._get_broker = get_broker
        self._broadcast = broadcast
        # Stored by reference (not copied) so a caller (lifespan) can append a
        # notifier — e.g. web push, Telegram — registered after configure().
        self._notifiers = notifiers if notifiers is not None else []

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
        # this one — a stale `armed`/`baseline` could misread the first tick
        # of a freshly (re)started engine as a crossing.
        self._registry.clear()
        self._armed.clear()
        self._baseline.clear()
        self._sig.clear()
        self._price_side_cache.clear()
        self._snoozed.clear()
        all_rows = await self._store.list_all()
        for user_id, row in all_rows:
            key = (row["broker"], row["epic"])
            self._registry.setdefault(key, []).append((user_id, row))
        self._reconcile_feeds()
        self._expiry_task = asyncio.create_task(self._expiry_loop())
        self._reconciler_task = asyncio.create_task(self._reconciler_loop())

    async def stop(self) -> None:
        draining = [t for tasks in self._draining.values() for t in tasks]
        tasks = [
            t for t in (
                self._expiry_task, self._reconciler_task,
                *self._feed_tasks.values(), *draining,
            )
            if t is not None
        ]
        self._expiry_task = None
        self._reconciler_task = None
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
            except Exception:
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
        from auto_trader.core.models import Resolution

        if isinstance(broker, IGBroker):
            if not ig_stream.streamable(Resolution.MINUTE.seconds):
                await self._poll_feed(broker, broker_id, epic, reset_backoff)
                return True
            stream = ig_stream.stream_candles(broker, epic, Resolution.MINUTE, "mid")
        elif isinstance(broker, MT5Broker):
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
            await self.on_tick(broker_id, epic, bar.candle.close, bar.bid, bar.ask)

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
                # starts armed with an empty baseline — the first tick after
                # re-enabling can't misread the price drift while it was off
                # as a crossing.
                self._forget(state_key)

        self._reconcile_event.set()

    def _forget(self, state_key: tuple[str, str]) -> None:
        self._armed.pop(state_key, None)
        self._baseline.pop(state_key, None)
        self._sig.pop(state_key, None)
        self._snoozed.pop(state_key, None)

    # ---- snooze (Telegram inline button) ----

    def snooze(self, user_id: str, alert_id: str, seconds: float) -> None:
        """Suppress firings for one alert until now+seconds. Evaluation state
        (baseline/armed) keeps advancing normally — only the fire is muted."""
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
            side = "mid"

        self._price_side_cache[user_id] = (side, time.monotonic())

        # A side flip (e.g. mid -> bid) mid-session means every existing
        # baseline for this user was sampled on the OLD side; comparing it
        # against a price on the new side can misread as a crossing. Port of
        # alertEngine.ts's setPriceSide, which clears baselines for the same
        # reason. `prev_side is None` (first-ever resolution, no flip) is
        # exempt.
        if prev_side is not None and side != prev_side:
            self._clear_baselines_for_user(user_id)

    def _clear_baselines_for_user(self, user_id: str) -> None:
        for entries in self._registry.values():
            for owner, row in entries:
                if owner == user_id:
                    self._baseline[(owner, row["id"])] = None

    # ---- tick evaluation ----

    async def on_tick(
        self, broker: str, epic: str, mid: float, bid: float | None, ask: float | None
    ) -> None:
        # Callers must not invoke on_tick concurrently for the same (broker,
        # epic) — the per-alert state machine below (sig -> baseline -> armed
        # -> evaluate -> fire) has no suspension point once it starts, so two
        # overlapping calls for the same feed could interleave and process
        # samples out of order. Task 4's feed drivers run one task per
        # (broker, epic) pair, so this holds. The price-side refresh (the one
        # await that touches storage) is hoisted above the loop for exactly
        # this reason.
        assert self._store is not None, "configure() must be called before on_tick()"
        entries = list(self._registry.get((broker, epic), []))
        now_ms = int(time.time() * 1000)

        for owner in {user_id for user_id, _ in entries}:
            await self._refresh_price_side(owner)

        for user_id, row in entries:
            if not row.get("active", 1):
                continue

            alert_id = row["id"]
            state_key = (user_id, alert_id)

            expires_at = row.get("expires_at")
            if expires_at is not None and expires_at <= now_ms:
                await self._expire_one(user_id, row)
                continue

            side = self.price_side_for(user_id)
            if side == "bid" and bid is not None:
                price = bid
            elif side == "ask" and ask is not None:
                price = ask
            else:
                price = mid

            params = row.get("params", {})
            sig = _alert_sig(params)
            prev_sig = self._sig.get(state_key)
            if prev_sig is not None and prev_sig != sig:
                self._baseline[state_key] = None
                self._armed[state_key] = True
            self._sig[state_key] = sig

            # Advance the baseline every tick — read prev BEFORE overwriting.
            prev = self._baseline.get(state_key)
            self._baseline[state_key] = price

            armed = self._armed.get(state_key, True)

            result = evaluate_alert(
                prev, price, params.get("level"), params.get("condition"),
                params.get("trigger"), armed,
            )

            if result.next_armed != armed:
                self._armed[state_key] = result.next_armed

            if result.fired and not self._is_snoozed(state_key, now_ms):
                await self._fire(user_id, row, price)

            if result.remove:
                await self._delete_and_forget(user_id, row)

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
        await self._broadcast(
            user_id,
            {
                "key": "__alerts__:changed",
                "value": {"broker": row["broker"], "epic": row["epic"], "origin": "engine"},
            },
        )

    async def _fire(self, user_id: str, row: dict, price: float) -> None:
        assert self._store is not None and self._broadcast is not None
        params = row.get("params", {})
        level = params.get("level")
        condition = params.get("condition")

        triggered_id = await self._store.add_triggered(
            user_id,
            {
                "time": int(time.time() * 1000),
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
            # re-arm callback reference).
            "trigger": params.get("trigger"),
            "timeframe": params.get("timeframe"),
            "triggered_id": triggered_id,
        }
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
