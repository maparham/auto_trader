"""Sweep archive persistence: every completed sweep (its axes + rows + optional
robust-window bounds) lands here so past sweeps can be listed and reopened in
the UI. The frontend posts the finished result set explicitly, so this works
identically for local and remote sweep jobs. Capped at the newest `cap` rows,
pruned on insert. Summaries (n_rows, best_net_pnl) are computed at read time.

Same storage pattern as run_store.py: stdlib sqlite3, WAL, schema ensured on
every connection, fresh connection per op via asyncio.to_thread.
"""

from __future__ import annotations

import asyncio
import json
import sqlite3


class SweepStore:
    def __init__(self, db_path: str, cap: int = 50) -> None:
        self._db_path = db_path
        self._cap = cap
        self._connect().close()  # create the db file + schema up front

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._db_path, timeout=5.0)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute(
            "CREATE TABLE IF NOT EXISTS sweeps ("
            "id TEXT PRIMARY KEY, created_at INTEGER, epic TEXT, timeframe TEXT, "
            "name TEXT, axes_json TEXT, rows_json TEXT, windows_json TEXT)"
        )
        conn.commit()
        return conn

    async def insert(self, rec: dict) -> None:
        await asyncio.to_thread(self._insert_sync, rec)

    def _insert_sync(self, rec: dict) -> None:
        conn = self._connect()
        try:
            conn.execute(
                "INSERT OR REPLACE INTO sweeps (id, created_at, epic, timeframe, "
                "name, axes_json, rows_json, windows_json) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    rec["id"], rec["created_at"], rec["epic"], rec["timeframe"],
                    rec.get("name"),
                    json.dumps(rec["axes"]), json.dumps(rec["rows"]),
                    json.dumps(rec.get("windows")),
                ),
            )
            # rowid tiebreak: same-second inserts still prune by insertion order.
            conn.execute(
                "DELETE FROM sweeps WHERE id NOT IN "
                "(SELECT id FROM sweeps ORDER BY created_at DESC, rowid DESC LIMIT ?)",
                (self._cap,),
            )
            conn.commit()
        finally:
            conn.close()

    async def list(self, limit: int = 50, epic: str | None = None) -> list[dict]:
        return await asyncio.to_thread(self._list_sync, limit, epic)

    def _list_sync(self, limit: int, epic: str | None) -> list[dict]:
        conn = self._connect()
        try:
            sql = (
                "SELECT id, created_at, epic, timeframe, name, rows_json FROM sweeps"
            )
            params: list = []
            if epic is not None:
                sql += " WHERE epic = ?"
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

    async def get(self, sweep_id: str) -> dict | None:
        return await asyncio.to_thread(self._get_sync, sweep_id)

    def _get_sync(self, sweep_id: str) -> dict | None:
        conn = self._connect()
        try:
            r = conn.execute(
                "SELECT id, created_at, epic, timeframe, name, axes_json, "
                "rows_json, windows_json FROM sweeps WHERE id = ?",
                (sweep_id,),
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

    async def delete(self, sweep_id: str) -> None:
        await asyncio.to_thread(self._delete_sync, sweep_id)

    def _delete_sync(self, sweep_id: str) -> None:
        conn = self._connect()
        try:
            conn.execute("DELETE FROM sweeps WHERE id = ?", (sweep_id,))
            conn.commit()
        finally:
            conn.close()


# Module singleton, configured from settings (same pattern as RUN_STORE).
from auto_trader.config import settings  # noqa: E402  (after class def, avoids cycle)

SWEEP_STORE = SweepStore(settings.sweeps_db_path)
