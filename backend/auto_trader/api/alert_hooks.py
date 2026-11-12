"""The alert-system seams Telegram's rich notifications need, wired from the
API layer's singletons (`build_alert_hooks()` is called once in the app
lifespan and handed to `TELEGRAM.configure`).

Lives in the API package because everything it composes — the candle-fetch
path, the broker registry, the /ws/state broadcast — is API-layer
infrastructure; `core/telegram_notify` stays a leaf that only sees the
`AlertHooks` callables.
"""

from __future__ import annotations

import asyncio
import logging
import math
from collections.abc import Awaitable, Callable
from typing import Any

from auto_trader.api import deps
from auto_trader.api.auth import auth_enabled, can_deal_from_telegram
from auto_trader.core.account_alert_kind import account_label
from auto_trader.core.account_monitor import ACCOUNT_MONITOR
from auto_trader.core.alert_engine import ALERT_ENGINE
from auto_trader.core.alert_kinds import upgrade_params
from auto_trader.core.alert_store import ALERT_STORE
from auto_trader.core.models import Candle, OrderStatus
from auto_trader.core.position_watch import POSITION_WATCH, TOKEN_TTL_S, PositionWatch
from auto_trader.core.telegram_notify import AlertHooks, RemovalRefused

log = logging.getLogger(__name__)

_POSITIONS_PER_ACCOUNT_TIMEOUT = 3.0


async def _get_candles(broker: str, epic: str, timeframe: str, count: int) -> list[Candle]:
    """Cached candle fetch for the snapshot image — the same path the chart
    API uses, so a snapshot render never hammers the broker. Raises on
    failure (unknown broker/timeframe, no data); the Telegram layer treats
    any raise as "send text instead"."""
    return await deps._fetch_symbol_candles(
        broker, epic, timeframe, count, None, None, "mid"
    )


async def _get_positions(broker: str, epic: str) -> list[dict]:
    """Open positions on (broker, epic) across every exec account registered
    under that broker id (e.g. capital:paper AND capital:demo), each line
    labeled with its env. Hosted mode returns [] — exec accounts are global
    and admin-gated there, so their contents must not leak into an arbitrary
    linked user's DM."""
    if auth_enabled():
        return []
    registry = deps._registry
    if registry is None:
        return []
    out: list[dict] = []
    for key, exec_broker in registry.exec.items():
        if key.split(":", 1)[0] != broker:
            continue
        try:
            positions = await asyncio.wait_for(
                exec_broker.get_positions(epic), timeout=_POSITIONS_PER_ACCOUNT_TIMEOUT
            )
        except Exception:
            log.warning("alert hooks: positions for %s unavailable", key)
            continue
        for p in positions:
            out.append(
                {
                    "side": p.side.value,
                    "quantity": p.quantity,
                    "open_level": p.open_level,
                    "upnl": p.upnl,
                    "env": exec_broker.env,
                }
            )
    return out


async def _changed_broadcast(user_id: str, broker: str, epic: str) -> None:
    from auto_trader.api.routers.state import broadcast_to_user

    await broadcast_to_user(
        user_id,
        {
            "key": "__alerts__:changed",
            "value": {"broker": broker, "epic": epic, "origin": "telegram"},
        },
    )


async def _rearm(user_id: str, row: dict) -> dict | None:
    if row.get("kind") == "indicator":
        try:
            row = {**row, "params": upgrade_params(row["params"])}
        except ValueError:
            # The stored params predate a registry change this upgrade can't
            # follow (unknown indicator, malformed calcParams/config) - skip
            # the re-arm rather than let a bad history row crash the hook.
            log.warning("rearm: alert %s indicator params could not be upgraded, skipping", row.get("id"))
            return None
    created = await ALERT_STORE.create(user_id, row)  # ValueError if id exists
    _registry_for(created.get("kind")).on_alert_changed(user_id, created, created["id"])
    await _changed_broadcast(user_id, created["broker"], created["epic"])
    return created


def _registry_for(kind: str | None):
    """Account alerts belong to the monitor and position alerts to the
    position watch; the price engine must never see either (it would open a
    feed for ("capital-live:live", "")). Mirrors the router's `_notify`
    dispatch."""
    if kind == "account":
        return ACCOUNT_MONITOR
    if kind == "position":
        return POSITION_WATCH
    return ALERT_ENGINE


def _snooze(user_id: str, alert_id: str, seconds: float) -> None:
    ALERT_ENGINE.snooze(user_id, alert_id, seconds)


async def _delete(user_id: str, alert_id: str) -> bool:
    # Resolve the row first: the tab broadcast needs its broker/epic.
    rows = await ALERT_STORE.list_user(user_id)
    row = next((r for r in rows if r["id"] == alert_id), None)
    if row is None:
        return False
    deleted = await ALERT_STORE.delete(user_id, alert_id)
    if deleted:
        _registry_for(row.get("kind")).on_alert_changed(user_id, None, alert_id)
        await _changed_broadcast(user_id, row["broker"], row["epic"])
    return deleted


# ---- Telegram "Remove SL/TP" (a real dealing action) ----

