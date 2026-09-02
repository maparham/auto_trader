"""Sweep/WFO stores: per-user rows + caps + old-DB migration to 'dev'."""
from __future__ import annotations

import asyncio
import sqlite3
import uuid

import pytest
from fastapi.testclient import TestClient

from auto_trader.core.sweep_store import SweepStore
from auto_trader.core.wfo_store import WfoStore

from tests import clerk_fake


def _sweep(sid: str, ts: int) -> dict:
    return {"id": sid, "created_at": ts, "epic": "US100", "timeframe": "1h",
            "name": None, "axes": [], "rows": [], "windows": None}


def _wfo(wid: str, ts: int) -> dict:
    return {"id": wid, "created_at": ts, "epic": "US100", "timeframe": "1h",
            "name": None, "request": {}, "result": {}, "fold_tables": {}}


def test_sweeps_per_user_and_cap(tmp_path):
    store = SweepStore(str(tmp_path / "s.db"), cap=2)
    asyncio.run(store.insert("alice", _sweep("s1", 1)))
    asyncio.run(store.insert("bob", _sweep("s2", 2)))
    asyncio.run(store.insert("alice", _sweep("s3", 3)))
    asyncio.run(store.insert("alice", _sweep("s4", 4)))  # evicts s1 only
    assert [s["id"] for s in asyncio.run(store.list("alice"))] == ["s4", "s3"]
    assert [s["id"] for s in asyncio.run(store.list("bob"))] == ["s2"]
    assert asyncio.run(store.get("bob", "s3")) is None


def test_wfo_per_user_and_cross_user_reads(tmp_path):
    store = WfoStore(str(tmp_path / "w.db"), cap=2)
    store.insert_sync("alice", _wfo("w1", 1))
    store.insert_sync("bob", _wfo("w2", 2))
    assert [w["id"] for w in asyncio.run(store.list("alice"))] == ["w1"]
    assert asyncio.run(store.get("bob", "w1")) is None
    assert asyncio.run(store.get_fold_tables("bob", "w1")) is None


def test_sweep_migration_to_dev(tmp_path):
    path = str(tmp_path / "old.db")
    conn = sqlite3.connect(path)
    conn.execute(
        "CREATE TABLE sweeps (id TEXT PRIMARY KEY, created_at INTEGER, epic TEXT, "
        "timeframe TEXT, name TEXT, axes_json TEXT, rows_json TEXT, windows_json TEXT)"
    )
    conn.execute(
        "INSERT INTO sweeps VALUES ('s1', 1, 'US100', '1h', NULL, '[]', '[]', 'null')"
    )
    conn.commit()
    conn.close()
    store = SweepStore(path)
    assert [s["id"] for s in asyncio.run(store.list("dev"))] == ["s1"]
    assert asyncio.run(store.list("alice")) == []


def test_sweep_insert_rejects_id_owned_by_another_user(tmp_path):
    store = SweepStore(str(tmp_path / "s.db"))
    asyncio.run(store.insert("alice", _sweep("s1", 1)))
    with pytest.raises(ValueError, match="owned by another user"):
        asyncio.run(store.insert("bob", _sweep("s1", 2)))
    # Alice's row must be unchanged after the rejected attempt.
    row = asyncio.run(store.get("alice", "s1"))
    assert row is not None and row["created_at"] == 1


def test_wfo_insert_rejects_id_owned_by_another_user(tmp_path):
    store = WfoStore(str(tmp_path / "w.db"))
    store.insert_sync("alice", _wfo("w1", 1))
    with pytest.raises(ValueError, match="owned by another user"):
        store.insert_sync("bob", _wfo("w1", 2))
    row = asyncio.run(store.get("alice", "w1"))
    assert row is not None and row["created_at"] == 1


def test_wfo_migration_to_dev(tmp_path):
    path = str(tmp_path / "old_wfo.db")
    conn = sqlite3.connect(path)
    conn.execute(
        "CREATE TABLE wfo (id TEXT PRIMARY KEY, created_at INTEGER, epic TEXT, "
        "timeframe TEXT, name TEXT, request_json TEXT, result_json TEXT, "
        "fold_tables_json TEXT)"
    )
    conn.execute(
        "INSERT INTO wfo VALUES ('w1', 1, 'US100', '1h', NULL, '{}', "
        "'{\"schemes\": []}', '{\"s0/f0\": []}')"
    )
    conn.commit()
    conn.close()
    store = WfoStore(path)
    assert [w["id"] for w in asyncio.run(store.list("dev"))] == ["w1"]
    assert asyncio.run(store.list("alice")) == []
    tables = asyncio.run(store.get_fold_tables("dev", "w1"))
    assert tables == {"s0/f0": []}


def _sweep_body(name="s1"):
    return {
        "epic": "EURUSD", "timeframe": "MINUTE_15", "name": name,
        "axes": [], "rows": [], "windows": None,
    }


def test_sweep_archive_route_409s_on_id_owned_by_another_user(tmp_path, monkeypatch):
    """A client-posted archive id can never collide across users in practice
    (save_sweep mints its own uuid), but the ownership guard defends the insert
    path itself: force both users onto the SAME generated id and confirm the
    route maps SweepStore's ValueError to 409, leaving the owner's row intact."""
    import auto_trader.api.routers.backtest as bt
    from auto_trader.api.app import app

    clerk_fake.install(monkeypatch)
    monkeypatch.setattr(bt, "SWEEP_STORE", SweepStore(str(tmp_path / "s.db")))
    fixed = uuid.UUID("11111111-1111-1111-1111-111111111111")
    monkeypatch.setattr(bt.uuid, "uuid4", lambda: fixed)

    client = TestClient(app)
    alice_tok = clerk_fake.make_token(sub="alice")
    bob_tok = clerk_fake.make_token(sub="bob")

    r1 = client.post("/api/backtest/sweeps", json=_sweep_body("alice-sweep"),
                      headers={"Authorization": f"Bearer {alice_tok}"})
    assert r1.status_code == 200
    sweep_id = r1.json()["id"]

    r2 = client.post("/api/backtest/sweeps", json=_sweep_body("bob-sweep"),
                      headers={"Authorization": f"Bearer {bob_tok}"})
    assert r2.status_code == 409

    # Alice's row must be unchanged after bob's rejected attempt.
    full = client.get(f"/api/backtest/sweeps/{sweep_id}",
                       headers={"Authorization": f"Bearer {alice_tok}"})
    assert full.status_code == 200
    assert full.json()["name"] == "alice-sweep"
