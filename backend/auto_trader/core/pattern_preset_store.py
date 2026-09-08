"""User pattern presets: chart selections saved as named query patterns, so
the preset scan can search for them server-side with no browser open.

Same storage idiom as alert_store: stdlib sqlite3, a fresh connection per
operation, writes via asyncio.to_thread, JSON columns parsed at the read
boundary so callers never see a JSON string."""

from __future__ import annotations

import asyncio
import json
import sqlite3
import time
import uuid

from auto_trader.config import settings

_SCHEMA = """
CREATE TABLE IF NOT EXISTS presets (
  user_id TEXT NOT NULL, id TEXT NOT NULL,
  name TEXT NOT NULL,
  epic TEXT NOT NULL, resolution TEXT NOT NULL,
  bars TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id));
"""


class PatternPresetStore:
    def __init__(self, db_path: str) -> None:
        self._db_path = db_path

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._db_path)
        conn.executescript(_SCHEMA)
        return conn

    def _row(self, r: tuple) -> dict:
        return {"id": r[0], "name": r[1], "epic": r[2], "resolution": r[3],
                "bars": json.loads(r[4]), "created_at": r[5]}

    async def create(self, user_id: str, name: str, epic: str,
                     resolution: str, bars: list[dict]) -> dict:
        def op() -> dict:
            pid = uuid.uuid4().hex[:12]
            now = int(time.time())
            with self._connect() as conn:
                conn.execute(
                    "INSERT INTO presets VALUES (?,?,?,?,?,?,?)",
                    (user_id, pid, name, epic, resolution, json.dumps(bars), now),
                )
            return {"id": pid, "name": name, "epic": epic,
                    "resolution": resolution, "bars": bars, "created_at": now}
        return await asyncio.to_thread(op)

    async def list(self, user_id: str) -> list[dict]:
        def op() -> list[dict]:
            with self._connect() as conn:
                rows = conn.execute(
                    "SELECT id,name,epic,resolution,bars,created_at FROM presets"
                    " WHERE user_id=? ORDER BY created_at DESC",
                    (user_id,),
                ).fetchall()
            return [self._row(r) for r in rows]
        return await asyncio.to_thread(op)

    async def get(self, user_id: str, preset_id: str) -> dict | None:
        def op() -> dict | None:
            with self._connect() as conn:
                r = conn.execute(
                    "SELECT id,name,epic,resolution,bars,created_at FROM presets"
                    " WHERE user_id=? AND id=?",
                    (user_id, preset_id),
                ).fetchone()
            return self._row(r) if r else None
        return await asyncio.to_thread(op)

    async def rename(self, user_id: str, preset_id: str, name: str) -> bool:
        def op() -> bool:
            with self._connect() as conn:
                cur = conn.execute(
                    "UPDATE presets SET name=? WHERE user_id=? AND id=?",
                    (name, user_id, preset_id),
                )
            return cur.rowcount > 0
        return await asyncio.to_thread(op)

    async def delete(self, user_id: str, preset_id: str) -> bool:
        def op() -> bool:
            with self._connect() as conn:
                cur = conn.execute(
                    "DELETE FROM presets WHERE user_id=? AND id=?",
                    (user_id, preset_id),
                )
            return cur.rowcount > 0
        return await asyncio.to_thread(op)


PRESET_STORE = PatternPresetStore(settings.patterns_db_path)
