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

from auto_trader.api import deps
from auto_trader.api.auth import auth_enabled
from auto_trader.core.alert_engine import ALERT_ENGINE
from auto_trader.core.alert_store import ALERT_STORE
from auto_trader.core.models import Candle
from auto_trader.core.telegram_notify import AlertHooks

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


async def _rearm(user_id: str, row: dict) -> dict:
    created = await ALERT_STORE.create(user_id, row)  # ValueError if id exists
    ALERT_ENGINE.on_alert_changed(user_id, created, created["id"])
    await _changed_broadcast(user_id, created["broker"], created["epic"])
    return created


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
        ALERT_ENGINE.on_alert_changed(user_id, None, alert_id)
        await _changed_broadcast(user_id, row["broker"], row["epic"])
    return deleted


def build_alert_hooks() -> AlertHooks:
    return AlertHooks(
        get_candles=_get_candles,
        get_positions=_get_positions,
        rearm=_rearm,
        snooze=_snooze,
        delete=_delete,
    )
