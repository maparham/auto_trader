"""Price-alert persistence: definitions, triggered history, web-push
subscriptions and Telegram links, one sqlite home per user.

Alerts move to the backend so they fire even when no browser tab is open — the
engine (a later task) evaluates every active alert against live prices and
records a hit in `triggered`. This store is dumb storage only: no evaluation
logic lives here.

Rows travel as plain dicts. `params` and `notify` are stored as JSON strings
(sqlite has no native JSON/dict type) and parsed back into dicts at the read
boundary, so callers never see a JSON string. `notify` additionally has
per-channel defaults applied on read: a channel not explicitly stored is
treated as enabled (`True`) — this lets the frontend/API write only the
channels a user has turned OFF.

Storage is stdlib sqlite3 (no new dependency, same choice as `tick_store.py`
and `state_store.py`), so alerts survive process restarts — the dev server
runs under `uvicorn --reload`, which would wipe an in-memory store on every
edit.

A fresh connection per operation (cheap for sqlite) sidesteps the
one-connection-per-thread rule, since writes/reads run via `asyncio.to_thread`.
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
import time

from auto_trader.core.db_migrate import run_migrations, table_columns

_SCHEMA = """
CREATE TABLE IF NOT EXISTS alerts (
  user_id TEXT NOT NULL, id TEXT NOT NULL,
  broker TEXT NOT NULL, epic TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'price_level',
  params TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  expires_at INTEGER,
  notify TEXT NOT NULL DEFAULT '{}',
  precision INTEGER NOT NULL DEFAULT 2,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id));
CREATE INDEX IF NOT EXISTS idx_alerts_feed ON alerts (broker, epic);
CREATE TABLE IF NOT EXISTS triggered (
  user_id TEXT NOT NULL, time INTEGER NOT NULL, alert_id TEXT NOT NULL,
  broker TEXT NOT NULL, epic TEXT NOT NULL, kind TEXT NOT NULL,
  price REAL NOT NULL, level REAL NOT NULL, condition TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '', precision INTEGER NOT NULL DEFAULT 2,
  alert_json TEXT);
CREATE INDEX IF NOT EXISTS idx_triggered_user ON triggered (user_id, time);
CREATE TABLE IF NOT EXISTS alert_meta (
  user_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
  PRIMARY KEY (user_id, key));