UNKNOWN_TOKEN = "This warning was already used or has expired"
GATE_REFUSED = "Removing a stop from Telegram needs your user id in ADMIN_USER_IDS"
TOO_OLD = "This warning is too old (over 10 minutes)"
CLOSED = "Position is already closed"
TRAILING = "Trailing stop: remove it in the broker"
ALERT_GONE = "This alert was deleted"
_MODIFY_TIMEOUT_S = 20.0
_REASON_MAX = 150


def _label(side: str) -> str:
    return "SL" if side == "sl" else "TP"


class PositionRemoval:
    """The two hooks behind a position alert's Remove button: `describe`
    (the confirm question, on the Remove tap) and `remove` (the Yes tap).

    Token rules: `describe` only peeks. `remove` refuses a token that is not
    this chat user's WITHOUT consuming it (a stranger's tap must not burn the
    owner's warning), and consumes it on every other attempt, refused or not,
    so a stale or changed warning can never be retried into a removal.

    Dependencies are injected so tests run it over a fake broker and clock;
    `build_alert_hooks` wires the app singletons."""

    def __init__(
        self, *, watch: PositionWatch, get_exec: Callable[[str], Any],
        delete: Callable[[str, str], Awaitable[bool]], can_deal: Callable[[str], bool],
    ) -> None:
        self._watch = watch
        self._get_exec = get_exec
        self._delete = delete
        self._can_deal = can_deal

    def _fresh(self, tok) -> bool:
        return self._watch.now() - tok.minted_at <= TOKEN_TTL_S

    async def describe(self, user_id: str, token: str) -> str | None:
        tok = self._watch.peek_remove_token(token)
        if tok is None or tok.user_id != user_id or not self._fresh(tok):
            return None
        if not self._can_deal(user_id):
            # Refused on the first tap: no confirm message, token kept.
            raise RemovalRefused(GATE_REFUSED)
        what = _label(tok.side)
        direction = {"BUY": "long", "SELL": "short"}.get(tok.direction, "")
        target = " ".join(p for p in (tok.epic, direction) if p) or "this position"
        # The account is named so a demo and a live position can't be mixed up.
        return (f"Remove {what} on {target} ({what} {tok.level:.{tok.precision}f})"
                f" · {account_label(tok.account)}?")

    async def remove(self, user_id: str, token: str) -> str:
        peeked = self._watch.peek_remove_token(token)
        if peeked is None or peeked.user_id != user_id:
            return UNKNOWN_TOKEN
        tok = self._watch.take_remove_token(token)
        if tok is None:  # taken between the peek and here
            return UNKNOWN_TOKEN
        what = _label(tok.side)
        if not self._can_deal(user_id):
            return GATE_REFUSED
        if not self._fresh(tok):
            return TOO_OLD
        try:
            snap = await self._watch.snapshot(tok.account, tok.deal_id)
        except Exception:
            log.warning("telegram remove: snapshot failed for %s", tok.account, exc_info=True)
            return f"Couldn't remove {what}: broker unreachable"
        if snap is None:
            return CLOSED
        if snap.trailing:
            return TRAILING
        current = snap.sl if tok.side == "sl" else snap.tp
        tol = 0.5 * 10 ** -tok.precision
        if current is None or not math.isclose(current, tok.level, rel_tol=0, abs_tol=tol):
            return f"{what} has changed since this warning"
        if not self._watch.has_alert(user_id, tok.alert_id):
            return ALERT_GONE
        kwargs = {"clear_stop": True} if tok.side == "sl" else {"clear_take_profit": True}
        try:
            result = await asyncio.wait_for(
                self._get_exec(tok.account).modify_position(tok.deal_id, **kwargs),
                timeout=_MODIFY_TIMEOUT_S,
            )
        except (asyncio.TimeoutError, TimeoutError):
            # The broker may still apply it: never claim it failed.
            log.warning("telegram remove: modify timed out for %s deal %s", tok.account, tok.deal_id)
            return f"Couldn't confirm {what} removal: check the broker"
        except Exception as exc:
            log.warning("telegram remove: modify failed for %s", tok.account, exc_info=True)
            reason = str(exc) or type(exc).__name__
            return f"Couldn't remove {what}: {reason[:_REASON_MAX]}"
        if result.status is OrderStatus.UNKNOWN:
            return f"Couldn't confirm {what} removal: check the broker"
        if result.status is OrderStatus.REJECTED:
            reason = result.reason or "rejected"
            return f"Couldn't remove {what}: {reason[:_REASON_MAX]}"
        log.info("telegram remove: %s cleared on %s deal %s by %s", what, tok.account, tok.deal_id, user_id)
        try:
            await self._delete(user_id, tok.alert_id)
        except Exception:
            # The level is gone on the broker; the watch's next poll deletes
            # the row anyway, so this must not turn a success into an error.
            log.warning("telegram remove: alert delete failed user=%s alert=%s",
                        user_id, tok.alert_id, exc_info=True)
        return f"{what} removed ✓"


def build_alert_hooks() -> AlertHooks:
    removal = PositionRemoval(
        watch=POSITION_WATCH, get_exec=deps.get_exec, delete=_delete,
        can_deal=can_deal_from_telegram,
    )
    return AlertHooks(
        get_candles=_get_candles,
        get_positions=_get_positions,
        rearm=_rearm,
        snooze=_snooze,
        delete=_delete,
        describe_removal=removal.describe,
        remove_level=removal.remove,
    )
