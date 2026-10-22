"""Saved screener screens, per user.

Same storage idiom as pattern_preset_store: stdlib sqlite3, a fresh
connection per operation, work via asyncio.to_thread, JSON columns parsed at
the read boundary so callers never see a JSON string."""

from __future__ import annotations

import asyncio
import json
import sqlite3
import time
import uuid

from auto_trader.config import settings

_SCHEMA = """
CREATE TABLE IF NOT EXISTS screens (
  user_id TEXT NOT NULL, id TEXT NOT NULL,
  name TEXT NOT NULL, broker TEXT NOT NULL, resolution TEXT NOT NULL,
  symbols TEXT NOT NULL, expression TEXT NOT NULL, columns TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id));
"""
_COLS = "id,name,broker,resolution,symbols,expression,columns,created_at,updated_at"


class ScreenStore:
    def __init__(self, db_path: str) -> None:
        self._db_path = db_path

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._db_path)
        conn.executescript(_SCHEMA)
        return conn

    @staticmethod
    def _row(r: tuple) -> dict:
        return {"id": r[0], "name": r[1], "broker": r[2], "resolution": r[3],
                "symbols": json.loads(r[4]), "expression": r[5],
                "columns": json.loads(r[6]), "created_at": r[7], "updated_at": r[8]}

    def _get_sync(self, conn, user_id: str, screen_id: str) -> dict | None:
        r = conn.execute(f"SELECT {_COLS} FROM screens WHERE user_id=? AND id=?",
                         (user_id, screen_id)).fetchone()
        return self._row(r) if r else None

    async def list(self, user_id: str) -> list[dict]:
        def op() -> list[dict]:
            with self._connect() as conn:
                rows = conn.execute(
                    f"SELECT {_COLS} FROM screens WHERE user_id=? ORDER BY created_at, id",
                    (user_id,)).fetchall()
            return [self._row(r) for r in rows]
        return await asyncio.to_thread(op)

    async def get(self, user_id: str, screen_id: str) -> dict | None:
        def op() -> dict | None:
            with self._connect() as conn:
                return self._get_sync(conn, user_id, screen_id)
        return await asyncio.to_thread(op)

    async def create(self, user_id: str, data: dict) -> dict:
        def op() -> dict:
            sid = uuid.uuid4().hex[:12]
            now = int(time.time())
            with self._connect() as conn:
                conn.execute(
                    "INSERT INTO screens VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (user_id, sid, data["name"], data["broker"], data["resolution"],
                     json.dumps(data["symbols"]), data["expression"],
                     json.dumps(data["columns"]), now, now))
                return self._get_sync(conn, user_id, sid)
        return await asyncio.to_thread(op)

    async def update(self, user_id: str, screen_id: str, data: dict) -> dict | None:
        def op() -> dict | None:
            with self._connect() as conn:
                cur = conn.execute(
                    "UPDATE screens SET name=?, broker=?, resolution=?, symbols=?, "
                    "expression=?, columns=?, updated_at=? WHERE user_id=? AND id=?",
                    (data["name"], data["broker"], data["resolution"],
                     json.dumps(data["symbols"]), data["expression"],
                     json.dumps(data["columns"]), int(time.time()), user_id, screen_id))
                if cur.rowcount == 0:
                    return None
                return self._get_sync(conn, user_id, screen_id)
        return await asyncio.to_thread(op)

    async def delete(self, user_id: str, screen_id: str) -> bool:
        def op() -> bool:
            with self._connect() as conn:
                cur = conn.execute("DELETE FROM screens WHERE user_id=? AND id=?",
                                   (user_id, screen_id))
            return cur.rowcount > 0
        return await asyncio.to_thread(op)


SCREEN_STORE = ScreenStore(settings.screens_db_path)
