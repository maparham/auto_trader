"""Server-side evaluation of `position` alerts: a warning when the price nears
an open position's stop loss or take profit, measured in ATR(14) of 15m bars.

Two loops, as in the spec:
- a slow poll (`get_positions`, 10 s) per watchable account with at least one
  active position alert, learning each watched deal's SL/TP/side and spotting
  closes and removed levels (those delete the alert row, silently);
- the fast path, `on_tick`, borrowed from the price engine's live feeds
  (`ALERT_ENGINE.add_tick_listener`), which only looks things up in dicts and
  calls `position_alert_kind.step`.

The ATR per (data broker, epic) is refreshed from the poll loop, never from
`on_tick`. Fires go through the same broadcast + notifiers as account alerts.
MetaApi (`mt5`) accounts are never polled."""
from __future__ import annotations

import asyncio
import json
import logging
import math
import secrets
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from auto_trader.core.alert_store import AlertStore
from auto_trader.core.position_alert_kind import (
    atr, data_broker_of, headline, is_watchable, step, watched_price,
)

log = logging.getLogger(__name__)

POLL_S = 10.0
FETCH_TIMEOUT_S = 15.0
NOTIFIER_TIMEOUT_S = 30.0
BAR_S = 900  # MINUTE_15
ATR_BARS = 60
TOKEN_TTL_S = 600.0
FEED_OWNER = "position"

Notifier = Callable[[str, dict], Awaitable[None]]
LoadBars = Callable[[str, str, str, str, int], Awaitable[tuple[list, bool]]]
Pair = tuple[str, str]  # (data broker, epic)


@dataclass(frozen=True)
class Snap:
    """One deal as the last SUCCESSFUL poll saw it. `side` is "BUY"/"SELL"."""
    epic: str
    side: str
    sl: float | None
    tp: float | None
    trailing: bool
    upnl: float | None
    currency: str | None


def _snap_of(p: Any) -> Snap:
    side = p.side.name if hasattr(p.side, "name") else str(p.side).upper()
    return Snap(
        epic=p.epic, side=side, sl=p.stop_level, tp=p.take_profit_level,
        trailing=bool(getattr(p, "trailing_stop", False)), upnl=p.upnl,
        # Position carries no currency (ruling R2): the headline drops it.
        currency=getattr(p, "currency", None),
    )


def _level(snap: Snap, side: str) -> float | None:
    return snap.sl if side == "sl" else snap.tp


def _precision(row: dict, level: float) -> int:
    """Ruling R1: the row's own precision (the chart's market decimals, set
    at create), else the decimals of the level's shortest repr, 0..6."""
    p = row.get("precision")
    if isinstance(p, int) and not isinstance(p, bool) and 0 <= p <= 10:
        return p
    text = repr(float(level))
    if "e" in text or "E" in text:
        return 2
    decimals = len(text.split(".", 1)[1].rstrip("0")) if "." in text else 0
    return max(0, min(6, decimals))


