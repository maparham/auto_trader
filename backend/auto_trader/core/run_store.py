"""Backtest run persistence for the strategy-analysis loop: every normal run
(config + trades incl. MAE/MFE/context + summary metrics) lands here so runs
can be compared across iterations and read by tooling (Claude sessions curl
the read API). Sweep child runs are NOT stored. Capped at the newest `cap`
rows, pruned on insert. Equity curves / fills / bar traces are deliberately
not stored (bulky; re-runnable on demand).

Same storage pattern as state_store.py: stdlib sqlite3, WAL, schema ensured on
every connection, fresh connection per op via asyncio.to_thread.
"""

from __future__ import annotations

import asyncio
import json
import sqlite3


class RunStore:
    def __init__(self, db_path: str, cap: int = 200) -> None:
        self._db_path = db_path
        self._cap = cap
        self._connect().close()  # create the db file + schema up front

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._db_path, timeout=5.0)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute(
            "CREATE TABLE IF NOT EXISTS runs ("
            "id TEXT PRIMARY KEY, created_at INTEGER, epic TEXT, timeframe TEXT, "
            "range_from INTEGER, range_to INTEGER, strategy_kind TEXT, "
            "strategy_name TEXT, request_json TEXT, summary_json TEXT, "
            "trades_json TEXT)"
        )
        conn.commit()
        return conn

    async def insert(self, rec: dict) -> None:
        await asyncio.to_thread(self._insert_sync, rec)

    def _insert_sync(self, rec: dict) -> None:
        conn = self._connect()
        try:
            conn.execute(
                "INSERT OR REPLACE INTO runs (id, created_at, epic, timeframe, "
                "range_from, range_to, strategy_kind, strategy_name, "
                "request_json, summary_json, trades_json) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    rec["id"], rec["created_at"], rec["epic"], rec["timeframe"],
                    rec["range_from"], rec["range_to"], rec["strategy_kind"],
                    rec.get("strategy_name"),
                    json.dumps(rec["request"]), json.dumps(rec["summary"]),
                    json.dumps(rec["trades"]),
                ),
            )
            conn.execute(
                "DELETE FROM runs WHERE id NOT IN "
                "(SELECT id FROM runs ORDER BY created_at DESC, id DESC LIMIT ?)",
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
                "SELECT id, created_at, epic, timeframe, range_from, range_to, "
                "strategy_kind, strategy_name, summary_json FROM runs"
            )
            params: list = []
            if epic is not None:
                sql += " WHERE epic = ?"
                params.append(epic)
            sql += " ORDER BY created_at DESC, id DESC LIMIT ?"
            params.append(limit)
            rows = conn.execute(sql, params).fetchall()
            return [
                {
                    "id": r[0], "created_at": r[1], "epic": r[2], "timeframe": r[3],
                    "range_from": r[4], "range_to": r[5], "strategy_kind": r[6],
                    "strategy_name": r[7], "summary": json.loads(r[8]),
                }
                for r in rows
            ]
        finally:
            conn.close()

    async def get(self, run_id: str) -> dict | None:
        return await asyncio.to_thread(self._get_sync, run_id)

    def _get_sync(self, run_id: str) -> dict | None:
        conn = self._connect()
        try:
            r = conn.execute(
                "SELECT id, created_at, epic, timeframe, range_from, range_to, "
                "strategy_kind, strategy_name, request_json, summary_json, "
                "trades_json FROM runs WHERE id = ?",
                (run_id,),
            ).fetchone()
            if r is None:
                return None
            return {
                "id": r[0], "created_at": r[1], "epic": r[2], "timeframe": r[3],
                "range_from": r[4], "range_to": r[5], "strategy_kind": r[6],
                "strategy_name": r[7], "request": json.loads(r[8]),
                "summary": json.loads(r[9]), "trades": json.loads(r[10]),
            }
        finally:
            conn.close()

    async def delete(self, run_id: str) -> None:
        await asyncio.to_thread(self._delete_sync, run_id)

    def _delete_sync(self, run_id: str) -> None:
        conn = self._connect()
        try:
            conn.execute("DELETE FROM runs WHERE id = ?", (run_id,))
            conn.commit()
        finally:
            conn.close()


# Module singleton, configured from settings (same pattern as STATE_STORE).
from auto_trader.config import settings  # noqa: E402  (after class def, avoids cycle)

RUN_STORE = RunStore(settings.runs_db_path)
