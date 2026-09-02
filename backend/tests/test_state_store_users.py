"""StateStore: per-user documents + migration of a pre-partitioning DB."""
from __future__ import annotations

import asyncio
import sqlite3

from auto_trader.core.state_store import StateStore


def test_users_have_disjoint_documents(tmp_path):
    store = StateStore(str(tmp_path / "s.db"))
    asyncio.run(store.set("alice", "k", '"a"'))
    asyncio.run(store.set("bob", "k", '"b"'))
    assert asyncio.run(store.get_all("alice")) == {"k": '"a"'}
    assert asyncio.run(store.get_all("bob")) == {"k": '"b"'}
    asyncio.run(store.delete("alice", "k"))
    assert asyncio.run(store.get_all("alice")) == {}
    assert asyncio.run(store.get_all("bob")) == {"k": '"b"'}


def test_migrates_old_single_user_db_to_dev(tmp_path):
    path = str(tmp_path / "old.db")
    conn = sqlite3.connect(path)
    conn.execute(
        "CREATE TABLE app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, "
        "updated_at INTEGER)"
    )
    conn.execute("INSERT INTO app_state VALUES ('k1', '1', 0), ('k2', '2', 0)")
    conn.commit()
    conn.close()

    store = StateStore(path)  # init runs the migration
    assert asyncio.run(store.get_all("dev")) == {"k1": "1", "k2": "2"}
    assert asyncio.run(store.get_all("alice")) == {}
    # Re-init is a no-op (idempotent).
    StateStore(path)
    assert asyncio.run(store.get_all("dev")) == {"k1": "1", "k2": "2"}
