"""Server-side evaluation of `account` alerts: one poll loop per monitorable
account with at least one active alert, independent of any browser tab and of
which account the app has selected. Reads broker figures through the account's
ExecutionBroker (which already shares the broker's rate limiter), judges tiers
with account_alert_kind, writes triggered history and fans out through the same
broadcast + notifiers as the price engine. Never touches positions."""
from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import Awaitable, Callable
from datetime import date
from typing import Any

from auto_trader.core.account_alert_kind import (
    account_label, cash_balance, crossed_now, evaluate_tiers, headline, near_tier, tier_label,
)
from auto_trader.core.account_metrics import AccountMetrics, account_metrics
from auto_trader.core.alert_store import AlertStore

log = logging.getLogger(__name__)

NORMAL_S = 30.0
FAST_S = 5.0
UNMONITORED_AFTER_S = 120.0
FETCH_TIMEOUT_S = 15.0
NOTIFIER_TIMEOUT_S = 30.0
ALL_CHANNELS = {"toast": True, "browser": True, "sound": True, "push": True, "telegram": True}

Notifier = Callable[[str, dict], Awaitable[None]]


def _meta_key(alert_id: str) -> str:
    return f"account:{alert_id}"


class AccountMonitor:
    def __init__(self) -> None:
        self._store: AlertStore | None = None
        self._get_exec: Callable[[str], Any] | None = None
        self._broadcast: Callable[[str, dict], Awaitable[None]] | None = None
        self._notifiers: list[Notifier] = []
        self._clock: Callable[[], float] = time.time
        self._sleep = asyncio.sleep
        self._today: Callable[[], str] = lambda: date.today().isoformat()
        # account -> [(user_id, row)]
        self._alerts: dict[str, list[tuple[str, dict]]] = {}
        # (user_id, alert_id) -> {"fired": [..], "seeded": bool, "peak": float|None, "peakDay": str|None}
        self._state: dict[tuple[str, str], dict] = {}
        self._tasks: dict[str, asyncio.Task] = {}
        # Per-alert lock around its alert_meta row: a write from poll_once's
        # own cycle (seed/re-arm) and a delete from on_alert_changed/_expire
        # are both fire-and-forget asyncio.to_thread calls against the SAME
        # sqlite row, from separate connections; without serializing them here
        # their underlying writes can commit out of submission order (one can
        # even block briefly on the other's write lock), so a save started
        # just before a delete can land just after it and resurrect a row the
        # delete was supposed to drop. The lock makes the two run strictly
        # one-after-the-other from this process's point of view.
        self._meta_locks: dict[tuple[str, str], asyncio.Lock] = {}
        # Shielded save tasks in flight (see _save_state): tracked so stop()
        # can wait for them instead of leaving them orphaned past shutdown.
        self._save_tasks: set[asyncio.Task] = set()
        self._latest: dict[str, AccountMetrics] = {}
        self._last_ok: dict[str, float] = {}
        self._first_fail: dict[str, float] = {}
        self._unmonitored: dict[str, str] = {}
        self._started: bool = False

    def configure(
        self, store: AlertStore, get_exec: Callable[[str], Any],
        broadcast: Callable[[str, dict], Awaitable[None]], notifiers: list[Notifier] | None = None,
        *, clock: Callable[[], float] = time.time, sleep=asyncio.sleep,
        today: Callable[[], str] | None = None,
    ) -> None:
        self._store = store
        self._get_exec = get_exec
        self._broadcast = broadcast
        self._notifiers = notifiers if notifiers is not None else []
        self._clock = clock
        self._sleep = sleep
        if today is not None:
            self._today = today

    # ---- lifecycle ----

    async def start(self) -> None:
        assert self._store is not None
        self._alerts.clear()
        self._state.clear()
        self._latest.clear()
        self._last_ok.clear()
        self._first_fail.clear()
        self._unmonitored.clear()
        for user_id, row in await self._store.list_all():
            if row.get("kind") == "account":
                self._alerts.setdefault(row["broker"], []).append((user_id, row))
                await self._load_state(user_id, row["id"])
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
        # Shielded saves survive the cancellation above by design; wait for
        # them here instead of leaving them to finish orphaned after stop().
        save_tasks = list(self._save_tasks)
        if save_tasks:
            await asyncio.gather(*save_tasks, return_exceptions=True)

    def _reconcile(self) -> None:
        needed = {acct for acct, rows in self._alerts.items() if any(r.get("active", 1) for _, r in rows)}
        for acct in list(self._tasks):
            if acct not in needed:
                self._tasks.pop(acct).cancel()
        for acct in needed - set(self._tasks):
            self._tasks[acct] = asyncio.create_task(self._loop(acct))

    async def _loop(self, account: str) -> None:
        while True:
            try:
                delay = await self.poll_once(account)
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("account monitor: cycle failed for %s", account)
                delay = NORMAL_S
            await self._sleep(delay)

    # ---- registry ----

    def on_alert_changed(self, user_id: str, row: dict | None, alert_id: str) -> None:
        prev: dict | None = None
        for acct, entries in list(self._alerts.items()):
            for u, r in entries:
                if u == user_id and r["id"] == alert_id:
                    prev = r
            kept = [(u, r) for (u, r) in entries if not (u == user_id and r["id"] == alert_id)]
            if kept:
                self._alerts[acct] = kept
            else:
                del self._alerts[acct]
        key = (user_id, alert_id)
        if row is None:
            self._state.pop(key, None)
            if self._store is not None:
                asyncio.get_running_loop().create_task(self._delete_meta(user_id, alert_id))
        else:
            self._alerts.setdefault(row["broker"], []).append((user_id, row))
            st = self._state.get(key)
            if st is not None and prev is not None:
                new_levels = {float(t["level"]) for t in row["params"]["tiers"]}
                st["fired"] = [lv for lv in st["fired"] if lv in new_levels]
                if row["params"].get("baseline") != prev["params"].get("baseline"):
                    st["peak"] = None
                    st["peakDay"] = None
                if self._store is not None:
                    asyncio.get_running_loop().create_task(self._save_state(user_id, alert_id))
        if self._started:
            self._reconcile()

    # ---- state ----

    async def _load_state(self, user_id: str, alert_id: str) -> dict:
        key = (user_id, alert_id)
        if key not in self._state:
            raw = await self._store.get_meta(user_id, _meta_key(alert_id))  # type: ignore[union-attr]
            self._state[key] = json.loads(raw) if raw else {"fired": [], "seeded": False, "peak": None, "peakDay": None}
        return self._state[key]

    def _lock_for(self, user_id: str, alert_id: str) -> asyncio.Lock:
        key = (user_id, alert_id)
        lock = self._meta_locks.get(key)
        if lock is None:
            lock = self._meta_locks[key] = asyncio.Lock()
        return lock

    async def _save_state(self, user_id: str, alert_id: str) -> None:
        key = (user_id, alert_id)
        if self._state.get(key) is None:
            return
        # Shielded: a save started while the alert was still registered must
        # run to completion (holding the per-alert lock the whole time) even
        # if the account's poll loop is cancelled moments later (on_alert_changed
        # reconciling the loop away). Without the shield, cancelling THIS
        # await would release the lock mid-write while the underlying DB
        # write (an orphaned background thread; asyncio cannot actually abort
        # it) keeps running and can commit after a same-key delete, resurrecting
        # a row the delete was supposed to drop. The task is tracked in
        # _save_tasks so stop() can wait for it instead of orphaning it.
        task = asyncio.ensure_future(self._save_state_locked(user_id, alert_id))
        self._save_tasks.add(task)
        task.add_done_callback(self._save_tasks.discard)
        await asyncio.shield(task)

    async def _save_state_locked(self, user_id: str, alert_id: str) -> None:
        key = (user_id, alert_id)
        async with self._lock_for(user_id, alert_id):
            # Re-check now that the lock is ours: a delete queued just before
            # this save may have been waiting on the same lock and already
            # popped the state while we were waiting for it.
            st = self._state.get(key)
            if st is None:
                return
            await self._store.set_meta(user_id, _meta_key(alert_id), json.dumps(st))  # type: ignore[union-attr]

    async def _delete_meta(self, user_id: str, alert_id: str) -> None:
        key = (user_id, alert_id)
        async with self._lock_for(user_id, alert_id):
            await self._store.delete_meta(user_id, _meta_key(alert_id))  # type: ignore[union-attr]
        # The lock is free again now; drop it so a deleted alert's lock does
        # not linger in _meta_locks forever (one per alert ever created).
        self._meta_locks.pop(key, None)

    # ---- status for the API ----

    def account_status(self, account: str) -> dict:
        reason = self._unmonitored.get(account)
        m = self._latest.get(account)
        return {"monitored": reason is None, "unmonitoredReason": reason, "metrics": _metrics_dict(m) if m else None}

    def statuses(self, user_id: str) -> dict[str, dict]:
        out: dict[str, dict] = {}
        for acct, entries in self._alerts.items():
            reason = self._unmonitored.get(acct)
            for u, row in entries:
                if u != user_id:
                    continue
                st = self._state.get((u, row["id"]), {})
                out[row["id"]] = {
                    "current": self._current(acct, row, st),
                    "firedTiers": list(st.get("fired", [])),
                    "monitored": reason is None,
                    "unmonitoredReason": reason,
                }
        return out

    def _current(self, account: str, row: dict, st: dict) -> float | None:
        m = self._latest.get(account)
        if m is None:
            return None
        metric = row["params"]["metric"]
        if metric == "drawdown":
            peak = st.get("peak")
            return None if not peak or m.equity is None else (peak - m.equity) / peak * 100
        return m.value_of(metric)

    async def metrics_for(self, account: str) -> dict:
        if account not in self._latest:
            await self.poll_once(account)
        m = self._latest.get(account)
        return _metrics_dict(m) if m else {}

    # ---- one cycle ----

    async def poll_once(self, account: str) -> float:
        assert self._store is not None and self._get_exec is not None
        now = self._clock()
        try:
            exec_broker = self._get_exec(account)
        except Exception as exc:
            await self._note_failure(account, str(exc) or exc.__class__.__name__, now, immediate=True)
            return NORMAL_S
        try:
            summary, positions = await asyncio.wait_for(
                asyncio.gather(exec_broker.get_account_summary(), exec_broker.get_positions()),
                timeout=FETCH_TIMEOUT_S,
            )
        except Exception as exc:
            await self._note_failure(account, str(exc) or exc.__class__.__name__, now)
            return NORMAL_S
        metrics = account_metrics(summary, positions, cash_balance=cash_balance(account))
        if metrics.missing:
            self._latest[account] = metrics
            await self._note_failure(account, "missing " + ", ".join(metrics.missing), now, immediate=True)
            return NORMAL_S
        self._latest[account] = metrics
        self._last_ok[account] = now
        self._first_fail.pop(account, None)
        if account in self._unmonitored:
            del self._unmonitored[account]
            await self._status_message(account, "resumed", "")

        fast = False
        for user_id, snapshot_row in list(self._alerts.get(account, [])):
            alert_id = snapshot_row["id"]
            # Re-look up the row from the CURRENT registry rather than trusting
            # the snapshot: a notifier invoked earlier in THIS same cycle (for
            # an earlier alert on this account) can synchronously delete or
            # patch a later alert via on_alert_changed before we get to it.
            # Using a stale snapshot there would let a deleted alert still
            # fire and resurrect its already-deleted meta, or judge a patched
            # alert against its old tiers.
            row = next(
                (r for (u, r) in self._alerts.get(account, []) if u == user_id and r["id"] == alert_id), None
            )
            if row is None:
                continue
            if not row.get("active", 1):
                continue
            expires_at = row.get("expires_at")
            if expires_at is not None and expires_at <= now * 1000:
                await self._expire(user_id, row)
                continue
            st = await self._load_state(user_id, row["id"])
            params = row["params"]
            metric, tiers = params["metric"], params["tiers"]
            old_peak, old_peak_day = st.get("peak"), st.get("peakDay")
            value = self._value(metric, params, metrics, st)
            if metric == "drawdown" and (st.get("peak") != old_peak or st.get("peakDay") != old_peak_day):
                # Persist the rising peak/baseline-day as it moves, not only
                # when a fired tier also changes in the same cycle - otherwise
                # a restart loads a stale, lower peak and understates drawdown.
                await self._save_state(user_id, row["id"])
            if value is None:
                if not st.get("seeded"):
                    # First-ever poll for this alert found no figure (e.g. the
                    # account was flat at creation): seed with an empty fired
                    # set rather than leaving it unseeded. Leaving it unseeded
                    # would make the FIRST poll that later finds a value act
                    # as the "seed" poll, silently marking any tier already
                    # breached as fired without ever notifying.
                    st.update(seeded=True, fired=[])
                    await self._save_state(user_id, row["id"])
                elif metric == "marginLevel" and st.get("fired"):
                    # marginLevel is undefined while flat (no positions, no
                    # margin to divide by). Nothing stays "fired" through a
                    # flat stretch: clear it so a later position reopened
                    # past the same tier notifies again instead of staying
                    # silently armed from before the account went flat.
                    st["fired"] = []
                    await self._save_state(user_id, row["id"])
                continue
            fired = set(st["fired"])
            if not st.get("seeded"):
                fired = crossed_now(metric, tiers, value)
                st.update(seeded=True, fired=sorted(fired, reverse=True))
                await self._save_state(user_id, row["id"])
            else:
                new_fired, newly = evaluate_tiers(metric, tiers, value, fired)
                if new_fired != fired:
                    st["fired"] = sorted(new_fired, reverse=True)
                    await self._save_state(user_id, row["id"])
                if newly is not None:
                    await self._fire(user_id, row, value, newly, metrics)
                fired = new_fired
            if near_tier(metric, tiers, value, fired):
                fast = True
        return FAST_S if fast else NORMAL_S

    def _value(self, metric: str, params: dict, m: AccountMetrics, st: dict) -> float | None:
        if metric != "drawdown":
            return m.value_of(metric)
        if m.equity is None:
            return None
        today = self._today()
        if params.get("baseline") == "daily" and st.get("peakDay") != today:
            st["peak"], st["peakDay"] = m.equity, today
        if st.get("peak") is None or m.equity > st["peak"]:
            st["peak"] = m.equity
        return (st["peak"] - m.equity) / st["peak"] * 100 if st["peak"] else None

    # ---- failure / watchdog ----

    async def _note_failure(self, account: str, reason: str, now: float, *, immediate: bool = False) -> None:
        if account in self._unmonitored:
            return
        if not immediate:
            self._first_fail.setdefault(account, now)
            last_ok = self._last_ok.get(account, self._first_fail[account])
            if now - last_ok < UNMONITORED_AFTER_S:
                return
        self._unmonitored[account] = reason
        await self._status_message(account, "unmonitored", reason)

    async def _status_message(self, account: str, status: str, reason: str) -> None:
        label = account_label(account)
        text = (f"{label} is not being monitored: {reason}" if status == "unmonitored"
                else f"{label}: monitoring resumed")
        payload = {
            "id": f"monitor:{account}", "broker": account, "epic": "", "kind": "account_status",
            "status": status, "reason": reason, "headline": text, "notify": dict(ALL_CHANNELS),
            "message": "", "precision": 2, "price": 0, "level": 0, "condition": "",
            "time": int(self._clock() * 1000),
        }
        for user_id in {u for u, _ in self._alerts.get(account, [])}:
            try:
                await self._broadcast(user_id, {"key": "__alerts__:monitor", "value": payload})  # type: ignore[misc]
            except Exception:
                log.warning("account monitor: broadcast failed for %s", account, exc_info=True)
            for n in self._notifiers:
                try:
                    await asyncio.wait_for(n(user_id, payload), timeout=NOTIFIER_TIMEOUT_S)
                except Exception:
                    log.warning("account monitor: notifier failed for %s", account, exc_info=True)

    # ---- fire / expire ----

    async def _fire(self, user_id: str, row: dict, value: float, level: float, m: AccountMetrics) -> None:
        assert self._store is not None and self._broadcast is not None
        params = row["params"]
        metric, tiers = params["metric"], params["tiers"]
        label = tier_label(tiers, level)
        condition = "above" if metric == "drawdown" else "below"
        now_ms = int(self._clock() * 1000)
        text = headline(metric, value, level, label, row["broker"], m.currency, m.equity)
        triggered_id = await self._store.add_triggered(user_id, {
            "time": now_ms, "alert_id": row["id"], "broker": row["broker"], "epic": "",
            "kind": "account", "price": value, "level": level, "condition": condition,
            "message": row.get("message", ""), "precision": 2, "alert_json": json.dumps(row),
        })
        payload = {
            "id": row["id"], "broker": row["broker"], "epic": "", "kind": "account",
            "price": value, "level": level, "condition": condition,
            "message": row.get("message", ""), "precision": 2, "notify": row.get("notify", {}),
            "time": now_ms, "triggered_id": triggered_id, "metric": metric, "tierLabel": label,
            "account": row["broker"], "headline": text, "currency": m.currency, "equity": m.equity,
            "critical": label == "critical",
        }
        try:
            await self._broadcast(user_id, {"key": "__alerts__:fired", "value": payload})
        except Exception:
            log.warning("account alert broadcast failed user=%s alert=%s", user_id, row["id"], exc_info=True)
        for n in self._notifiers:
            try:
                await asyncio.wait_for(n(user_id, payload), timeout=NOTIFIER_TIMEOUT_S)
            except Exception:
                log.warning("account alert notifier failed user=%s alert=%s", user_id, row["id"], exc_info=True)

    async def _expire(self, user_id: str, row: dict) -> None:
        assert self._store is not None and self._broadcast is not None
        await self._store.delete(user_id, row["id"])
        self._state.pop((user_id, row["id"]), None)
        await self._delete_meta(user_id, row["id"])
        entries = [(u, r) for (u, r) in self._alerts.get(row["broker"], []) if not (u == user_id and r["id"] == row["id"])]
        if entries:
            self._alerts[row["broker"]] = entries
        else:
            self._alerts.pop(row["broker"], None)
        try:
            await self._broadcast(user_id, {"key": "__alerts__:changed",
                                            "value": {"broker": row["broker"], "epic": "", "origin": "engine"}})
        except Exception:
            log.warning("account monitor: expiry broadcast failed user=%s alert=%s", user_id, row["id"], exc_info=True)
        if self._started:
            self._reconcile()


def _metrics_dict(m: AccountMetrics) -> dict:
    return {
        "balance": m.balance, "equity": m.equity, "margin": m.margin, "available": m.available,
        "openPnl": m.open_pnl, "marginLevel": m.margin_level, "openPnlPct": m.open_pnl_pct,
        "currency": m.currency,
    }


ACCOUNT_MONITOR = AccountMonitor()
