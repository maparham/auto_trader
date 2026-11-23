"""`/api/alerts` with an `action` (SL/TP move rules)."""
from __future__ import annotations

import asyncio
import json

import pytest
from fastapi.testclient import TestClient

from auto_trader.api import alert_hooks
from auto_trader.api.app import app
from auto_trader.core.alert_store import AlertStore
from auto_trader.core.position_watch import POSITION_WATCH, Snap
from tests import clerk_fake

client = TestClient(app)
ACCT = "capital:demo"


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


@pytest.fixture
def positions(monkeypatch):
    state = {"snap": Snap(epic="US100", side="BUY", sl=90.0, tp=110.0, trailing=False, upnl=1.0, currency=None),
             "raise": False}

    async def fake_snapshot(account, deal_id):
        if state["raise"]:
            raise RuntimeError("boom")
        if deal_id == "gone":
            return None
        return state["snap"]

    monkeypatch.setattr(POSITION_WATCH, "snapshot", fake_snapshot)
    return state


def _action(**over):
    a = {"account": ACCT, "dealId": "d1", "field": "sl", "target": {"type": "breakeven", "offset": 0}}
    a.update(over)
    return a


def _body(**over):
    body = {"id": "al-mv", "broker": "capital", "epic": "US100", "kind": "price_level",
            "params": {"level": 100.0, "condition": "crossing_up", "trigger": "every"},
            "action": _action()}
    body.update(over)
    return body


def _plain(**over):
    body = _body(id="al-plain", action=None)
    del body["action"]
    body.update(over)
    return body


def test_create_move_rule_sets_direction_and_once(admin, positions):
    positions["snap"] = Snap(epic="US100", side="SELL", sl=110.0, tp=90.0, trailing=False, upnl=1.0, currency=None)
    r = client.post("/api/alerts", json=_body(action=_action(direction="BUY")), headers=admin)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["params"]["trigger"] == "once"
    assert body["action"]["direction"] == "SELL"
    assert body["notify"] == {"toast": True, "browser": False, "sound": False, "push": True, "telegram": True}


def test_create_requires_admin(clerk, positions):
    r = client.post("/api/alerts", json=_body(), headers=_auth("alice"))
    assert r.status_code == 403


def test_create_rejects_position_kind_with_action(admin, positions):
    r = client.post("/api/alerts", json=_body(kind="position"), headers=admin)
    assert r.status_code == 422 and "move_kind" in r.text


def test_create_position_not_found(admin, positions):
    r = client.post("/api/alerts", json=_body(action=_action(dealId="gone")), headers=admin)
    assert r.status_code == 422 and "position_not_found" in r.text


def test_create_trailing_sl_refused(admin, positions):
    positions["snap"] = Snap(epic="US100", side="BUY", sl=90.0, tp=110.0, trailing=True, upnl=1.0, currency=None)
    r = client.post("/api/alerts", json=_body(), headers=admin)
    assert r.status_code == 422 and "trailing_stop" in r.text
    r = client.post("/api/alerts", json=_body(action=_action(field="tp")), headers=admin)
    assert r.status_code == 200, r.text


def test_create_broker_error_503(admin, positions):
    positions["raise"] = True
    r = client.post("/api/alerts", json=_body(), headers=admin)
    assert r.status_code == 503


def test_create_account_broker_mismatch(admin, positions):
    r = client.post("/api/alerts", json=_body(broker="ig"), headers=admin)
    assert r.status_code == 422 and "account_broker_mismatch" in r.text


def test_create_bad_action_422(admin, positions):
    r = client.post("/api/alerts", json=_body(action=_action(field="xx")), headers=admin)
    assert r.status_code == 422 and "field must be sl or tp" in r.text


def test_one_rule_per_deal_field(admin, positions):
    assert client.post("/api/alerts", json=_body(), headers=admin).status_code == 200
    other = _body(id="al-mv2", params={"level": 120.0, "condition": "crossing_up", "trigger": "once"})
    r = client.post("/api/alerts", json=other, headers=admin)
    assert r.status_code == 409 and "SL already exists" in r.text
    r = client.post("/api/alerts", json={**other, "action": _action(field="tp")}, headers=admin)
    assert r.status_code == 200, r.text


def test_plain_alert_and_move_rule_same_level_coexist(admin, positions):
    plain = _plain(params={"level": 100.0, "condition": "crossing_up", "trigger": "once"})
    assert client.post("/api/alerts", json=plain, headers=admin).status_code == 200
    assert client.post("/api/alerts", json=_body(), headers=admin).status_code == 200
    # a second plain alert is still refused against the first plain one
    r = client.post("/api/alerts", json={**plain, "id": "al-plain2"}, headers=admin)
    assert r.status_code == 409


def test_plain_alert_after_move_rule_same_level_ok(admin, positions):
    assert client.post("/api/alerts", json=_body(), headers=admin).status_code == 200
    plain = _plain(params={"level": 100.0, "condition": "crossing_up", "trigger": "once"})
    r = client.post("/api/alerts", json=plain, headers=admin)
    assert r.status_code == 200, r.text


