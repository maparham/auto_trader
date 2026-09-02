"""Chart workspace persistence: a sqlite key-value mirror of the frontend's
localStorage so layouts/drawings/indicators/alerts survive across browsers and
devices.

The store is per-user keyed since the SaaS partitioning — each user gets their
own state document, isolated from every other user's. Each row is one
localStorage entry: `key` is the exact frontend key (e.g. `auto-trader.tabs`,
`auto-trader.tab.<id>.drawings.<epic>`) and `value` is its raw JSON string, stored
OPAQUELY — the backend never parses or interprets it. It's a remote localStorage.

Storage is stdlib sqlite3 (no new dependency, same choice as `tick_store.py`), so
state survives process restarts — the dev server runs under `uvicorn --reload`,
which would wipe an in-memory store on every edit. Sync model is
backend-wins-on-load (TradingView-style): the browser hydrates from here on
startup, and every localStorage write mirrors back per-key.

A fresh connection per operation (cheap for sqlite) sidesteps the
one-connection-per-thread rule, since writes/reads run via `asyncio.to_thread`.
"""

from __future__ import annotations

import asyncio
import sqlite3
import time

from auto_trader.core.db_migrate import run_migrations, table_columns

_SCHEMA = (
    "CREATE TABLE IF NOT EXISTS app_state ("
    "user_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, "
    "updated_at INTEGER, PRIMARY KEY (user_id, key))"
)


def _migrate_v1(conn: sqlite3.Connection) -> None:
    """PK change (key) -> (user_id, key): sqlite needs a table rebuild.
    A fresh DB already has the new shape — just stamp it."""
    if "user_id" in table_columns(conn, "app_state"):
        return
    conn.execute(
        "CREATE TABLE app_state_new ("
        "user_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, "
        "updated_at INTEGER, PRIMARY KEY (user_id, key))"
    )
    conn.execute(
        "INSERT INTO app_state_new SELECT 'dev', key, value, updated_at "
        "FROM app_state"
    )
    conn.execute("DROP TABLE app_state")
    conn.execute("ALTER TABLE app_state_new RENAME TO app_state")


class StateStore:
    """Sqlite-backed key-value store mirroring the frontend's localStorage,
    one document per user."""

    def __init__(self, db_path: str) -> None:
        self._db_path = db_path
        conn = self._connect()
        try:
            run_migrations(conn, {1: _migrate_v1})
        finally:
            conn.close()

    def _connect(self) -> sqlite3.Connection:
        # Ensure the schema on EVERY connection (not just construction) so reads
        # are robust to a db file from an older build or a different cwd — the
        # same defensive pattern tick_store uses against `no such table`.
        conn = sqlite3.connect(self._db_path, timeout=5.0)
        conn.execute("PRAGMA journal_mode=WAL")  # concurrent reads during writes
        conn.execute(_SCHEMA)
        conn.commit()
        return conn

    async def get_all(self, user_id: str) -> dict[str, str]:
        """Every stored key -> its raw JSON value string for one user (one
        startup snapshot)."""
        return await asyncio.to_thread(self._get_all_sync, user_id)

    def _get_all_sync(self, user_id: str) -> dict[str, str]:
        conn = self._connect()
        try:
            rows = conn.execute(
                "SELECT key, value FROM app_state WHERE user_id = ?", (user_id,)
            ).fetchall()
            return {k: v for k, v in rows}
        finally:
            conn.close()

    async def set(self, user_id: str, key: str, value: str) -> None:
        """Upsert one key's raw JSON value string for one user."""
        await asyncio.to_thread(self._set_sync, user_id, key, value)

    def _set_sync(self, user_id: str, key: str, value: str) -> None:
        conn = self._connect()
        try:
            conn.execute(
                "INSERT INTO app_state (user_id, key, value, updated_at) "
                "VALUES (?, ?, ?, ?) "
                "ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, "
                "updated_at = excluded.updated_at",
                (user_id, key, value, int(time.time() * 1000)),
            )
            conn.commit()
        finally:
            conn.close()

    async def delete(self, user_id: str, key: str) -> None:
        """Remove one key for one user (idempotent — a missing key is a no-op)."""
        await asyncio.to_thread(self._delete_sync, user_id, key)

    def _delete_sync(self, user_id: str, key: str) -> None:
        conn = self._connect()
        try:
            conn.execute(
                "DELETE FROM app_state WHERE user_id = ? AND key = ?",
                (user_id, key),
            )
            conn.commit()
        finally:
            conn.close()


# Module singleton, configured from settings. Imported by the API layer (read on
# the startup hydrate, written on every mirrored localStorage change).
from auto_trader.config import settings  # noqa: E402  (after class def, avoids cycle)

STATE_STORE = StateStore(settings.state_db_path)
