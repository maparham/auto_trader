"""The assistant gateway key an admin set from /admin, overriding
ASSISTANT_API_KEY. One row, no history: clearing it falls back to the env key.

Stored as plaintext in a 0600 file: an encryption key would have to live on
the same box, which buys nothing over the env file it replaces. Default
rollback journal rather than WAL, because the deploy rsync keeps only `*.db`
and would delete a `-wal` sidecar holding the last write."""

from __future__ import annotations

import os
import sqlite3
import time
from dataclasses import dataclass

_SCHEMA = (
    "CREATE TABLE IF NOT EXISTS assistant_key ("
    "id INTEGER PRIMARY KEY CHECK (id = 1), "
    "api_key TEXT NOT NULL, set_by TEXT NOT NULL, set_at INTEGER NOT NULL)"
)


@dataclass(frozen=True)
class StoredKey:
    api_key: str
    set_by: str
    set_at: int


class AssistantKeyStore:
    def __init__(self, db_path: str) -> None:
        self._db_path = db_path

    def _connect(self) -> sqlite3.Connection:
        fresh = not os.path.exists(self._db_path)
        conn = sqlite3.connect(self._db_path, timeout=5.0)
        if fresh:
            os.chmod(self._db_path, 0o600)
        conn.execute(_SCHEMA)
        conn.commit()
        return conn

    def get(self) -> StoredKey | None:
        conn = self._connect()
        try:
            row = conn.execute(
                "SELECT api_key, set_by, set_at FROM assistant_key WHERE id = 1"
            ).fetchone()
            return StoredKey(row[0], row[1], int(row[2])) if row else None
        finally:
            conn.close()

    def set(self, api_key: str, set_by: str) -> StoredKey:
        stored = StoredKey(api_key, set_by, int(time.time()))
        conn = self._connect()
        try:
            conn.execute(
                "INSERT OR REPLACE INTO assistant_key (id, api_key, set_by, set_at) "
                "VALUES (1, ?, ?, ?)",
                (stored.api_key, stored.set_by, stored.set_at),
            )
            conn.commit()
            return stored
        finally:
            conn.close()

    def clear(self) -> None:
        conn = self._connect()
        try:
            conn.execute("DELETE FROM assistant_key")
            conn.commit()
        finally:
            conn.close()


_STORE: AssistantKeyStore | None = None


def get_assistant_key_store() -> AssistantKeyStore:
    """Lazy singleton, path from ASSISTANT_KEY_DB (default assistant_key.db)."""
    global _STORE
    if _STORE is None:
        _STORE = AssistantKeyStore(os.environ.get("ASSISTANT_KEY_DB", "assistant_key.db"))
    return _STORE
