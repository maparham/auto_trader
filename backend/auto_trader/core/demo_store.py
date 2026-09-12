"""Published demo snapshots: the layout + watchlist + canned backtests the
public home page serves to signed-out visitors.

Append-only and versioned: every publish is a new row, latest wins, rollback
is republishing an old payload as a new version (done in the router). Payload
is an opaque JSON string, never parsed here, exactly like state_store."""

from __future__ import annotations

import asyncio
import os
import sqlite3
import time

_SCHEMA = (
    "CREATE TABLE IF NOT EXISTS demo_snapshot ("
    "version INTEGER PRIMARY KEY AUTOINCREMENT, "
    "payload TEXT NOT NULL, published_by TEXT NOT NULL, "
    "created_at INTEGER NOT NULL)"
)


class DemoStore:
    def __init__(self, db_path: str) -> None:
        self._db_path = db_path

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._db_path, timeout=5.0)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute(_SCHEMA)
        conn.commit()
        return conn

    async def publish(self, payload: str, published_by: str) -> int:
        return await asyncio.to_thread(self._publish_sync, payload, published_by)

    def _publish_sync(self, payload: str, published_by: str) -> int:
        conn = self._connect()
        try:
            cur = conn.execute(
                "INSERT INTO demo_snapshot (payload, published_by, created_at) "
                "VALUES (?, ?, ?)",
                (payload, published_by, int(time.time())),
            )
            conn.commit()
            return int(cur.lastrowid)
        finally:
            conn.close()

    async def latest(self) -> tuple[int, str] | None:
        return await asyncio.to_thread(self._latest_sync)

    def _latest_sync(self) -> tuple[int, str] | None:
        conn = self._connect()
        try:
            row = conn.execute(
                "SELECT version, payload FROM demo_snapshot "
                "ORDER BY version DESC LIMIT 1"
            ).fetchone()
            return (int(row[0]), row[1]) if row else None
        finally:
            conn.close()

    async def get(self, version: int) -> str | None:
        return await asyncio.to_thread(self._get_sync, version)

    def _get_sync(self, version: int) -> str | None:
        conn = self._connect()
        try:
            row = conn.execute(
                "SELECT payload FROM demo_snapshot WHERE version = ?", (version,)
            ).fetchone()
            return row[0] if row else None
        finally:
            conn.close()

    async def versions(self) -> list[dict]:
        return await asyncio.to_thread(self.versions_sync)

    def versions_sync(self) -> list[dict]:
        conn = self._connect()
        try:
            rows = conn.execute(
                "SELECT version, published_by, created_at, length(payload) "
                "FROM demo_snapshot ORDER BY version DESC LIMIT 50"
            ).fetchall()
            return [
                {
                    "version": int(v),
                    "publishedBy": by,
                    "createdAt": int(ts),
                    "size": int(size),
                }
                for v, by, ts, size in rows
            ]
        finally:
            conn.close()


# Module singleton, mirroring the pattern from state_store
_DEMO_STORE: DemoStore | None = None


def get_demo_store() -> DemoStore:
    """Lazy singleton getter for the demo store, configured from the DEMO_DB
    environment variable (default: demo_store.db)."""
    global _DEMO_STORE
    if _DEMO_STORE is None:
        _DEMO_STORE = DemoStore(os.environ.get("DEMO_DB", "demo_store.db"))
    return _DEMO_STORE