class PositionWatch:
    def __init__(self) -> None:
        self._store: AlertStore | None = None
        self._get_exec: Callable[[str], Any] | None = None
        self._broadcast: Callable[[str, dict], Awaitable[None]] | None = None
        self._notifiers: list[Notifier] = []
        self._load_bars: LoadBars | None = None
        self._engine: Any = None
        self._clock: Callable[[], float] = time.time
        self._sleep = asyncio.sleep
        # account -> [(user_id, row)]
        self._alerts: dict[str, list[tuple[str, dict]]] = {}
        # (account, deal_id) -> Snap from the last successful poll
        self._snap: dict[tuple[str, str], Snap] = {}
        # (user_id, alert_id) -> fired / last seen level / last watched price.
        # Fired state is in memory only: a restart forgets it, so a level
        # still inside the threshold warns once more. That is the safe
        # direction (a duplicate warning, never a missed one).
        self._fired: dict[tuple[str, str], bool] = {}
        self._seen_level: dict[tuple[str, str], float] = {}
        self._last_price: dict[tuple[str, str], float] = {}
        # (data broker, epic) -> [(account, user_id, alert_id)], the on_tick index
        self._by_feed: dict[Pair, list[tuple[str, str, str]]] = {}
        self._atr: dict[Pair, float] = {}
        self._atr_bucket: dict[Pair, int] = {}
        self._tokens: dict[str, tuple[str, str, str, str, str, float, float]] = {}
        self._tasks: dict[str, asyncio.Task] = {}
        self._started = False
        self._listening: set[int] = set()

    def listen_to(self, engine: Any) -> None:
        """Subscribe on_tick to an engine's ticks, once per engine: the app
        lifespan can run more than once per process (tests), and a doubled
        listener would judge every tick twice."""
        if id(engine) in self._listening:
            return
        self._listening.add(id(engine))
        engine.add_tick_listener(self.on_tick)

    def configure(
        self, store: AlertStore, get_exec: Callable[[str], Any],
        broadcast: Callable[[str, dict], Awaitable[None]], notifiers: list[Notifier] | None,
        load_bars: LoadBars, engine: Any, *, clock: Callable[[], float] = time.time,
        sleep=asyncio.sleep,
    ) -> None:
        self._store = store
        self._get_exec = get_exec
        self._broadcast = broadcast
        self._notifiers = notifiers if notifiers is not None else []
        self._load_bars = load_bars
        self._engine = engine
        self._clock = clock
        self._sleep = sleep

    # ---- lifecycle ----

    async def start(self) -> None:
        assert self._store is not None
        self._alerts.clear()
        for user_id, row in await self._store.list_all():
            if row.get("kind") == "position":
                self._alerts.setdefault(row["broker"], []).append((user_id, row))
        self._started = True
        self._reconcile()

    async def stop(self) -> None:
        self._started = False
        tasks = list(self._tasks.values())
        self._tasks = {}
        for t in tasks:
            t.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    def _reconcile(self) -> None:
        needed = {
            acct for acct, rows in self._alerts.items()
            if is_watchable(acct) and any(r.get("active", 1) for _, r in rows)
        }
        for acct in list(self._tasks):
            if acct not in needed:
                self._tasks.pop(acct).cancel()
        for acct in needed - set(self._tasks):
            self._tasks[acct] = asyncio.create_task(self._loop(acct))
        self._rebuild_index()

    async def _loop(self, account: str) -> None:
        while True:
            try:
                await self.poll_once(account)
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("position watch: cycle failed for %s", account)
            await self._sleep(POLL_S)

    # ---- registry ----

    def on_alert_changed(self, user_id: str, row: dict | None, alert_id: str) -> None:
        for acct, entries in list(self._alerts.items()):
            kept = [(u, r) for (u, r) in entries if not (u == user_id and r["id"] == alert_id)]
            if kept:
                self._alerts[acct] = kept
            else:
                del self._alerts[acct]
        key = (user_id, alert_id)
        if row is None or row.get("kind") != "position":
            self._forget(key)
        else:
            self._alerts.setdefault(row["broker"], []).append((user_id, row))
        if self._started:
            self._reconcile()
        else:
            self._rebuild_index()

    def _forget(self, key: tuple[str, str]) -> None:
        self._fired.pop(key, None)
        self._seen_level.pop(key, None)
        self._last_price.pop(key, None)

    def _find(self, user_id: str, alert_id: str) -> tuple[str, dict] | None:
        for acct, entries in self._alerts.items():
            for u, r in entries:
                if u == user_id and r["id"] == alert_id:
                    return acct, r
        return None

    def _rebuild_index(self) -> None:
        """The on_tick lookup plus the engine's extra feeds, both from the
        snapshots of active rows' deals."""
        index: dict[Pair, list[tuple[str, str, str]]] = {}
        for acct, entries in self._alerts.items():
            if not is_watchable(acct):
                continue
            for u, r in entries:
                if not r.get("active", 1):
                    continue
                snap = self._snap.get((acct, r["params"]["dealId"]))
                if snap is None:
                    continue
                index.setdefault((data_broker_of(acct), snap.epic), []).append((acct, u, r["id"]))
        self._by_feed = index
        if self._engine is not None:
            try:
                self._engine.set_extra_feeds(FEED_OWNER, set(index))
            except Exception:
                log.warning("position watch: set_extra_feeds failed", exc_info=True)

    # ---- polling ----

    async def poll_once(self, account: str) -> None:
        """One position poll. Only a SUCCESSFUL poll may delete: a failed
        `get_positions` changes nothing, so a broker outage never reads as
        every tracked position closing."""
        assert self._store is not None and self._get_exec is not None
        if not is_watchable(account):
            return
        try:
            positions = await asyncio.wait_for(self._get_exec(account).get_positions(), timeout=FETCH_TIMEOUT_S)
        except Exception as exc:
            log.warning("position watch: get_positions failed for %s: %s", account, exc)
            return
        by_deal = {p.deal_id: _snap_of(p) for p in positions}
        for key in [k for k in self._snap if k[0] == account]:
            del self._snap[key]
        for user_id, row in list(self._alerts.get(account, [])):
            params = row["params"]
            deal, side = params["dealId"], params["side"]
            snap = by_deal.get(deal)
            level = _level(snap, side) if snap is not None else None
            if level is None:
                await self._delete(user_id, row, account)
                continue
            self._snap[(account, deal)] = snap
            key = (user_id, row["id"])
            if self._seen_level.get(key) != level:
                if key in self._seen_level:
                    self._fired[key] = False  # the level moved: re-arm
                self._seen_level[key] = level
        self._rebuild_index()
        await self._refresh_atrs({pair for pair in self._by_feed if pair[0] == data_broker_of(account)})

    async def _delete(self, user_id: str, row: dict, account: str) -> None:
        assert self._store is not None and self._broadcast is not None
        try:
            await self._store.delete(user_id, row["id"])
        except Exception:
            log.warning("position watch: delete failed user=%s alert=%s", user_id, row["id"], exc_info=True)
            return
        self._forget((user_id, row["id"]))
        entries = [(u, r) for (u, r) in self._alerts.get(account, []) if not (u == user_id and r["id"] == row["id"])]
        if entries:
            self._alerts[account] = entries
        else:
            self._alerts.pop(account, None)
        try:
            await self._broadcast(user_id, {"key": "__alerts__:changed",
                                            "value": {"broker": account, "epic": row.get("epic", ""),
                                                      "origin": "engine"}})
        except Exception:
            log.warning("position watch: changed broadcast failed user=%s alert=%s",
                        user_id, row["id"], exc_info=True)
        if self._started:
            self._reconcile()

    async def _refresh_atrs(self, pairs: set[Pair]) -> None:
        """Reload ATR when a new 15m bar is due, and at first need. A failed,
        degraded or short load leaves the bucket unset so the next poll
        retries; any earlier ATR is kept meanwhile."""
        assert self._load_bars is not None
        now = self._clock()
        bucket = math.floor(now / BAR_S)
        for pair in pairs:
            if self._atr_bucket.get(pair) == bucket and pair in self._atr:
                continue
            try:
                bars, degraded = await self._load_bars(pair[0], pair[1], "MINUTE_15", "mid", ATR_BARS)
            except Exception as exc:
                log.warning("position watch: bars failed for %s/%s: %s", pair[0], pair[1], exc)
                continue
            if degraded or not bars:
                continue
            # Only closed bars: the forming one would understate its range.
            closed = [b for b in bars if b.time.timestamp() + BAR_S <= now]
            value = atr(closed)
            if value is None or not value > 0:
                continue
            self._atr[pair] = value
            self._atr_bucket[pair] = bucket
        for pair in [p for p in self._atr if p not in self._by_feed]:
            self._atr.pop(pair, None)
            self._atr_bucket.pop(pair, None)

    # ---- hot path ----

    async def on_tick(self, broker: str, epic: str, mid: float, bid: float | None, ask: float | None) -> None:
        entries = self._by_feed.get((broker, epic))
        if not entries:
            return
        atr_value = self._atr.get((broker, epic))
        for account, user_id, alert_id in list(entries):
            found = self._find_in(account, user_id, alert_id)
            if found is None or not found.get("active", 1):
                continue
            params = found["params"]
            snap = self._snap.get((account, params["dealId"]))
            if snap is None or snap.epic != epic:
                continue
            side = params["side"]
            if side == "sl" and snap.trailing:
                continue  # trailing stops move every tick: excluded
            level = _level(snap, side)
            if level is None:
                continue
            price = watched_price(snap.side, bid, ask)
            if price is None:
                price = mid
            key = (user_id, alert_id)
            self._last_price[key] = price
            if atr_value is None:
                continue
            fired_after, fire_now = step(level, price, float(params["atrMult"]) * atr_value,
                                         self._fired.get(key, False))
            self._fired[key] = fired_after
            if fire_now:
                await self._fire(user_id, found, account, snap, level, price, atr_value)

    def _find_in(self, account: str, user_id: str, alert_id: str) -> dict | None:
        for u, r in self._alerts.get(account, []):
            if u == user_id and r["id"] == alert_id:
                return r
        return None

    # ---- fire ----

    async def _fire(self, user_id: str, row: dict, account: str, snap: Snap,
                    level: float, price: float, atr_value: float) -> None:
        assert self._store is not None and self._broadcast is not None
        side = row["params"]["side"]
        precision = _precision(row, level)
        text = headline(snap.epic, snap.side, side, level, price, atr_value, snap.upnl, snap.currency, precision)
        now_ms = int(self._clock() * 1000)
        data_broker = data_broker_of(account)
        triggered_id: int | None
        try:
            triggered_id = await self._store.add_triggered(user_id, {
                "time": now_ms, "alert_id": row["id"], "broker": account, "epic": snap.epic,
                "kind": "position", "price": price, "level": level, "condition": "near",
                "message": row.get("message", ""), "precision": precision,
                "alert_json": json.dumps({**row, "headline": text}),
            })
        except Exception:
            log.warning("position alert history write failed user=%s alert=%s", user_id, row["id"], exc_info=True)
            triggered_id = None
        payload = {
            "id": row["id"], "kind": "position", "broker": data_broker, "account": account,
            "epic": snap.epic, "side": side, "level": level, "price": price, "atr": atr_value,
            "precision": precision, "headline": text, "message": row.get("message", ""),
            "notify": row.get("notify", {}), "time": now_ms, "triggered_id": triggered_id,
            "removeToken": self.mint_remove_token(user_id, row["id"], level),
        }
        try:
            await self._broadcast(user_id, {"key": "__alerts__:fired", "value": payload})
        except Exception:
            log.warning("position alert broadcast failed user=%s alert=%s", user_id, row["id"], exc_info=True)
        try:
            await self._broadcast(user_id, {"key": "__alerts__:changed",
                                            "value": {"broker": account, "epic": snap.epic, "origin": "engine"}})
        except Exception:
            log.warning("position alert changed broadcast failed user=%s alert=%s",
                        user_id, row["id"], exc_info=True)
        for n in self._notifiers:
            try:
                await asyncio.wait_for(n(user_id, payload), timeout=NOTIFIER_TIMEOUT_S)
            except Exception:
                log.warning("position alert notifier failed user=%s alert=%s", user_id, row["id"], exc_info=True)

    # ---- status / confirm helpers ----

    def status(self, user_id: str, alert_id: str) -> dict:
        out = {"level": None, "distanceAtr": None, "fired": False, "trailing": False}
        found = self._find(user_id, alert_id)
        if found is None:
            return out
        account, row = found
        key = (user_id, alert_id)
        out["fired"] = bool(self._fired.get(key, False))
        snap = self._snap.get((account, row["params"]["dealId"]))
        if snap is None:
            return out
        level = _level(snap, row["params"]["side"])
        out["level"] = level
        out["trailing"] = snap.trailing
        atr_value = self._atr.get((data_broker_of(account), snap.epic))
        price = self._last_price.get(key)
        if level is not None and atr_value and price is not None:
            out["distanceAtr"] = abs(price - level) / atr_value
        return out

    async def snapshot(self, account: str, deal_id: str) -> Snap | None:
        """A fresh read of one deal for the removal confirm step. Raises when
        the broker call fails, so the caller can tell 'gone' from 'unknown'."""
        assert self._get_exec is not None
        positions = await asyncio.wait_for(self._get_exec(account).get_positions(), timeout=FETCH_TIMEOUT_S)
        for p in positions:
            if p.deal_id == deal_id:
                return _snap_of(p)
        return None

    def mint_remove_token(self, user_id: str, alert_id: str, level: float) -> str:
        now = self._clock()
        for tok in [t for t, v in self._tokens.items() if now - v[6] > TOKEN_TTL_S]:
            del self._tokens[tok]
        found = self._find(user_id, alert_id)
        account, deal, side = "", "", ""
        if found is not None:
            account, row = found
            deal, side = row["params"]["dealId"], row["params"]["side"]
        tok = secrets.token_urlsafe(6)  # 6 bytes -> 8 url-safe chars
        while tok in self._tokens:
            tok = secrets.token_urlsafe(6)
        self._tokens[tok] = (user_id, alert_id, account, deal, side, level, now)
        return tok

    def take_remove_token(self, token: str) -> tuple[str, str, str, str, str, float, float] | None:
        """Single use: the entry is gone after the first take. Age checks
        (600 s) are the caller's, from the returned minted_at."""
        return self._tokens.pop(token, None)


POSITION_WATCH = PositionWatch()