CREATE TABLE IF NOT EXISTS push_subscriptions (
  user_id TEXT NOT NULL, endpoint TEXT NOT NULL PRIMARY KEY,
  keys TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS telegram_links (
  user_id TEXT NOT NULL PRIMARY KEY, chat_id TEXT NOT NULL,
  linked_at INTEGER NOT NULL);
"""

_NOTIFY_CHANNELS = ("toast", "browser", "sound", "push", "telegram")

# Patch keys `update()` accepts — a shallow merge onto the stored row.
_UPDATABLE_FIELDS = ("params", "message", "expires_at", "notify", "precision", "active")


def _migrate_triggered_alert_json(conn: sqlite3.Connection) -> None:
    # Pre-existing DBs from before the Telegram re-arm button: `triggered` gains
    # `alert_json` (the fired alert's full row, so a `once` alert deleted on
    # firing can be recreated from its history entry). Fresh DBs get the column
    # from _SCHEMA already, hence the introspection guard.
    if "alert_json" not in table_columns(conn, "triggered"):
        conn.execute("ALTER TABLE triggered ADD COLUMN alert_json TEXT")


def _row_to_dict(row: sqlite3.Row) -> dict:
    d = dict(row)
    d.pop("user_id", None)  # caller already has it (list_user's arg, or list_all's tuple)
    d["params"] = json.loads(d["params"])
    stored_notify = json.loads(d["notify"])
    d["notify"] = {ch: stored_notify.get(ch, True) for ch in _NOTIFY_CHANNELS}
    return d


class AlertStore:
    """Sqlite-backed store for price alerts, triggered history, push
    subscriptions and Telegram links, one document per user."""

    def __init__(self, db_path: str) -> None:
        self._db_path = db_path
        conn = self._connect()
        try:
            run_migrations(conn, {1: _migrate_triggered_alert_json})
        finally:
            conn.close()

    def _connect(self) -> sqlite3.Connection:
        # Ensure the schema on EVERY connection (not just construction) so reads
        # are robust to a db file from an older build or a different cwd — the
        # same defensive pattern tick_store/state_store use.
        conn = sqlite3.connect(self._db_path, timeout=5.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")  # concurrent reads during writes
        conn.executescript(_SCHEMA)
        conn.commit()
        return conn

    # ---- alerts ----

    async def list_user(self, user_id: str) -> list[dict]:
        return await asyncio.to_thread(self._list_user_sync, user_id)

    def _list_user_sync(self, user_id: str) -> list[dict]:
        conn = self._connect()
        try:
            rows = conn.execute(
                "SELECT * FROM alerts WHERE user_id = ? ORDER BY created_at", (user_id,)
            ).fetchall()
            return [_row_to_dict(r) for r in rows]
        finally:
            conn.close()

    async def list_all(self) -> list[tuple[str, dict]]:
        return await asyncio.to_thread(self._list_all_sync)

    def _list_all_sync(self) -> list[tuple[str, dict]]:
        conn = self._connect()
        try:
            rows = conn.execute("SELECT * FROM alerts ORDER BY user_id, created_at").fetchall()
            return [(r["user_id"], _row_to_dict(r)) for r in rows]
        finally:
            conn.close()

    async def create(self, user_id: str, row: dict) -> dict:
        return await asyncio.to_thread(self._create_sync, user_id, row)

    def _create_sync(self, user_id: str, row: dict) -> dict:
        conn = self._connect()
        try:
            # The PK constraint (user_id, id) is the real guard against a
            # duplicate id — this INSERT can lose a race to a concurrent
            # create for the same id, so the IntegrityError from the
            # constraint (not a pre-check SELECT) is what maps to the
            # documented ValueError.
            try:
                conn.execute(
                    "INSERT INTO alerts (user_id, id, broker, epic, kind, params, message, "
                    "expires_at, notify, precision, active, created_at, updated_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        user_id,
                        row["id"],
                        row["broker"],
                        row["epic"],
                        row.get("kind", "price_level"),
                        json.dumps(row.get("params", {})),
                        row.get("message", ""),
                        row.get("expires_at"),
                        json.dumps(row.get("notify", {})),
                        row.get("precision", 2),
                        row.get("active", 1),
                        row.get("created_at", int(time.time() * 1000)),
                        row.get("updated_at", int(time.time() * 1000)),
                    ),
                )
            except sqlite3.IntegrityError as exc:
                raise ValueError(f"alert id already exists: {row['id']}") from exc
            conn.commit()
            saved = conn.execute(
                "SELECT * FROM alerts WHERE user_id = ? AND id = ?", (user_id, row["id"])
            ).fetchone()
            return _row_to_dict(saved)
        finally:
            conn.close()

    async def update(self, user_id: str, alert_id: str, patch: dict) -> dict | None:
        return await asyncio.to_thread(self._update_sync, user_id, alert_id, patch)

    def _update_sync(self, user_id: str, alert_id: str, patch: dict) -> dict | None:
        conn = self._connect()
        try:
            existing = conn.execute(
                "SELECT * FROM alerts WHERE user_id = ? AND id = ?", (user_id, alert_id)
            ).fetchone()
            if existing is None:
                return None
            merged = _row_to_dict(existing)
            for field in _UPDATABLE_FIELDS:
                if field in patch:
                    if field == "params":
                        # Sub-key merge, not replacement: a level drag PATCHes
                        # {level, condition, trigger} and must not silently drop
                        # keys it doesn't know about (e.g. the stored timeframe).
                        merged["params"] = {**merged["params"], **patch["params"]}
                    else:
                        merged[field] = patch[field]
            merged["updated_at"] = int(time.time() * 1000)
            conn.execute(
                "UPDATE alerts SET params = ?, message = ?, expires_at = ?, notify = ?, "
                "precision = ?, active = ?, updated_at = ? WHERE user_id = ? AND id = ?",
                (
                    json.dumps(merged["params"]),
                    merged["message"],
                    merged["expires_at"],
                    json.dumps(merged["notify"]),
                    merged["precision"],
                    merged["active"],
                    merged["updated_at"],
                    user_id,
                    alert_id,
                ),
            )
            conn.commit()
            saved = conn.execute(
                "SELECT * FROM alerts WHERE user_id = ? AND id = ?", (user_id, alert_id)
            ).fetchone()
            return _row_to_dict(saved)
        finally:
            conn.close()

    async def delete(self, user_id: str, alert_id: str) -> bool:
        return await asyncio.to_thread(self._delete_sync, user_id, alert_id)

    def _delete_sync(self, user_id: str, alert_id: str) -> bool:
        conn = self._connect()
        try:
            cur = conn.execute(
                "DELETE FROM alerts WHERE user_id = ? AND id = ?", (user_id, alert_id)
            )
            conn.commit()
            return cur.rowcount > 0
        finally:
            conn.close()

    # ---- triggered history ----

    async def add_triggered(self, user_id: str, entry: dict) -> int:
        """Insert one firing; returns its rowid (the Telegram re-arm button's
        stable, 64-byte-safe callback reference)."""
        return await asyncio.to_thread(self._add_triggered_sync, user_id, entry)

    def _add_triggered_sync(self, user_id: str, entry: dict) -> int:
        conn = self._connect()
        try:
            cur = conn.execute(
                "INSERT INTO triggered (user_id, time, alert_id, broker, epic, kind, price, "
                "level, condition, message, precision, alert_json) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    user_id,
                    entry["time"],
                    entry["alert_id"],
                    entry["broker"],
                    entry["epic"],
                    entry["kind"],
                    entry["price"],
                    entry["level"],
                    entry["condition"],
                    entry.get("message", ""),
                    entry.get("precision", 2),
                    entry.get("alert_json"),
                ),
            )
            rowid = cur.lastrowid
            # Prune to the newest 500 rows for this user.
            conn.execute(
                "DELETE FROM triggered WHERE user_id = ? AND rowid NOT IN ("
                "SELECT rowid FROM triggered WHERE user_id = ? "
                "ORDER BY time DESC, rowid DESC LIMIT 500)",
                (user_id, user_id),
            )
            conn.commit()
            return int(rowid or 0)
        finally:
            conn.close()

    async def get_triggered_row(self, rowid: int) -> dict | None:
        """One triggered entry by rowid — includes `user_id` and `alert_json`
        (unlike `list_triggered`, whose rows go to the frontend). Used by the
        Telegram re-arm callback to recover the fired alert's definition."""
        return await asyncio.to_thread(self._get_triggered_row_sync, rowid)

    def _get_triggered_row_sync(self, rowid: int) -> dict | None:
        conn = self._connect()
        try:
            row = conn.execute(
                "SELECT rowid, * FROM triggered WHERE rowid = ?", (rowid,)
            ).fetchone()
            return dict(row) if row is not None else None
        finally:
            conn.close()

    async def list_triggered(self, user_id: str) -> list[dict]:
        return await asyncio.to_thread(self._list_triggered_sync, user_id)

    def _list_triggered_sync(self, user_id: str) -> list[dict]:
        conn = self._connect()
        try:
            rows = conn.execute(
                "SELECT time, alert_id, broker, epic, kind, price, level, condition, "
                "message, precision FROM triggered WHERE user_id = ? ORDER BY time DESC, rowid DESC",
                (user_id,),
            ).fetchall()
            return [dict(r) for r in rows]
        finally:
            conn.close()

    async def clear_triggered(self, user_id: str) -> None:
        await asyncio.to_thread(self._clear_triggered_sync, user_id)

    def _clear_triggered_sync(self, user_id: str) -> None:
        conn = self._connect()
        try:
            conn.execute("DELETE FROM triggered WHERE user_id = ?", (user_id,))
            conn.commit()
        finally:
            conn.close()

    # ---- meta (triggered-seen watermark, VAPID keys under user_id "") ----

    async def get_meta(self, user_id: str, key: str) -> str | None:
        return await asyncio.to_thread(self._get_meta_sync, user_id, key)

    def _get_meta_sync(self, user_id: str, key: str) -> str | None:
        conn = self._connect()
        try:
            row = conn.execute(
                "SELECT value FROM alert_meta WHERE user_id = ? AND key = ?", (user_id, key)
            ).fetchone()
            return row["value"] if row is not None else None
        finally:
            conn.close()

    async def set_meta(self, user_id: str, key: str, value: str) -> None:
        await asyncio.to_thread(self._set_meta_sync, user_id, key, value)

    def _set_meta_sync(self, user_id: str, key: str, value: str) -> None:
        conn = self._connect()
        try:
            conn.execute(
                "INSERT INTO alert_meta (user_id, key, value) VALUES (?, ?, ?) "
                "ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value",
                (user_id, key, value),
            )
            conn.commit()
        finally:
            conn.close()

    # ---- web-push subscriptions ----

    async def add_push_sub(self, user_id: str, endpoint: str, keys: dict) -> None:
        await asyncio.to_thread(self._add_push_sub_sync, user_id, endpoint, keys)

    def _add_push_sub_sync(self, user_id: str, endpoint: str, keys: dict) -> None:
        conn = self._connect()
        try:
            conn.execute(
                "INSERT INTO push_subscriptions (user_id, endpoint, keys, created_at) "
                "VALUES (?, ?, ?, ?) "
                "ON CONFLICT(endpoint) DO UPDATE SET keys = excluded.keys, "
                "user_id = excluded.user_id",
                (user_id, endpoint, json.dumps(keys), int(time.time() * 1000)),
            )
            conn.commit()
        finally:
            conn.close()

    async def delete_push_sub(self, user_id: str, endpoint: str) -> None:
        await asyncio.to_thread(self._delete_push_sub_sync, user_id, endpoint)

    def _delete_push_sub_sync(self, user_id: str, endpoint: str) -> None:
        conn = self._connect()
        try:
            conn.execute(
                "DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?",
                (user_id, endpoint),
            )
            conn.commit()
        finally:
            conn.close()

    async def list_push_subs(self, user_id: str) -> list[dict]:
        return await asyncio.to_thread(self._list_push_subs_sync, user_id)

    def _list_push_subs_sync(self, user_id: str) -> list[dict]:
        conn = self._connect()
        try:
            rows = conn.execute(
                "SELECT endpoint, keys, created_at FROM push_subscriptions WHERE user_id = ?",
                (user_id,),
            ).fetchall()
            return [
                {"endpoint": r["endpoint"], "keys": json.loads(r["keys"]), "created_at": r["created_at"]}
                for r in rows
            ]
        finally:
            conn.close()

    # ---- telegram links ----

    async def set_telegram(self, user_id: str, chat_id: str) -> None:
        await asyncio.to_thread(self._set_telegram_sync, user_id, chat_id)

    def _set_telegram_sync(self, user_id: str, chat_id: str) -> None:
        conn = self._connect()
        try:
            conn.execute(
                "INSERT INTO telegram_links (user_id, chat_id, linked_at) VALUES (?, ?, ?) "
                "ON CONFLICT(user_id) DO UPDATE SET chat_id = excluded.chat_id, "
                "linked_at = excluded.linked_at",
                (user_id, chat_id, int(time.time() * 1000)),
            )
            conn.commit()
        finally:
            conn.close()

    async def get_telegram(self, user_id: str) -> str | None:
        return await asyncio.to_thread(self._get_telegram_sync, user_id)

    def _get_telegram_sync(self, user_id: str) -> str | None:
        conn = self._connect()
        try:
            row = conn.execute(
                "SELECT chat_id FROM telegram_links WHERE user_id = ?", (user_id,)
            ).fetchone()
            return row["chat_id"] if row is not None else None
        finally:
            conn.close()

    async def get_user_by_chat(self, chat_id: str) -> str | None:
        """Reverse link lookup: which user (if any) owns this Telegram chat.
        The authorization check for inline-button callbacks — a callback is
        honored only when its chat maps back to the alert's owner."""
        return await asyncio.to_thread(self._get_user_by_chat_sync, chat_id)

    def _get_user_by_chat_sync(self, chat_id: str) -> str | None:
        conn = self._connect()
        try:
            row = conn.execute(
                "SELECT user_id FROM telegram_links WHERE chat_id = ?", (chat_id,)
            ).fetchone()
            return row["user_id"] if row is not None else None
        finally:
            conn.close()

    async def delete_telegram(self, user_id: str) -> None:
        await asyncio.to_thread(self._delete_telegram_sync, user_id)

    def _delete_telegram_sync(self, user_id: str) -> None:
        conn = self._connect()
        try:
            conn.execute("DELETE FROM telegram_links WHERE user_id = ?", (user_id,))
            conn.commit()
        finally:
            conn.close()


# Module singleton, configured from settings. Imported by the API layer and the
# alert-evaluation engine.
from auto_trader.config import settings  # noqa: E402  (after class def, avoids cycle)

ALERT_STORE = AlertStore(settings.alerts_db_path)