def test_create_empty_action_422(admin, positions):
    r = client.post("/api/alerts", json=_body(action={}), headers=admin)
    assert r.status_code == 422


def test_two_deals_same_trigger_level_ok(admin, positions):
    assert client.post("/api/alerts", json=_body(), headers=admin).status_code == 200
    r = client.post("/api/alerts", json=_body(id="al-mv2", action=_action(dealId="d2")), headers=admin)
    assert r.status_code == 200, r.text


def test_move_rule_expiry_refused(admin, positions):
    r = client.post("/api/alerts", json=_body(expires_at=4102444800000), headers=admin)
    assert r.status_code == 422 and "move_no_expiry" in r.text


def test_patch_target_only(admin, positions):
    client.post("/api/alerts", json=_body(), headers=admin)
    r = client.patch("/api/alerts/al-mv", json={"action": {"target": {"type": "price", "value": 95.0}}},
                     headers=admin)
    assert r.status_code == 200, r.text
    assert r.json()["action"]["target"] == {"type": "price", "value": 95.0}
    assert r.json()["action"]["dealId"] == "d1" and r.json()["action"]["direction"] == "BUY"
    r = client.patch("/api/alerts/al-mv", json={"action": {"dealId": "d2"}}, headers=admin)
    assert r.status_code == 422 and "action_locked" in r.text
    r = client.patch("/api/alerts/al-mv", json={"action": {"target": {"type": "price", "value": "x"}}},
                     headers=admin)
    assert r.status_code == 422


def test_patch_params_keeps_once_and_needs_admin(admin, positions):
    client.post("/api/alerts", json=_body(), headers=admin)
    r = client.patch("/api/alerts/al-mv", json={"params": {"level": 101.0, "trigger": "every"}}, headers=admin)
    assert r.status_code == 200 and r.json()["params"]["trigger"] == "once"
    from auto_trader.api.routers import alerts as alerts_router
    now = 1
    asyncio.run(alerts_router.ALERT_STORE.create("alice", {
        "id": "al-alice", "broker": "capital", "epic": "US100", "kind": "price_level",
        "params": {"level": 100.0, "condition": "crossing_up", "trigger": "once"},
        "message": "", "expires_at": None, "notify": {}, "precision": 2, "active": 1,
        "created_at": now, "updated_at": now, "action": {**_action(), "direction": "BUY"},
    }))
    r = client.patch("/api/alerts/al-alice", json={"params": {"level": 102.0}}, headers=_auth("alice"))
    assert r.status_code == 403
    r = client.patch("/api/alerts/al-mv", json={"expires_at": 4102444800000}, headers=admin)
    assert r.status_code == 422 and "move_no_expiry" in r.text


def test_patch_action_on_plain_alert_refused(admin, positions):
    client.post("/api/alerts", json=_plain(), headers=admin)
    r = client.patch("/api/alerts/al-plain", json={"action": {"target": {"type": "price", "value": 1.0}}},
                     headers=admin)
    assert r.status_code == 422 and "action_locked" in r.text


def test_rearm_move_rule_refused(admin, positions):
    from auto_trader.api.routers import alerts as alerts_router
    alert = {"id": "al-mv", "broker": "capital", "epic": "US100", "kind": "price_level",
             "params": {"level": 100.0, "condition": "crossing_up", "trigger": "once"},
             "message": "", "expires_at": None, "notify": {}, "precision": 2, "action": _action()}
    asyncio.run(alerts_router.ALERT_STORE.add_triggered("root", {
        "time": 5, "alert_id": "al-mv", "broker": "capital", "epic": "US100", "kind": "price_level",
        "price": 100.0, "level": 100.0, "condition": "crossing_up", "message": "", "precision": 2,
        "alert_json": json.dumps(alert),
    }))
    r = client.post("/api/alerts/al-mv/rearm", headers=admin)
    assert r.status_code == 422 and "not_rearmable" in r.text


def test_telegram_rearm_move_rule_refused(tmp_path, monkeypatch):
    row = {"id": "al-mv", "broker": "capital", "epic": "US100", "kind": "price_level",
           "params": {"level": 100.0, "condition": "crossing_up", "trigger": "once"},
           "message": "", "expires_at": None, "notify": {}, "precision": 2, "action": _action()}
    assert asyncio.run(alert_hooks._rearm("root", row)) is None

    from auto_trader.core.telegram_notify import TELEGRAM

    store = AlertStore(str(tmp_path / "tg.db"))

    async def main():
        rowid = await store.add_triggered("root", {
            "time": 1, "alert_id": "al-mv", "broker": "capital", "epic": "US100", "kind": "price_level",
            "price": 100.0, "level": 100.0, "condition": "crossing_up", "alert_json": json.dumps(row),
        })
        monkeypatch.setattr(TELEGRAM, "_store", store)
        answer = await TELEGRAM._rearm_from_triggered("root", rowid)
        return answer, await store.list_user("root")

    answer, rows = asyncio.run(main())
    assert answer == ("This rule can't be re-armed", False)
    assert rows == []
