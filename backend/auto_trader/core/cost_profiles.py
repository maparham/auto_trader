"""Per-instrument cost profiles: spread, slippage, financing costs. Stores
historical cost parameters keyed by (user, epic) so strategies can reference
realistic numbers and what-if with alternate cost structures. Per-user since
the SaaS partitioning — each user gets their own profile per epic, isolated
from every other user's.

Same storage pattern as sweep_store.py: stdlib sqlite3, WAL, schema ensured on
every connection, fresh connection per op via asyncio.to_thread.
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
import time

from auto_trader.core.db_migrate import run_migrations, table_columns

_SCHEMA = (
    "CREATE TABLE IF NOT EXISTS cost_profiles ("
    "user_id TEXT NOT NULL, "
    "epic TEXT NOT NULL, "
    "spread REAL NOT NULL DEFAULT 0, "
    "slippage_json TEXT NOT NULL DEFAULT '{\"kind\":\"fixed\",\"value\":0.0,\"atrMult\":0.0}', "
    "fin_long_daily_pct REAL NOT NULL DEFAULT 0, "
    "fin_short_daily_pct REAL NOT NULL DEFAULT 0, "
    "source TEXT NOT NULL DEFAULT 'manual', "
    "updated_at INTEGER NOT NULL, "
    "PRIMARY KEY (user_id, epic))"
)


def _migrate_v1(conn: sqlite3.Connection) -> None:
    """PK change (epic) -> (user_id, epic): sqlite needs a table rebuild.
    A fresh DB already has the new shape — just stamp it."""
    if "user_id" in table_columns(conn, "cost_profiles"):
        return
    conn.execute(
        "CREATE TABLE cost_profiles_new ("
        "user_id TEXT NOT NULL, "
        "epic TEXT NOT NULL, "
        "spread REAL NOT NULL DEFAULT 0, "
        "slippage_json TEXT NOT NULL DEFAULT '{\"kind\":\"fixed\",\"value\":0.0,\"atrMult\":0.0}', "
        "fin_long_daily_pct REAL NOT NULL DEFAULT 0, "
        "fin_short_daily_pct REAL NOT NULL DEFAULT 0, "
        "source TEXT NOT NULL DEFAULT 'manual', "
        "updated_at INTEGER NOT NULL, "
        "PRIMARY KEY (user_id, epic))"
    )
    conn.execute(
        "INSERT INTO cost_profiles_new "
        "SELECT 'dev', epic, spread, slippage_json, fin_long_daily_pct, "
        "fin_short_daily_pct, source, updated_at FROM cost_profiles"
    )
    conn.execute("DROP TABLE cost_profiles")
    conn.execute("ALTER TABLE cost_profiles_new RENAME TO cost_profiles")


class CostProfileStore:
    def __init__(self, db_path: str) -> None:
        self._db_path = db_path
        conn = self._connect()
        try:
            run_migrations(conn, {1: _migrate_v1})
        finally:
            conn.close()

    @property
    def db_path(self) -> str:
        return self._db_path

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._db_path, timeout=5.0)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute(_SCHEMA)
        conn.commit()
        return conn

    async def get(self, user_id: str, epic: str) -> dict | None:
        return await asyncio.to_thread(self._get_sync, user_id, epic)

    def _get_sync(self, user_id: str, epic: str) -> dict | None:
        conn = self._connect()
        try:
            r = conn.execute(
                "SELECT epic, spread, slippage_json, fin_long_daily_pct, "
                "fin_short_daily_pct, source, updated_at FROM cost_profiles "
                "WHERE user_id = ? AND epic = ?",
                (user_id, epic),
            ).fetchone()
            if r is None:
                return None

            # Parse slippage_json with corruption handling
            default_slippage = {"kind": "fixed", "value": 0.0, "atrMult": 0.0}
            try:
                slippage = json.loads(r[2])
            except (ValueError, TypeError):
                slippage = default_slippage

            return {
                "epic": r[0],
                "spread": r[1],
                "slippage": slippage,
                "finLongDailyPct": r[3],
                "finShortDailyPct": r[4],
                "source": r[5],
                "updatedAt": r[6],
            }
        finally:
            conn.close()

    async def upsert(self, user_id: str, epic: str, profile: dict) -> None:
        await asyncio.to_thread(self._upsert_sync, user_id, epic, profile)

    def _upsert_sync(self, user_id: str, epic: str, profile: dict) -> None:
        conn = self._connect()
        try:
            # Extract values with defaults
            spread = profile.get("spread", 0)
            slippage = profile.get("slippage", {"kind": "fixed", "value": 0.0, "atrMult": 0.0})
            fin_long_daily_pct = profile.get("finLongDailyPct", 0)
            fin_short_daily_pct = profile.get("finShortDailyPct", 0)
            source = profile.get("source", "manual")
            updated_at = int(time.time())

            conn.execute(
                "INSERT INTO cost_profiles "
                "(user_id, epic, spread, slippage_json, fin_long_daily_pct, fin_short_daily_pct, "
                "source, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(user_id, epic) DO UPDATE SET "
                "spread=excluded.spread, "
                "slippage_json=excluded.slippage_json, "
                "fin_long_daily_pct=excluded.fin_long_daily_pct, "
                "fin_short_daily_pct=excluded.fin_short_daily_pct, "
                "source=excluded.source, "
                "updated_at=excluded.updated_at",
                (
                    user_id,
                    epic,
                    spread,
                    json.dumps(slippage),
                    fin_long_daily_pct,
                    fin_short_daily_pct,
                    source,
                    updated_at,
                ),
            )
            conn.commit()
        finally:
            conn.close()


# Module singleton, configured from settings (same pattern as SWEEP_STORE).
from auto_trader.config import settings  # noqa: E402  (after class def, avoids cycle)

COST_PROFILES = CostProfileStore(settings.cost_profiles_db_path)
