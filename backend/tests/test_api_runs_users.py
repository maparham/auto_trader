"""Hosted-mode isolation for /api/backtest/runs and the progress registry."""
from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient

from auto_trader.api.app import app
from auto_trader.core import progress as pr
from tests import clerk_fake

client = TestClient(app)


@pytest.fixture
def clerk(monkeypatch):
    clerk_fake.install(monkeypatch)


def _auth(sub: str) -> dict:
    return {"Authorization": f"Bearer {clerk_fake.make_token(sub=sub)}"}


def test_runs_listing_is_per_user(clerk):
    import auto_trader.api.routers.backtest as bt

    rec = {
        "id": "r-alice", "created_at": 1, "epic": "US100", "timeframe": "HOUR",
        "range_from": 0, "range_to": 1, "strategy_kind": "coded",
        "strategy_name": None, "request": {}, "summary": {}, "trades": [],
    }
    asyncio.run(bt.RUN_STORE.insert("alice", rec))
    ids = [r["id"] for r in client.get("/api/backtest/runs", headers=_auth("alice")).json()]
    assert "r-alice" in ids
    assert client.get("/api/backtest/runs", headers=_auth("bob")).json() == []
    assert client.get("/api/backtest/runs/r-alice", headers=_auth("bob")).status_code == 404
    assert client.get("/api/backtest/runs/r-alice", headers=_auth("alice")).status_code == 200


def test_progress_and_cancel_are_owner_scoped(clerk):
    pr.set_progress("p1", stage="simulate", owner="alice")
    assert client.get("/api/backtest/progress/p1", headers=_auth("alice")).status_code == 200
    assert client.get("/api/backtest/progress/p1", headers=_auth("bob")).status_code == 404

    # Bob's cancel must not find alice's entry: an owner mismatch behaves
    # exactly like a missing entry, so the route 404s (mirrors GET above).
    r = client.post("/api/backtest/cancel/p1", headers=_auth("bob"))
    assert r.status_code == 404

    # Bob's attempt must not have flagged alice's entry as cancelled: a real
    # cancel by alice must still succeed afterward.
    r2 = client.post("/api/backtest/cancel/p1", headers=_auth("alice"))
    assert r2.status_code == 200
    assert r2.json() == {"ok": True}
    pr.clear_progress("p1", owner="alice")


def test_set_progress_refuses_to_take_over_another_owners_pid():
    """A client-chosen progress_id colliding with another tenant's live entry
    must not hijack it: alice's entry stays put, bob's registration is a
    silent no-op (same UX as an unregistered pid)."""
    pr.set_progress("collide", stage="simulate", done=1, total=10, owner="alice")
    pr.set_progress("collide", stage="exit-times", done=9, total=9, owner="bob")

    entry = pr.get_progress("collide", owner="alice")
    assert entry == {"stage": "simulate", "done": 1, "total": 10}
    # Bob never took ownership, so he can't read it back either.
    assert pr.get_progress("collide", owner="bob") is None
    pr.clear_progress("collide", owner="alice")


def test_update_and_is_cancelled_are_owner_scoped():
    """The engine-loop hot-path calls (update_progress / is_cancelled) must be
    owner-guarded too: bob's run on a colliding pid (whose set_progress was
    silently refused) must neither write into alice's entry nor observe
    alice's cancel flag."""
    pr.set_progress("hot", stage="simulate", done=1, total=10, owner="alice")

    pr.update_progress("hot", 9, 9, owner="bob")  # silent no-op
    assert pr.get_progress("hot", owner="alice") == {
        "stage": "simulate", "done": 1, "total": 10}

    assert pr.request_cancel("hot", owner="alice") is True
    assert pr.is_cancelled("hot", owner="alice") is True
    # Alice's cancel must not abort bob's unrelated run.
    assert pr.is_cancelled("hot", owner="bob") is False
    pr.clear_progress("hot", owner="alice")


def test_clear_progress_is_owner_scoped():
    """clear_progress must only delete an entry when the caller owns it —
    otherwise one tenant could wipe out another tenant's live run entry."""
    pr.set_progress("clearme", stage="simulate", owner="alice")

    pr.clear_progress("clearme", owner="bob")
    assert pr.get_progress("clearme", owner="alice") is not None

    pr.clear_progress("clearme", owner="alice")
    assert pr.get_progress("clearme", owner="alice") is None
