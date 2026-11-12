"""`/api/alerts` with `kind: "position"` (SL/TP proximity alerts)."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import auto_trader.api.deps as deps_mod
from auto_trader.api.app import app
from auto_trader.core.position_watch import POSITION_WATCH, Snap
from tests import clerk_fake

client = TestClient(app)
ACCT = "capital-live:live"


@pytest.fixture
def clerk(monkeypatch):
    clerk_fake.install(monkeypatch)


def _auth(sub: str) -> dict:
    return {"Authorization": f"Bearer {clerk_fake.make_token(sub=sub)}"}


@pytest.fixture
def admin(monkeypatch, clerk):
    from auto_trader.api import auth
    monkeypatch.setenv(auth.ADMIN_USER_IDS_ENV, "root")
    return _auth("root")


class _FakeExec:
    env = "live"
    is_real_money = True


@pytest.fixture
def env(monkeypatch):
    from auto_trader.brokers.registry import BrokerRegistry
    reg = BrokerRegistry()
    reg.exec[ACCT] = _FakeExec()
    reg.exec["mt5:live"] = _FakeExec()
    monkeypatch.setattr(deps_mod, "_registry", reg)
    state = {"snap": Snap(epic="US100", side="BUY", sl=90.0, tp=110.0, trailing=False, upnl=1.0, currency=None),
             "calls": [], "raise": False}

    async def fake_snapshot(account, deal_id):
        if state["raise"]:
            raise RuntimeError("boom")
        return state["snap"]

    monkeypatch.setattr(POSITION_WATCH, "snapshot", fake_snapshot)
    monkeypatch.setattr(POSITION_WATCH, "on_alert_changed",
                        lambda uid, row, aid: state["calls"].append((uid, row, aid)))
    monkeypatch.setattr(POSITION_WATCH, "status",
                        lambda uid, aid: {"level": 90.0, "distanceAtr": 1.2, "fired": False, "trailing": False})
    return state


def _body(**over):
    body = {"id": "al-pos", "broker": ACCT, "epic": "US100", "kind": "position",
            "params": {"dealId": "d1", "side": "sl", "atrMult": 0.5}}
    body.update(over)
    return body


def test_create_requires_admin(clerk, env):
    r = client.post("/api/alerts", json=_body(), headers=_auth("alice"))
    assert r.status_code == 403


def test_create_ok_notifies_watch(admin, env):
    r = client.post("/api/alerts", json=_body(), headers=admin)
    assert r.status_code == 200, r.text
    assert env["calls"][-1][2] == "al-pos" and env["calls"][-1][1]["kind"] == "position"


def test_create_refuses_mt5(admin, env):
    r = client.post("/api/alerts", json=_body(broker="mt5:live"), headers=admin)
    assert r.status_code == 422 and "account_not_watchable" in r.text


def test_create_refuses_unknown_account(admin, env):
    r = client.post("/api/alerts", json=_body(broker="nope:live"), headers=admin)
    assert r.status_code == 422 and "account_not_watchable" in r.text


def test_create_bad_params(admin, env):
    r = client.post("/api/alerts", json=_body(params={"dealId": "d1", "side": "sl", "atrMult": 99}), headers=admin)
    assert r.status_code == 422


def test_position_not_found(admin, env):
    env["snap"] = None
    r = client.post("/api/alerts", json=_body(), headers=admin)
    assert r.status_code == 422 and "position_not_found" in r.text


def test_wrong_epic(admin, env):
    r = client.post("/api/alerts", json=_body(epic="GOLD"), headers=admin)
    assert r.status_code == 422 and "position_not_found" in r.text


def test_no_level(admin, env):
    env["snap"] = Snap(epic="US100", side="BUY", sl=None, tp=110.0, trailing=False, upnl=None, currency=None)
    r = client.post("/api/alerts", json=_body(), headers=admin)
    assert r.status_code == 422 and "no_level" in r.text


def test_trailing_sl_refused_tp_allowed(admin, env):
    env["snap"] = Snap(epic="US100", side="BUY", sl=90.0, tp=110.0, trailing=True, upnl=None, currency=None)
    r = client.post("/api/alerts", json=_body(), headers=admin)
    assert r.status_code == 422 and "trailing_stop" in r.text
    r = client.post("/api/alerts", json=_body(params={"dealId": "d1", "side": "tp", "atrMult": 0.5}), headers=admin)
    assert r.status_code == 200, r.text


def test_broker_failure_503(admin, env):
    env["raise"] = True
    r = client.post("/api/alerts", json=_body(), headers=admin)
    assert r.status_code == 503


def test_duplicate_409_before_lookup(admin, env):
    assert client.post("/api/alerts", json=_body(), headers=admin).status_code == 200
    env["raise"] = True  # a lookup would 503; the duplicate check must come first
    r = client.post("/api/alerts", json=_body(id="al-2", params={"dealId": "d1", "side": "sl", "atrMult": 1}), headers=admin)
    assert r.status_code == 409


def test_list_decorates_status(admin, env):
    client.post("/api/alerts", json=_body(), headers=admin)
    rows = client.get("/api/alerts", headers=admin).json()["alerts"]
    row = next(r for r in rows if r["id"] == "al-pos")
    assert row["level"] == 90.0 and row["distanceAtr"] == 1.2 and row["fired"] is False and row["trailing"] is False


def test_patch_mult_only(admin, env):
    client.post("/api/alerts", json=_body(), headers=admin)
    r = client.patch("/api/alerts/al-pos", json={"params": {"atrMult": 1.5}}, headers=admin)
    assert r.status_code == 200 and r.json()["params"]["atrMult"] == 1.5
    r = client.patch("/api/alerts/al-pos", json={"params": {"atrMult": 50}}, headers=admin)
    assert r.status_code == 422
    r = client.patch("/api/alerts/al-pos", json={"params": {"side": "tp"}}, headers=admin)
    assert r.status_code == 422
    r = client.patch("/api/alerts/al-pos", json={"params": {"dealId": "d2"}}, headers=admin)
    assert r.status_code == 422


def test_patch_requires_admin(admin, env, monkeypatch):
    client.post("/api/alerts", json=_body(), headers=admin)
    r = client.patch("/api/alerts/al-pos", json={"params": {"atrMult": 1}}, headers=_auth("root2"))
    assert r.status_code in (403, 404)


def test_delete_routes_to_watch(admin, env):
    client.post("/api/alerts", json=_body(), headers=admin)
    r = client.delete("/api/alerts/al-pos", headers=admin)
    assert r.status_code == 204
    assert env["calls"][-1][1] is None and env["calls"][-1][2] == "al-pos"
