"""One-shot migration of legacy localStorage alert blobs (mirrored into
`StateStore` by the `/api/state` sync) into `alerts.db` (`AlertStore`).

Before the backend alert engine, alerts lived entirely in the browser under
per-broker, per-epic keys (`frontend/src/lib/persist/alerts.ts`):
`auto-trader.b.<broker>.alerts.<epic>` -> a JSON list of `SavedAlert`-shaped
rows, with two associated global keys for the triggered-history log
(`auto-trader.triggered`) and its "seen" watermark (`auto-trader.triggeredSeen`).
Since the `/api/state` sync mirrors every localStorage write into `StateStore`
byte-for-byte (opaque JSON strings), those blobs are sitting in `app_state`
for every user who ever used alerts pre-migration. This module lifts them
into the real alert store exactly once.

Defaults mirror `normalizeAlert` in alerts.ts: `condition` -> "crossing",
`trigger` -> "every", `message` -> "", `expiresAt` -> null, `notify` -> all
channels on. A row missing `id` (every legacy row, since ids didn't exist
originally) gets a fresh `al-<uuid4>` — NOT the frontend's deterministic
index-derived `lg-*` id, since that scheme exists only to keep multiple
readers of the same in-browser list agreeing before persist; the backend
mints once, on the single migration pass, so a fresh uuid4 is sufficient and
avoids any accidental in-flight index-based collision.

Safety: a blob that fails to parse (bad JSON, not a list) is SKIPPED and its
state key is LEFT IN PLACE — never delete what wasn't imported. A row that
fails to import for its own reason (missing `level`, duplicate id) is skipped
individually; it does not block its siblings or leave the whole key
un-migrated. A cleanly-processed key (every row attempted) is deleted from
StateStore afterward, so this function is idempotent: a second run sees no
legacy keys and returns 0.
"""

from __future__ import annotations

import json
import logging
import re
import uuid

logger = logging.getLogger(__name__)

# Matches `auto-trader.b.<broker>.alerts.<epic>`, capturing (broker, epic).
# Mirrors ALERTS_KEY_RE in frontend/src/lib/persist/alerts.ts.
_ALERTS_KEY_RE = re.compile(r"^auto-trader\.b\.([^.]+)\.alerts\.(.+)$")

# Global keys from frontend/src/lib/persist/alerts.ts (TRIGGERED_KEY,
# TRIGGERED_SEEN_KEY) — not per-broker/per-epic, one per user.
_TRIGGERED_KEY = "auto-trader.triggered"
_TRIGGERED_SEEN_KEY = "auto-trader.triggeredSeen"
_TRIGGERED_SEEN_META_KEY = "triggered_seen"

_NOTIFY_CHANNELS = ("toast", "browser", "sound")


def _normalize_legacy_row(raw: dict, broker: str, epic: str) -> dict:
    """Defaults per normalizeAlert(); raises KeyError/TypeError on a row
    that isn't even alert-shaped (no `level`), which the caller catches."""
    level = raw["level"]
    notify_in = raw.get("notify") or {}
    notify = {ch: notify_in.get(ch, True) for ch in _NOTIFY_CHANNELS}
    notify["push"] = True
    notify["telegram"] = True
    return {
        "id": raw.get("id") or f"al-{uuid.uuid4()}",
        "broker": broker,
        "epic": epic,
        "kind": "price_level",
        "params": {
            "level": level,
            "condition": raw.get("condition", "crossing"),
            "trigger": raw.get("trigger", "every"),
        },
        "message": raw.get("message", ""),
        "expires_at": raw.get("expiresAt"),
        "notify": notify,
        "precision": 2,
        "active": 1,
    }


async def _migrate_alert_keys(state_store, alert_store, user: str, state: dict) -> int:
    imported = 0
    migrated_keys: list[str] = []
    for key, raw_value in state.items():
        m = _ALERTS_KEY_RE.match(key)
        if not m:
            continue
        broker, epic = m.group(1), m.group(2)
        try:
            legacy_rows = json.loads(raw_value)
            if not isinstance(legacy_rows, list):
                raise ValueError("legacy alerts blob is not a list")
        except (json.JSONDecodeError, ValueError):
            logger.warning("alert migration: skipping unparseable blob user=%s key=%s", user, key)
            continue

        for legacy_row in legacy_rows:
            try:
                row = _normalize_legacy_row(legacy_row, broker, epic)
            except (KeyError, TypeError):
                logger.warning(
                    "alert migration: skipping malformed row user=%s key=%s row=%r",
                    user, key, legacy_row,
                )
                continue
            try:
                await alert_store.create(user, row)
                imported += 1
            except ValueError:
                logger.warning(
                    "alert migration: skipping duplicate id user=%s key=%s id=%s",
                    user, key, row["id"],
                )
        migrated_keys.append(key)

    for key in migrated_keys:
        await state_store.delete(user, key)
    return imported


async def _migrate_triggered_log(state_store, alert_store, user: str, state: dict) -> None:
    raw_value = state.get(_TRIGGERED_KEY)
    if raw_value is not None:
        try:
            entries = json.loads(raw_value)
            if not isinstance(entries, list):
                raise ValueError("legacy triggered log is not a list")
            for entry in entries:
                await alert_store.add_triggered(
                    user,
                    {
                        "time": entry["time"],
                        "alert_id": entry.get("alertId", ""),
                        "broker": "",
                        "epic": entry["epic"],
                        "kind": "price_level",
                        "price": entry["price"],
                        "level": entry["level"],
                        "condition": entry["condition"],
                        "message": entry.get("message", ""),
                        "precision": entry.get("precision", 2),
                    },
                )
        except (json.JSONDecodeError, ValueError, KeyError, TypeError):
            logger.warning("alert migration: skipping unparseable triggered log user=%s", user)
        else:
            await state_store.delete(user, _TRIGGERED_KEY)

    seen_raw = state.get(_TRIGGERED_SEEN_KEY)
    if seen_raw is not None:
        try:
            seen = json.loads(seen_raw)
        except json.JSONDecodeError:
            logger.warning("alert migration: skipping unparseable triggered-seen user=%s", user)
        else:
            await alert_store.set_meta(user, _TRIGGERED_SEEN_META_KEY, str(seen))
            await state_store.delete(user, _TRIGGERED_SEEN_KEY)


async def migrate_legacy_alerts(state_store, alert_store) -> int:
    """Sweep every user's StateStore document for legacy alert blobs and the
    triggered-history log, importing them into `alert_store`. Returns the
    count of price-level alert rows imported (the triggered log/watermark
    don't count toward this — they aren't "alerts"). Idempotent: run again
    after a clean pass and it returns 0."""
    imported = 0
    for user in await state_store.list_users():
        state = await state_store.get_all(user)
        if not state:
            continue
        imported += await _migrate_alert_keys(state_store, alert_store, user, state)
        # `state` is the one snapshot fetched above; the alert-key pass only
        # deletes per-epic alert keys from the store, never the triggered/seen
        # keys, so this dict is still accurate for them.
        await _migrate_triggered_log(state_store, alert_store, user, state)
    return imported
