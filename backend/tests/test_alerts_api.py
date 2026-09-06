"""`/api/alerts` CRUD + triggered-history endpoints."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from auto_trader.api.app import app
from tests import clerk_fake

client = TestClient(app)

# Store isolation is handled by the autouse conftest.py fixture
# `_isolated_alert_store` (patches both the module singleton AND the
# router's reference — see its docstring for why both are needed).


@pytest.fixture
def clerk(monkeypatch):
    clerk_fake.install(monkeypatch)


def _auth(sub: str) -> dict:
    return {"Authorization": f"Bearer {clerk_fake.make_token(sub=sub)}"}


def _body(**overrides) -> dict:
    body = {
        "id": "al-1",
        "broker": "capital",
        "epic": "US100",
        "kind": "price_level",
        "params": {"level": 100.0, "condition": "crossing", "trigger": "once"},
    }
    body.update(overrides)
    return body


def test_create_get_round_trip_with_notify_defaults(clerk):
    r = client.post("/api/alerts", json=_body(), headers=_auth("alice"))
    assert r.status_code == 200
    row = r.json()
    assert row["id"] == "al-1"
    assert row["notify"] == {
        "toast": True, "browser": True, "sound": True, "push": True, "telegram": True,
    }
    assert row["precision"] == 2

    listing = client.get("/api/alerts", headers=_auth("alice")).json()
    assert listing == {"alerts": [row]}


def test_duplicate_id_409(clerk):
    client.post("/api/alerts", json=_body(), headers=_auth("alice"))
    r = client.post("/api/alerts", json=_body(), headers=_auth("alice"))
    assert r.status_code == 409


def test_bad_id_format_422(clerk):
    r = client.post("/api/alerts", json=_body(id="not-valid!"), headers=_auth("alice"))
    assert r.status_code == 422


def test_unknown_kind_422(clerk):
    r = client.post("/api/alerts", json=_body(kind="unknown"), headers=_auth("alice"))
    assert r.status_code == 422


def test_bad_condition_422(clerk):
    body = _body(params={"level": 100.0, "condition": "sideways", "trigger": "once"})
    r = client.post("/api/alerts", json=body, headers=_auth("alice"))
    assert r.status_code == 422


def test_bad_trigger_422(clerk):
    body = _body(params={"level": 100.0, "condition": "crossing", "trigger": "sometimes"})
    r = client.post("/api/alerts", json=body, headers=_auth("alice"))
    assert r.status_code == 422


def test_non_finite_level_422(clerk):
    import json as _json

    body = _body(params={"level": float("inf"), "condition": "crossing", "trigger": "once"})
    # httpx's json= kwarg refuses to encode a non-finite float (allow_nan=False);
    # send it as raw JSON content instead, matching what a JS client's
    # JSON.stringify would never produce but a malicious/buggy client could.
    raw = _json.dumps(body, allow_nan=True).encode()
    r = client.post(
        "/api/alerts", content=raw,
        headers={**_auth("alice"), "content-type": "application/json"},
    )
    assert r.status_code == 422


def test_string_level_rejected_422(clerk):
    # A JSON string like "100" is float()-coercible but must NOT be accepted:
    # evaluate_alert's math.isfinite(level) requires a real float — a stored
    # str would crash the engine on the next tick instead of failing loudly
    # here.
    body = _body(params={"level": "100", "condition": "crossing", "trigger": "once"})
    r = client.post("/api/alerts", json=body, headers=_auth("alice"))
    assert r.status_code == 422


@pytest.mark.parametrize("precision", [-1, 11])
def test_bad_precision_422_on_create(clerk, precision):
    r = client.post("/api/alerts", json=_body(precision=precision), headers=_auth("alice"))
    assert r.status_code == 422


@pytest.mark.parametrize("precision", [0, 10])
def test_precision_boundary_accepted_on_create(clerk, precision):
    r = client.post(
        "/api/alerts", json=_body(id=f"al-prec-{precision}", precision=precision), headers=_auth("alice")
    )
    assert r.status_code == 200
    assert r.json()["precision"] == precision


def test_non_int_precision_422_on_create(clerk):
    r = client.post("/api/alerts", json=_body(precision=2.5), headers=_auth("alice"))
    assert r.status_code == 422


def test_bad_expires_at_422_on_create(clerk):
    r = client.post("/api/alerts", json=_body(expires_at=0), headers=_auth("alice"))
    assert r.status_code == 422

    r = client.post("/api/alerts", json=_body(expires_at=-5), headers=_auth("alice"))
    assert r.status_code == 422


@pytest.mark.parametrize("precision", [-1, 11])
def test_bad_precision_422_on_patch(clerk, precision):
    client.post("/api/alerts", json=_body(), headers=_auth("alice"))
    r = client.patch("/api/alerts/al-1", json={"precision": precision}, headers=_auth("alice"))
    assert r.status_code == 422


def test_bad_expires_at_422_on_patch(clerk):
    client.post("/api/alerts", json=_body(), headers=_auth("alice"))
    r = client.patch("/api/alerts/al-1", json={"expires_at": -1}, headers=_auth("alice"))
    assert r.status_code == 422


def test_patch_level_updates_row_and_notifies_engine(clerk, monkeypatch):
    import auto_trader.core.alert_engine as alert_engine

    calls = []
    monkeypatch.setattr(
        alert_engine.ALERT_ENGINE, "on_alert_changed",
        lambda user_id, row, alert_id: calls.append((user_id, row, alert_id)),
    )

    client.post("/api/alerts", json=_body(), headers=_auth("alice"))
    calls.clear()

    r = client.patch(
        "/api/alerts/al-1",
        json={"params": {"level": 150.0, "condition": "crossing", "trigger": "once"}},
        headers=_auth("alice"),
    )
    assert r.status_code == 200
    assert r.json()["params"]["level"] == 150.0

    assert len(calls) == 1
    assert calls[0][0] == "alice"
    assert calls[0][2] == "al-1"
    assert calls[0][1]["params"]["level"] == 150.0


def test_patch_with_null_expires_at_clears_it_others_ignored(clerk):
    client.post(
        "/api/alerts", json=_body(expires_at=999999999999), headers=_auth("alice")
    )
    r = client.patch(
        "/api/alerts/al-1",
        json={"expires_at": None, "message": None, "precision": None, "notify": None},
        headers=_auth("alice"),
    )
    assert r.status_code == 200
    row = r.json()
    assert row["expires_at"] is None
    # message/precision/notify were explicit nulls -> ignored, not stored as
    # NULL (message/precision are NOT NULL columns; notify defaulting would
    # otherwise crash the engine's params.get() on the next tick).
    assert row["message"] == ""
    assert row["precision"] == 2
    assert row["notify"]["toast"] is True


def test_patch_unknown_404(clerk):
    r = client.patch("/api/alerts/al-nope", json={"message": "hi"}, headers=_auth("alice"))
    assert r.status_code == 404


def test_delete_then_404(clerk, monkeypatch):
    import auto_trader.core.alert_engine as alert_engine

    calls = []
    monkeypatch.setattr(
        alert_engine.ALERT_ENGINE, "on_alert_changed",
        lambda user_id, row, alert_id: calls.append((user_id, row, alert_id)),
    )

    client.post("/api/alerts", json=_body(), headers=_auth("alice"))
    calls.clear()

    r = client.delete("/api/alerts/al-1", headers=_auth("alice"))
    assert r.status_code == 204
    assert calls == [("alice", None, "al-1")]

    r2 = client.delete("/api/alerts/al-1", headers=_auth("alice"))
    assert r2.status_code == 404
    assert client.get("/api/alerts", headers=_auth("alice")).json() == {"alerts": []}


def test_triggered_seen_watermark_round_trip(clerk):
    r = client.get("/api/alerts/triggered", headers=_auth("alice")).json()
    assert r == {"entries": [], "seen": 0}

    r2 = client.post("/api/alerts/triggered/seen", json={"time": 12345}, headers=_auth("alice"))
    assert r2.status_code == 204

    r3 = client.get("/api/alerts/triggered", headers=_auth("alice")).json()
    assert r3 == {"entries": [], "seen": 12345}


def test_triggered_clear(clerk):
    r = client.delete("/api/alerts/triggered", headers=_auth("alice"))
    assert r.status_code == 204
    assert client.get("/api/alerts/triggered", headers=_auth("alice")).json()["entries"] == []


def test_user_isolation(clerk):
    client.post("/api/alerts", json=_body(), headers=_auth("alice"))
    assert client.get("/api/alerts", headers=_auth("bob")).json() == {"alerts": []}
    assert client.patch(
        "/api/alerts/al-1", json={"message": "hi"}, headers=_auth("bob")
    ).status_code == 404
    assert client.delete("/api/alerts/al-1", headers=_auth("bob")).status_code == 404


def test_broadcast_on_create(clerk):
    tok = clerk_fake.make_token(sub="alice")
    with client.websocket_connect(f"/ws/state?token={tok}") as ws:
        client.post(
            "/api/alerts", json=_body(), headers=_auth("alice"), params={"origin": "tab1"}
        )
        msg = ws.receive_json()
        assert msg == {
            "key": "__alerts__:changed",
            "value": {"broker": "capital", "epic": "US100", "origin": "tab1"},
        }
