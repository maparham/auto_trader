"""Sweep archive persistence: every completed sweep (its axes + rows + optional
robust-window bounds) lands here so past sweeps can be listed and reopened in
the UI. The frontend posts the finished result set explicitly, so this works
identically for local and remote sweep jobs. Capped at the newest `cap` rows
PER USER, pruned on insert. Summaries (n_rows, best_net_pnl) are computed at
read time.

Same storage pattern as run_store.py: stdlib sqlite3, WAL, schema ensured on
every connection, fresh connection per op via asyncio.to_thread.

Rows are partitioned by user_id (hosted multi-user deployment); a pre-existing
DB migrates its rows to the literal 'dev' user (see _migrate_v1).
"""

from __future__ import annotations

import asyncio
import json
import sqlite3

from auto_trader.core.db_migrate import run_migrations, table_columns


def _migrate_v1(conn: sqlite3.Connection) -> None:
    if "user_id" in table_columns(conn, "sweeps"):
        return
    conn.execute("ALTER TABLE sweeps ADD COLUMN user_id TEXT NOT NULL DEFAULT 'dev'")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sweeps_user_created ON sweeps (user_id, created_at)")


class SweepStore:
    def __init__(self, db_path: str, cap: int = 50) -> None:
        self._db_path = db_path
        self._cap = cap
        conn = self._connect()
        try:
            run_migrations(conn, {1: _migrate_v1})
        finally:
            conn.close()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._db_path, timeout=5.0)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute(
            "CREATE TABLE IF NOT EXISTS sweeps ("
            "id TEXT PRIMARY KEY, user_id TEXT NOT NULL DEFAULT 'dev', "
            "created_at INTEGER, epic TEXT, timeframe TEXT, "
            "name TEXT, axes_json TEXT, rows_json TEXT, windows_json TEXT)"
        )
        # A pre-existing (pre-migration) `sweeps` table has no user_id column yet
        # — the index is created here for a fresh table, and by _migrate_v1
        # (idempotently) once the column lands on an old one.
        if "user_id" in table_columns(conn, "sweeps"):
            conn.execute("CREATE INDEX IF NOT EXISTS idx_sweeps_user_created ON sweeps (user_id, created_at)")
        conn.commit()
        return conn

    async def insert(self, user_id: str, rec: dict) -> None:
        await asyncio.to_thread(self._insert_sync, user_id, rec)

    def _insert_sync(self, user_id: str, rec: dict) -> None:
        conn = self._connect()
        try:
            existing = conn.execute(
                "SELECT user_id FROM sweeps WHERE id = ?", (rec["id"],),
            ).fetchone()
            if existing is not None and existing[0] != user_id:
                raise ValueError("id owned by another user")
            conn.execute(
                "INSERT OR REPLACE INTO sweeps (id, user_id, created_at, epic, timeframe, "
                "name, axes_json, rows_json, windows_json) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    rec["id"], user_id, rec["created_at"], rec["epic"], rec["timeframe"],
                    rec.get("name"),
                    json.dumps(rec["axes"]), json.dumps(rec["rows"]),
                    json.dumps(rec.get("windows")),
                ),
            )
            # rowid tiebreak: same-second inserts still prune by insertion order.
            conn.execute(
                "DELETE FROM sweeps WHERE user_id = ? AND id NOT IN "
                "(SELECT id FROM sweeps WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)",
                (user_id, user_id, self._cap),
            )
            conn.commit()
        finally:
            conn.close()

    async def list(self, user_id: str, limit: int = 50, epic: str | None = None) -> list[dict]:
        return await asyncio.to_thread(self._list_sync, user_id, limit, epic)

    def _list_sync(self, user_id: str, limit: int, epic: str | None) -> list[dict]:
        conn = self._connect()
        try:
            sql = (
                "SELECT id, created_at, epic, timeframe, name, rows_json FROM sweeps "
                "WHERE user_id = ?"
            )
            params: list = [user_id]
            if epic is not None:
                sql += " AND epic = ?"
                params.append(epic)
            sql += " ORDER BY created_at DESC, rowid DESC LIMIT ?"
            # Clamp: SQLite treats LIMIT -1 as unbounded, so a caller passing
            # ?limit=-1 must not defeat the cap. Never below 0, never above cap.
            params.append(max(0, min(limit, self._cap)))
            rows = conn.execute(sql, params).fetchall()
            out: list[dict] = []
            for r in rows:
                # One corrupt row must not 500 the whole listing: skip it and keep
                # the rest of the archive reachable.
                try:
                    parsed = json.loads(r[5])
                    nets = [
                        row["metrics"]["net_pnl"] for row in parsed
                        if row.get("metrics")
                        and row["metrics"].get("net_pnl") is not None
                    ]
                    out.append({
                        "id": r[0], "created_at": r[1], "epic": r[2],
                        "timeframe": r[3], "name": r[4], "n_rows": len(parsed),
                        "best_net_pnl": max(nets) if nets else None,
                    })
                except (ValueError, KeyError, TypeError):
                    continue
            return out
        finally:
            conn.close()

    async def get(self, user_id: str, sweep_id: str) -> dict | None:
        return await asyncio.to_thread(self._get_sync, user_id, sweep_id)

    def _get_sync(self, user_id: str, sweep_id: str) -> dict | None:
        conn = self._connect()
        try:
            r = conn.execute(
                "SELECT id, created_at, epic, timeframe, name, axes_json, "
                "rows_json, windows_json FROM sweeps WHERE user_id = ? AND id = ?",
                (user_id, sweep_id),
            ).fetchone()
            if r is None:
                return None
            return {
                "id": r[0], "created_at": r[1], "epic": r[2], "timeframe": r[3],
                "name": r[4], "axes": json.loads(r[5]),
                "rows": json.loads(r[6]), "windows": json.loads(r[7]),
            }
        finally:
            conn.close()

    async def delete(self, user_id: str, sweep_id: str) -> None:
        await asyncio.to_thread(self._delete_sync, user_id, sweep_id)

    def _delete_sync(self, user_id: str, sweep_id: str) -> None:
        conn = self._connect()
        try:
            conn.execute("DELETE FROM sweeps WHERE user_id = ? AND id = ?", (user_id, sweep_id))
            conn.commit()
        finally:
            conn.close()


# Module singleton, configured from settings (same pattern as RUN_STORE).
from auto_trader.config import settings  # noqa: E402  (after class def, avoids cycle)

SWEEP_STORE = SweepStore(settings.sweeps_db_path)
