"""SL/TP move rules: the executor that acts on a move rule's fire, and the
close sweep that removes rules whose position has closed.

- `execute` is the alert engine's action handler. The engine has already
  deleted the `once` row. Under one lock per (account, deal) it reads the
  position fresh, works out the target, moves the level only when that
  tightens it, and reads the position back before it reports "moved".
  It never raises: any error is reported as a failed move on every channel.
- The sweep polls `get_positions` every POLL_S per account with rules
  (modelled on `core/position_watch.py`). A successful poll that lacks a
  rule's deal deletes the rule silently; a failed poll deletes nothing."""
from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import Awaitable, Callable
from typing import Any

from auto_trader.core.alert_store import AlertStore
from auto_trader.core.broker_health import BrokerBlocked
from auto_trader.core.models import OrderStatus
from auto_trader.core.move_rule import DIRECTIONS, FIELD_LABEL, decide, headline, target_level

log = logging.getLogger(__name__)

POLL_S = 10.0
FETCH_TIMEOUT_S = 10.0
RETRY_WAIT_S = 5.0
BUDGET_S = 30.0
STOP_WAIT_S = 35.0
NOTIFIER_TIMEOUT_S = 30.0
ALL_CHANNELS = {"toast": True, "browser": True, "sound": True, "push": True, "telegram": True}

Notifier = Callable[[str, dict], Awaitable[None]]


def _precision(row: dict) -> int:
    p = row.get("precision")
    if isinstance(p, int) and not isinstance(p, bool) and 0 <= p <= 10:
        return p
    return 5


def _same(level: float | None, target: float, precision: int) -> bool:
    """Equal within half a tick at the row's precision."""
    return level is not None and abs(level - target) <= 0.5 * 10 ** -precision


def _reason(exc: BaseException) -> str:
    text = str(exc).strip()
    return text or type(exc).__name__


