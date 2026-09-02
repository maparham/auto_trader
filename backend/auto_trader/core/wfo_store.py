"""Walk-forward optimization result persistence: every completed WFO job
(its result metrics, fold tables) lands here so past jobs can be listed and
reopened in the UI. Capped at the newest `cap` rows PER USER, pruned on
insert.

Same storage pattern as sweep_store.py: stdlib sqlite3, WAL, schema ensured on
every connection, fresh connection per op via asyncio.to_thread.

Rows are partitioned by user_id (hosted multi-user deployment); a pre-existing
DB migrates its rows to the literal 'dev' user (see _migrate_v1).
"""

from __future__ import annotations

import asyncio
import json
import sqlite3

from auto_trader.core.db_migrate import run_migrations, table_columns


_TABLE_ROW_BUDGET = 50_000
_TABLE_TOP_N = 200


def _migrate_v1(conn: sqlite3.Connection) -> None:
    if "user_id" in table_columns(conn, "wfo"):
        return
    conn.execute("ALTER TABLE wfo ADD COLUMN user_id TEXT NOT NULL DEFAULT 'dev'")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_wfo_user_created ON wfo (user_id, created_at)")


def _budget_tables(rec: dict) -> None:
    """Prune fold tables if total rows exceed budget.

    Keeps top-200 per fold by objective (highest first), sets truncated_tables flag.
    """
    tables = rec.get("fold_tables") or {}
    total = sum(len(v) for v in tables.values())
    if total <= _TABLE_ROW_BUDGET:
        return
    for key, rows in tables.items():
        rows.sort(key=lambda r: (r.get("objective") is not None,
                                 r.get("objective") or 0.0), reverse=True)
        tables[key] = rows[:_TABLE_TOP_N]
    rec.setdefault("result", {})["truncated_tables"] = True


class WfoStore:
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
            "CREATE TABLE IF NOT EXISTS wfo ("
            "id TEXT PRIMARY KEY, user_id TEXT NOT NULL DEFAULT 'dev', "
            "created_at INTEGER, epic TEXT, timeframe TEXT, "
            "name TEXT, request_json TEXT, result_json TEXT, fold_tables_json TEXT)"
        )
        # A pre-existing (pre-migration) `wfo` table has no user_id column yet
        # — the index is created here for a fresh table, and by _migrate_v1
        # (idempotently) once the column lands on an old one.
        if "user_id" in table_columns(conn, "wfo"):
            conn.execute("CREATE INDEX IF NOT EXISTS idx_wfo_user_created ON wfo (user_id, created_at)")
        conn.commit()
        return conn

    async def insert(self, user_id: str, rec: dict) -> None:
        await asyncio.to_thread(self.insert_sync, user_id, rec)

    def insert_sync(self, user_id: str, rec: dict) -> None:
        """Public sync insert, called from job thread's on_complete."""
        # Budget fold tables before serializing
        _budget_tables(rec)

        conn = self._connect()
        try:
            existing = conn.execute(
                "SELECT user_id FROM wfo WHERE id = ?", (rec["id"],),
            ).fetchone()
            if existing is not None and existing[0] != user_id:
                raise ValueError("id owned by another user")
            conn.execute(
                "INSERT OR REPLACE INTO wfo (id, user_id, created_at, epic, timeframe, "
                "name, request_json, result_json, fold_tables_json) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    rec["id"], user_id, rec["created_at"], rec["epic"], rec["timeframe"],
                    rec.get("name"),
                    json.dumps(rec["request"]), json.dumps(rec["result"]),
                    json.dumps(rec.get("fold_tables")),
                ),
            )
            # rowid tiebreak: same-second inserts still prune by insertion order.
            conn.execute(
                "DELETE FROM wfo WHERE user_id = ? AND id NOT IN "
                "(SELECT id FROM wfo WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)",
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
                "SELECT id, created_at, epic, timeframe, name, result_json FROM wfo "
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
                    result = json.loads(r[5])
                    schemes = result.get("schemes") or []

                    # Find the scheme with the highest robustness_score
                    best_scheme = None
                    best_score = None
                    for s in schemes:
                        score = (s.get("robustness") or {}).get("robustness_score")
                        if score is not None and (best_score is None or score > best_score):
                            best_score = score
                            best_scheme = s

                    wfe_median = None
                    if best_scheme is not None:
                        wfe_median = (best_scheme.get("robustness") or {}).get("wfe_median")

                    out.append({
                        "id": r[0], "created_at": r[1], "epic": r[2],
                        "timeframe": r[3], "name": r[4], "n_schemes": len(schemes),
                        "robustness_score": best_score, "wfe_median": wfe_median,
                    })
                except (ValueError, KeyError, TypeError):
                    continue
            return out
        finally:
            conn.close()

    async def get(self, user_id: str, wfo_id: str) -> dict | None:
        return await asyncio.to_thread(self._get_sync, user_id, wfo_id)

    def _get_sync(self, user_id: str, wfo_id: str) -> dict | None:
        conn = self._connect()
        try:
            r = conn.execute(
                "SELECT id, created_at, epic, timeframe, name, request_json, "
                "result_json FROM wfo WHERE user_id = ? AND id = ?",
                (user_id, wfo_id),
            ).fetchone()
            if r is None:
                return None
            return {
                "id": r[0], "created_at": r[1], "epic": r[2], "timeframe": r[3],
                "name": r[4], "request": json.loads(r[5]),
                "result": json.loads(r[6]),
            }
        finally:
            conn.close()

    async def get_fold_tables(self, user_id: str, wfo_id: str) -> dict | None:
        return await asyncio.to_thread(self._get_fold_tables_sync, user_id, wfo_id)

    def _get_fold_tables_sync(self, user_id: str, wfo_id: str) -> dict | None:
        conn = self._connect()
        try:
            r = conn.execute(
                "SELECT fold_tables_json FROM wfo WHERE user_id = ? AND id = ?",
                (user_id, wfo_id),
            ).fetchone()
            if r is None:
                return None
            return json.loads(r[0])
        finally:
            conn.close()

    async def delete(self, user_id: str, wfo_id: str) -> None:
        await asyncio.to_thread(self._delete_sync, user_id, wfo_id)

    def _delete_sync(self, user_id: str, wfo_id: str) -> None:
        conn = self._connect()
        try:
            conn.execute("DELETE FROM wfo WHERE user_id = ? AND id = ?", (user_id, wfo_id))
            conn.commit()
        finally:
            conn.close()


# Module singleton, configured from settings (same pattern as SWEEP_STORE).
from auto_trader.config import settings  # noqa: E402  (after class def, avoids cycle)

WFO_STORE = WfoStore(settings.wfo_db_path)
