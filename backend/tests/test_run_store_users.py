"""RunStore: per-user rows, per-user cap, migration of an old DB."""
from __future__ import annotations

import asyncio
import sqlite3

from auto_trader.core.run_store import RunStore


def _rec(rid: str, ts: int) -> dict:
    return {
        "id": rid, "created_at": ts, "epic": "US100", "timeframe": "1h",
        "range_from": 0, "range_to": 1, "strategy_kind": "coded",
        "strategy_name": None, "request": {}, "summary": {"net": 1}, "trades": [],
    }


def test_rows_and_cap_are_per_user(tmp_path):
    store = RunStore(str(tmp_path / "r.db"), cap=2)
    asyncio.run(store.insert("alice", _rec("a1", 1)))
    asyncio.run(store.insert("alice", _rec("a2", 2)))
    asyncio.run(store.insert("bob", _rec("b1", 3)))
    asyncio.run(store.insert("alice", _rec("a3", 4)))  # evicts a1, not b1
    assert [r["id"] for r in asyncio.run(store.list("alice"))] == ["a3", "a2"]
    assert [r["id"] for r in asyncio.run(store.list("bob"))] == ["b1"]
    assert asyncio.run(store.get("bob", "a2")) is None  # cross-user get -> None
    asyncio.run(store.delete("bob", "a2"))  # cross-user delete is a no-op
    assert asyncio.run(store.get("alice", "a2")) is not None


def test_migrates_old_db_rows_to_dev(tmp_path):
    path = str(tmp_path / "old.db")
    conn = sqlite3.connect(path)
    conn.execute(
        "CREATE TABLE runs (id TEXT PRIMARY KEY, created_at INTEGER, epic TEXT, "
        "timeframe TEXT, range_from INTEGER, range_to INTEGER, strategy_kind TEXT, "
        "strategy_name TEXT, request_json TEXT, summary_json TEXT, trades_json TEXT)"
    )
    conn.execute(
        "INSERT INTO runs VALUES ('r1', 1, 'US100', '1h', 0, 1, 'coded', NULL, "
        "'{}', '{}', '[]')"
    )
    conn.commit()
    conn.close()
    store = RunStore(path)
    assert [r["id"] for r in asyncio.run(store.list("dev"))] == ["r1"]
    assert asyncio.run(store.list("alice")) == []