class MoveRules:
    def __init__(self) -> None:
        self._store: AlertStore | None = None
        self._get_exec: Callable[[str], Any] | None = None
        self._broadcast: Callable[[str, dict], Awaitable[None]] | None = None
        self._notifiers: list[Notifier] = []
        self._engine: Any = None
        self._sleep = asyncio.sleep
        self._clock: Callable[[], float] = time.time
        # execution account -> [(user_id, row)]
        self._rules: dict[str, list[tuple[str, dict]]] = {}
        self._tasks: dict[str, asyncio.Task] = {}
        self._running: set[asyncio.Future] = set()
        # (account, dealId) -> [lock, users]; one move at a time per deal
        self._locks: dict[tuple[str, str], list] = {}
        self._started = False

    def configure(
        self, store: AlertStore, get_exec: Callable[[str], Any],
        broadcast: Callable[[str, dict], Awaitable[None]], notifiers: list[Notifier] | None,
        engine: Any, *, sleep=asyncio.sleep, clock: Callable[[], float] = time.time,
    ) -> None:
        self._store = store
        self._get_exec = get_exec
        self._broadcast = broadcast
        self._notifiers = notifiers if notifiers is not None else []
        self._engine = engine
        self._sleep = sleep
        self._clock = clock
        engine.set_action_handler(self.execute)

    # ---- lifecycle ----

    async def start(self) -> None:
        assert self._store is not None
        self._rules.clear()
        for user_id, row in await self._store.list_all():
            if row.get("action"):
                self._rules.setdefault(row["action"]["account"], []).append((user_id, row))
        self._started = True
        self._reconcile()

    async def stop(self) -> None:
        """Let running moves finish (they change real stops), up to
        STOP_WAIT_S, then cancel the sweep loops."""
        self._started = False
        running = list(self._running)
        if running:
            try:
                await asyncio.wait_for(
                    asyncio.shield(asyncio.gather(*running, return_exceptions=True)), timeout=STOP_WAIT_S)
            except (asyncio.TimeoutError, TimeoutError):
                log.warning("move rules: %d move(s) still running at shutdown", len(self._running))
        tasks = list(self._tasks.values())
        self._tasks = {}
        for t in tasks:
            t.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    def _reconcile(self) -> None:
        needed = {
            acct for acct, rows in self._rules.items()
            if any(r.get("active", 1) for _, r in rows)
        }
        for acct in list(self._tasks):
            if acct not in needed:
                self._tasks.pop(acct).cancel()
        for acct in needed - set(self._tasks):
            self._tasks[acct] = asyncio.create_task(self._loop(acct))

    async def _loop(self, account: str) -> None:
        while True:
            try:
                await self.poll_once(account)
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("move rules: sweep failed for %s", account)
            await self._sleep(POLL_S)

    # ---- registry ----

    def on_alert_changed(self, user_id: str, row: dict | None, alert_id: str) -> None:
        self._remove(user_id, alert_id)
        if row is not None and row.get("action"):
            self._rules.setdefault(row["action"]["account"], []).append((user_id, row))
        if self._started:
            self._reconcile()

    def _remove(self, user_id: str, alert_id: str) -> None:
        for acct, entries in list(self._rules.items()):
            kept = [(u, r) for (u, r) in entries if not (u == user_id and r["id"] == alert_id)]
            if kept:
                self._rules[acct] = kept
            else:
                del self._rules[acct]

    def _find_in(self, account: str, user_id: str, alert_id: str) -> dict | None:
        for u, r in self._rules.get(account, []):
            if u == user_id and r["id"] == alert_id:
                return r
        return None

    # ---- close sweep ----

    async def poll_once(self, account: str) -> None:
        assert self._get_exec is not None
        try:
            positions = await asyncio.wait_for(self._get_exec(account).get_positions(), timeout=FETCH_TIMEOUT_S)
        except Exception as exc:
            log.warning("move rules: get_positions failed for %s: %s", account, exc)
            return
        deals = {p.deal_id for p in positions}
        for user_id, row in list(self._rules.get(account, [])):
            if row["action"]["dealId"] not in deals:
                await self._delete(user_id, row, account)

    async def _delete(self, user_id: str, row: dict, account: str) -> None:
        """Delete a rule whose deal is gone. Re-checks the registry before
        and after the store call, as PositionWatch._delete does."""
        assert self._store is not None and self._broadcast is not None
        if self._find_in(account, user_id, row["id"]) is None:
            return
        try:
            deleted = await self._store.delete(user_id, row["id"])
        except Exception:
            log.warning("move rules: delete failed user=%s alert=%s", user_id, row["id"], exc_info=True)
            return
        if not deleted or self._find_in(account, user_id, row["id"]) is None:
            return
        self._remove(user_id, row["id"])
        if self._engine is not None:
            try:
                self._engine.on_alert_changed(user_id, None, row["id"])
            except Exception:
                log.warning("move rules: engine unregister failed alert=%s", row["id"], exc_info=True)
        try:
            await self._broadcast(user_id, {"key": "__alerts__:changed",
                                            "value": {"broker": row["broker"], "epic": row["epic"],
                                                      "origin": "engine"}})
        except Exception:
            log.warning("move rules: changed broadcast failed user=%s alert=%s",
                        user_id, row["id"], exc_info=True)
        if self._started:
            self._reconcile()

    # ---- execute ----

    async def execute(self, user_id: str, row: dict, price: float, level: float) -> str:
        """Act on one fire. Returns "moved", "skipped", "failed" or "gone".
        Never raises (except cancellation)."""
        me = asyncio.current_task()
        if me is not None:
            self._running.add(me)
        try:
            try:
                self._remove(user_id, row["id"])
                if self._started:
                    self._reconcile()
            except Exception:
                log.warning("move rules: registry drop failed", exc_info=True)
            try:
                return await self._execute(user_id, row, price, level)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log.exception("move rules: execute failed user=%s alert=%s", user_id, row.get("id"))
                await self._report(user_id, row, "failed", price, level,
                                   new=None, old=None, reason=_reason(exc))
                return "failed"
        finally:
            if me is not None:
                self._running.discard(me)

    async def _read(self, account: str, deal: str) -> Any:
        assert self._get_exec is not None
        positions = await asyncio.wait_for(self._get_exec(account).get_positions(), timeout=FETCH_TIMEOUT_S)
        return next((p for p in positions if p.deal_id == deal), None)

    async def _execute(self, user_id: str, row: dict, price: float, level: float) -> str:
        assert self._get_exec is not None
        fired_at = self._clock()
        action = row["action"]
        account, deal, field = action["account"], action["dealId"], action["field"]
        direction = action.get("direction")
        precision = _precision(row)

        async def report(outcome: str, *, new: float | None, old: float | None, reason: str = "") -> str:
            await self._report(user_id, row, outcome, price, level, new=new, old=old, reason=reason)
            return outcome

        if direction not in DIRECTIONS:
            return await report("failed", new=None, old=None, reason="bad direction")
        if field not in FIELD_LABEL:
            return await report("failed", new=None, old=None, reason="bad field")

        key = (account, deal)
        entry = self._locks.setdefault(key, [asyncio.Lock(), 0])
        entry[1] += 1
        try:
            async with entry[0]:
                uncertain = False  # an earlier modify returned UNKNOWN or raised
                old: float | None = None
                target: float | None = None
                reason = ""
                while True:
                    try:
                        pos = await self._read(account, deal)
                    except BrokerBlocked as exc:
                        return await report("failed", new=target, old=old, reason=_reason(exc))
                    except Exception as exc:
                        reason = _reason(exc)
                        pos = None
                        read_failed = True
                    else:
                        read_failed = False
                    if not read_failed:
                        if pos is None:
                            return "gone"
                        if field == "sl" and getattr(pos, "trailing_stop", False):
                            return await report("failed", new=target, old=old, reason="trailing stop")
                        target = target_level(action["target"], direction, pos.open_level)
                        current = pos.stop_level if field == "sl" else pos.take_profit_level
                        if uncertain and _same(current, target, precision):
                            return await report("moved", new=target, old=old)
                        if not uncertain:
                            old = current
                        if decide(field, direction, current, target) == "skip":
                            return await report("skipped", new=target, old=current)
                        kw = {"stop_level": target} if field == "sl" else {"take_profit_level": target}
                        try:
                            result = await asyncio.wait_for(
                                self._get_exec(account).modify_position(deal, **kw), timeout=BUDGET_S)
                        except BrokerBlocked as exc:
                            return await report("failed", new=target, old=old, reason=_reason(exc))
                        except Exception as exc:
                            uncertain = True
                            reason = _reason(exc)
                        else:
                            if result.status == OrderStatus.FILLED:
                                try:
                                    after = await self._read(account, deal)
                                except Exception as exc:
                                    # Filled but unverified: the next read decides.
                                    uncertain = True
                                    reason = _reason(exc)
                                else:
                                    if after is None:
                                        return "gone"
                                    now = after.stop_level if field == "sl" else after.take_profit_level
                                    if _same(now, target, precision):
                                        return await report("moved", new=target, old=old)
                                    return await report("failed", new=target, old=old,
                                                        reason="broker did not keep the new level")
                            elif result.status == OrderStatus.REJECTED:
                                return await report("failed", new=target, old=old,
                                                    reason=result.reason or "rejected by the broker")
                            else:
                                uncertain = True
                                reason = result.reason or "broker did not confirm the change"
                    if self._clock() - fired_at + RETRY_WAIT_S >= BUDGET_S:
                        if uncertain and target is not None:
                            # Budget spent: one last read, never another modify.
                            await self._sleep(RETRY_WAIT_S)
                            try:
                                last = await self._read(account, deal)
                            except Exception:
                                last = None
                            if last is not None and _same(
                                    last.stop_level if field == "sl" else last.take_profit_level,
                                    target, precision):
                                return await report("moved", new=target, old=old)
                        return await report("failed", new=target, old=old, reason=reason)
                    await self._sleep(RETRY_WAIT_S)
        finally:
            entry[1] -= 1
            if entry[1] == 0 and self._locks.get(key) is entry:
                del self._locks[key]

    # ---- reporting ----

    async def _report(self, user_id: str, row: dict, outcome: str, price: float, fire_level: float,
                      *, new: float | None, old: float | None, reason: str = "") -> None:
        """History row, fired broadcast, notifiers, changed broadcast. Each
        step is guarded; a failed move goes to every channel."""
        assert self._store is not None and self._broadcast is not None
        action = row.get("action") or {}
        precision = _precision(row)
        epic = row.get("epic", "")
        field = action.get("field", "")
        try:
            text = headline(outcome, epic, action.get("direction"), field,
                            new=new, old=old, reason=reason, precision=precision)
        except Exception:
            text = f"Could not move {FIELD_LABEL.get(field, 'level')} of {epic}"
            if reason:
                text = f"{text}: {reason}"
        level = new if new is not None else fire_level
        now_ms = int(self._clock() * 1000)
        notify = dict(ALL_CHANNELS) if outcome == "failed" else dict(row.get("notify") or {})
        triggered_id: int | None
        try:
            triggered_id = await self._store.add_triggered(user_id, {
                "time": now_ms, "alert_id": row["id"], "broker": row.get("broker", ""), "epic": epic,
                "kind": "move", "price": price, "level": level,
                "condition": str((row.get("params") or {}).get("condition", "")),
                "message": row.get("message", ""), "precision": precision,
                "alert_json": json.dumps({**row, "headline": text, "outcome": outcome}),
            })
        except Exception:
            log.warning("move rule history write failed user=%s alert=%s", user_id, row.get("id"), exc_info=True)
            triggered_id = None
        payload = {
            "id": row.get("id"), "kind": "move", "outcome": outcome, "broker": row.get("broker", ""),
            "account": action.get("account", ""), "epic": epic, "field": field, "level": level,
            "price": price, "precision": precision, "headline": text, "message": row.get("message", ""),
            "notify": notify, "time": now_ms, "triggered_id": triggered_id,
        }
        try:
            await self._broadcast(user_id, {"key": "__alerts__:fired", "value": payload})
        except Exception:
            log.warning("move rule fired broadcast failed user=%s alert=%s", user_id, row.get("id"), exc_info=True)
        for n in self._notifiers:
            try:
                await asyncio.wait_for(n(user_id, payload), timeout=NOTIFIER_TIMEOUT_S)
            except Exception:
                log.warning("move rule notifier failed user=%s alert=%s", user_id, row.get("id"), exc_info=True)
        try:
            await self._broadcast(user_id, {"key": "__alerts__:changed",
                                            "value": {"broker": row.get("broker", ""), "epic": epic,
                                                      "origin": "engine"}})
        except Exception:
            log.warning("move rule changed broadcast failed user=%s alert=%s",
                        user_id, row.get("id"), exc_info=True)


MOVE_RULES = MoveRules()
