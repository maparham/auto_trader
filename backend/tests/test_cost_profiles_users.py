"""Cost profiles: per-user rows + composite-PK migration to 'dev'."""
from __future__ import annotations

import asyncio
import sqlite3

from auto_trader.core.cost_profiles import CostProfileStore


def test_profiles_are_per_user(tmp_path):
    store = CostProfileStore(str(tmp_path / "c.db"))
    asyncio.run(store.upsert("alice", "US100", {"spread": 1.5}))
    asyncio.run(store.upsert("bob", "US100", {"spread": 9.0}))
    assert asyncio.run(store.get("alice", "US100"))["spread"] == 1.5
    assert asyncio.run(store.get("bob", "US100"))["spread"] == 9.0
    assert asyncio.run(store.get("carol", "US100")) is None


def test_migrates_old_pk_to_composite(tmp_path):
    path = str(tmp_path / "old.db")
    conn = sqlite3.connect(path)
    conn.execute(
        "CREATE TABLE cost_profiles (epic TEXT PRIMARY KEY, "
        "spread REAL NOT NULL DEFAULT 0, "
        "slippage_json TEXT NOT NULL DEFAULT '{}', "
        "fin_long_daily_pct REAL NOT NULL DEFAULT 0, "
        "fin_short_daily_pct REAL NOT NULL DEFAULT 0, "
        "source TEXT NOT NULL DEFAULT 'manual', updated_at INTEGER NOT NULL)"
    )
    conn.execute(
        "INSERT INTO cost_profiles (epic, spread, slippage_json, updated_at) "
        "VALUES ('US100', 2.0, '{\"kind\":\"fixed\",\"value\":0.0,\"atrMult\":0.0}', 1)"
    )
    conn.commit()
    conn.close()
    store = CostProfileStore(path)
    assert asyncio.run(store.get("dev", "US100"))["spread"] == 2.0
    assert asyncio.run(store.get("alice", "US100")) is None
    CostProfileStore(path)  # idempotent re-init
    assert asyncio.run(store.get("dev", "US100"))["spread"] == 2.0
