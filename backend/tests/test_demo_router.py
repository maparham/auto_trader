"""Demo router: public snapshot + admin publish/versions.

Runs in dev mode (auth disabled), so every request lands as admin — see
tests/test_api_wfo.py and friends for the same module-level TestClient
pattern. The autouse `_registry_for_routes` fixture in conftest.py already
wires a real, credential-free dukascopy broker, so no broker stub is needed:
US100/EURUSD resolve on it and NOPE does not (see
auto_trader/brokers/dukascopy.py's _INSTRUMENTS table).
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import auto_trader.core.demo_store as demo_store_mod
from auto_trader.api.app import app
from auto_trader.core.demo_store import DemoStore

client = TestClient(app)


@pytest.fixture(autouse=True)
def _isolated_demo_store(tmp_path, monkeypatch):
    """DEMO_DB persists via a module singleton; point it at a per-test temp
    file and reset the cached singleton so tests never share state."""
    monkeypatch.setattr(
        demo_store_mod, "_DEMO_STORE", DemoStore(str(tmp_path / "demo.db"))
    )


def test_snapshot_404_before_publish():
    r = client.get("/api/demo/snapshot")
    assert r.status_code == 404
    assert r.json()["detail"] == "no demo published"


def test_publish_then_fetch_roundtrip():
    body = {
        "layout": {"tabs": []},
        "watchlist": ["US100", "EURUSD"],
        "backtests": [{"name": "NQ breakout", "result": {"trades": []}}],
    }
    r = client.post("/api/admin/demo/publish", json=body)
    assert r.status_code == 200 and r.json()["version"] == 1
    snap = client.get("/api/demo/snapshot").json()
    assert snap["version"] == 1
    assert snap["payload"]["watchlist"] == ["US100", "EURUSD"]


def test_publish_accepts_empty_watchlist():
    # Nothing in the demo UI reads the watchlist any more, so it is optional.
    r = client.post(
        "/api/admin/demo/publish",
        json={"layout": {"tabs": []}, "watchlist": [], "backtests": []},
    )
    assert r.status_code == 200
    assert client.get("/api/demo/snapshot").json()["payload"]["watchlist"] == []


def test_publish_rejects_empty_layout():
    # Publishing nothing would strand visitors on the fallback chart silently.
    r = client.post(
        "/api/admin/demo/publish",
        json={"layout": {}, "watchlist": ["US100"], "backtests": []},
    )
    assert r.status_code == 422
    assert "layout is empty" in r.json()["detail"]


def test_publish_rejects_unknown_epic():
    r = client.post(
        "/api/admin/demo/publish",
        json={"layout": {"tabs": []}, "watchlist": ["NOPE"], "backtests": []},
    )
    assert r.status_code == 422
    assert "NOPE" in r.json()["detail"]


def test_latest_publish_wins():
    # There is one live demo: publishing again replaces what visitors see.
    # (The older rows survive in the store, but nothing reads them any more.)
    for i in (1, 2):
        client.post(
            "/api/admin/demo/publish",
            json={"layout": {"v": i}, "watchlist": ["US100"], "backtests": []},
        )
    assert client.get("/api/demo/snapshot").json()["payload"]["layout"] == {"v": 2}


def test_rollback_endpoint_is_gone():
    assert client.post("/api/admin/demo/rollback", json={"version": 1}).status_code == 404


def test_versions_listing():
    client.post(
        "/api/admin/demo/publish",
        json={"layout": {"tabs": []}, "watchlist": ["US100"], "backtests": []},
    )
    vs = client.get("/api/admin/demo/versions").json()["versions"]
    assert vs[0]["version"] == 1
