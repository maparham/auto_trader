"""Chart workspace persistence: a sqlite key-value mirror of the frontend's
localStorage so layouts/drawings/indicators/alerts survive across browsers and
devices.

The app is single-user (one shared broker, account-level favourites, no auth), so
this is ONE global state document — not per-user keyed. Each row is one
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


class StateStore:
    """Sqlite-backed key-value store mirroring the frontend's localStorage."""

    def __init__(self, db_path: str) -> None:
        self._db_path = db_path
        self._connect().close()  # create the db file + schema up front

    def _connect(self) -> sqlite3.Connection:
        # Ensure the schema on EVERY connection (not just construction) so reads
        # are robust to a db file from an older build or a different cwd — the
        # same defensive pattern tick_store uses against `no such table`.
        conn = sqlite3.connect(self._db_path, timeout=5.0)
        conn.execute("PRAGMA journal_mode=WAL")  # concurrent reads during writes
        conn.execute(
            "CREATE TABLE IF NOT EXISTS app_state ("
            "key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER)"
        )
        conn.commit()
        return conn

    async def get_all(self) -> dict[str, str]:
        """Every stored key -> its raw JSON value string (one startup snapshot)."""
        return await asyncio.to_thread(self._get_all_sync)

    def _get_all_sync(self) -> dict[str, str]:
        conn = self._connect()
        try:
            rows = conn.execute("SELECT key, value FROM app_state").fetchall()
            return {k: v for k, v in rows}
        finally:
            conn.close()

    async def set(self, key: str, value: str) -> None:
        """Upsert one key's raw JSON value string."""
        await asyncio.to_thread(self._set_sync, key, value)

    def _set_sync(self, key: str, value: str) -> None:
        conn = self._connect()
        try:
            conn.execute(
                "INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value, "
                "updated_at = excluded.updated_at",
                (key, value, int(time.time() * 1000)),
            )
            conn.commit()
        finally:
            conn.close()

    async def delete(self, key: str) -> None:
        """Remove one key (idempotent — a missing key is a no-op)."""
        await asyncio.to_thread(self._delete_sync, key)

    def _delete_sync(self, key: str) -> None:
        conn = self._connect()
        try:
            conn.execute("DELETE FROM app_state WHERE key = ?", (key,))
            conn.commit()
        finally:
            conn.close()


# Module singleton, configured from settings. Imported by the API layer (read on
# the startup hydrate, written on every mirrored localStorage change).
from auto_trader.config import settings  # noqa: E402  (after class def, avoids cycle)

STATE_STORE = StateStore(settings.state_db_path)
