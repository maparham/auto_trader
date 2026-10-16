"""`/api/alerts` CRUD + triggered-history endpoints."""
from __future__ import annotations

from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

import auto_trader.api.deps as deps_mod
from auto_trader.api.app import app
from auto_trader.core.alert_kinds import INDICATOR
from auto_trader.core.models import Candle
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


def _rsi_body(ext=None) -> dict:
    return _body(id="al-rsi", kind="indicator", params={
        "instance": {"type": "RSI", "calcParams": [14], "extendData": ext or {}},
        "output": "value", "timeframe": "HOUR", "target": "value", "value": 70,
        "evalOn": "close", "condition": "crossing", "trigger": "once", "link": None,
    })


def _ma_body(ext=None, output="ma") -> dict:
    return _body(id="al-ma", kind="indicator", params={
        "instance": {"type": "MA", "calcParams": [20], "extendData": ext or {}},
        "output": output, "timeframe": "HOUR", "target": "price", "value": None,
        "evalOn": "close", "condition": "crossing", "trigger": "once", "link": None,
    })


def test_alertable_types(clerk):
    r = client.get("/api/alerts/indicators", headers=_auth("alice"))
    assert r.status_code == 200
    assert {"MA", "EMA", "RSI", "ATR", "TRENDLINES", "SR_LEVELS"} <= set(r.json()["types"])


def test_describe_lists_outputs_and_refusal(clerk):
    r = client.post("/api/alerts/describe", json={
        "broker": "b", "epic": "E", "timeframe": "HOUR",
        "instance": {"type": "RSI", "calcParams": [14], "extendData": {}},
    }, headers=_auth("alice"))
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["type"] == "RSI" and d["timeframe"] == "HOUR" and d["refusal"] is None
    by = {o["name"]: o for o in d["outputs"]}
    assert by["value"] == {"name": "value", "label": "RSI 14", "kind": "level", "priceScale": False, "priceOnly": False}
    assert by["bullDiv"]["kind"] == "event"
    assert isinstance(d["lastValues"], dict)


def test_describe_follows_the_pin_and_refuses_seconds(clerk):
    pinned = client.post("/api/alerts/describe", json={
        "broker": "b", "epic": "E", "timeframe": "HOUR",
        "instance": {"type": "MA", "calcParams": [20], "extendData": {"mtf": {"timeframe": "DAY"}}},
    }, headers=_auth("alice")).json()
    assert pinned["timeframe"] == "DAY"
    secs = client.post("/api/alerts/describe", json={
        "broker": "b", "epic": "E", "timeframe": "SECOND_30",
        "instance": {"type": "RSI", "calcParams": [14], "extendData": {}},
    }, headers=_auth("alice")).json()
    assert secs["refusal"] == "Alerts on this timeframe are coming later"


def test_describe_unknown_type_422(clerk):
    r = client.post("/api/alerts/describe", json={
        "broker": "b", "epic": "E", "timeframe": "HOUR",
        "instance": {"type": "BOLL", "calcParams": [20], "extendData": {}},
    }, headers=_auth("alice"))
    assert r.status_code == 422


def test_list_and_create_carry_label(clerk):
    saved = client.post("/api/alerts", json=_rsi_body(), headers=_auth("alice")).json()
    assert saved["label"] == "RSI 14 (1H)"
    rows = client.get("/api/alerts", headers=_auth("alice")).json()["alerts"]
    assert next(r for r in rows if r["id"] == saved["id"])["label"] == "RSI 14 (1H)"


def test_patch_instance_replaces_the_pane(clerk):
    saved = client.post("/api/alerts", json=_rsi_body(ext={"source": "hl2"}), headers=_auth("alice")).json()
    r = client.patch(f"/api/alerts/{saved['id']}", json={"params": {"instance": {
        "type": "RSI", "calcParams": [21], "extendData": {}}}}, headers=_auth("alice"))
    assert r.status_code == 200, r.text
    assert r.json()["params"]["config"]["length"] == 21
    assert r.json()["params"]["config"]["source"] == "close"


def test_patch_same_instance_keeps_sig(clerk):
    body = _rsi_body()
    saved = client.post("/api/alerts", json=body, headers=_auth("alice")).json()
    r = client.patch(f"/api/alerts/{saved['id']}", json={"params": {"instance": body["params"]["instance"]}},
                      headers=_auth("alice"))
    assert r.status_code == 200, r.text
    assert INDICATOR.sig(r.json()["params"]) == INDICATOR.sig(saved["params"])


def test_patch_onto_a_missing_output_422(clerk):
    saved = client.post(
        "/api/alerts",
        json=_ma_body(ext={"smoothing": {"type": "ema", "length": 5}}, output="smoothingMa"),
        headers=_auth("alice"),
    ).json()
    r = client.patch(f"/api/alerts/{saved['id']}", json={"params": {"instance": {
        "type": "MA", "calcParams": [20], "extendData": {}}}}, headers=_auth("alice"))
    assert r.status_code == 422


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


def test_duplicate_price_level_409(clerk):
    client.post("/api/alerts", json=_body(), headers=_auth("alice"))
    r = client.post("/api/alerts", json=_body(id="al-2"), headers=_auth("alice"))
    assert r.status_code == 409 and "already exists" in r.json()["detail"]
    # message/notify/expiry differ: still the same thing firing, still a duplicate.
    r = client.post(
        "/api/alerts",
        json=_body(id="al-3", message="different note", expires_at=9_999_999_999_999,
                   notify={"toast": False}),
        headers=_auth("alice"),
    )
    assert r.status_code == 409


def test_not_a_duplicate_across_epic_condition_trigger_or_user(clerk):
    client.post("/api/alerts", json=_body(), headers=_auth("alice"))
    assert client.post("/api/alerts", json=_body(id="al-2", epic="US500"), headers=_auth("alice")).status_code == 200
    assert client.post(
        "/api/alerts",
        json=_body(id="al-3", params={"level": 100.0, "condition": "crossing_up", "trigger": "once"}),
        headers=_auth("alice"),
    ).status_code == 200
    assert client.post(
        "/api/alerts",
        json=_body(id="al-4", params={"level": 100.0, "condition": "crossing", "trigger": "every"}),
        headers=_auth("alice"),
    ).status_code == 200
    assert client.post("/api/alerts", json=_body(id="al-5"), headers=_auth("bob")).status_code == 200


def test_patch_into_a_duplicate_409(clerk):
    client.post("/api/alerts", json=_body(), headers=_auth("alice"))  # al-1: level 100, crossing, once
    client.post("/api/alerts", json=_body(id="al-2", params={"level": 90.0, "condition": "crossing", "trigger": "once"}),
                 headers=_auth("alice"))
    r = client.patch("/api/alerts/al-2", json={"params": {"level": 100.0}}, headers=_auth("alice"))
    assert r.status_code == 409 and "already exists" in r.json()["detail"]
    # Saving an alert's own params back unchanged never 409s against itself.
    r = client.patch("/api/alerts/al-1", json={"params": {"level": 100.0}}, headers=_auth("alice"))
    assert r.status_code == 200


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


def _ind_body(**params):
    p = {
        "indicator": "MA", "calcParams": [50], "config": {"maType": "ema"},
        "line": "value", "timeframe": "HOUR", "target": "price", "value": None,
        "condition": "crossing_up", "trigger": "once", "evalOn": "close",
        "link": {"scope": "tab.t1.cell.c2", "instanceId": "EMA"},
    }
    p.update(params)
    return _body(id="al-ind", kind="indicator", params=p)


def test_indicator_create_round_trip(clerk):
    # An old-shape POST (an old frontend tab during deploy) is stored in the
    # registry shape.
    r = client.post("/api/alerts", json=_ind_body(), headers=_auth("alice"))
    assert r.status_code == 200, r.text
    params = r.json()["params"]
    assert (params["type"], params["output"]) == ("MA", "ma")
    assert (params["config"]["length"], params["config"]["ma_type"], params["config"]["source"]) == (50, "ema", "close")
    assert not {"indicator", "calcParams", "line"} & set(params)
    stored = client.get("/api/alerts", headers=_auth("alice")).json()["alerts"][0]["params"]
    assert stored == params


def test_duplicate_indicator_alert_409(clerk):
    client.post("/api/alerts", json=_ind_body(), headers=_auth("alice"))
    dup = {**_ind_body(), "id": "al-ind-2"}
    r = client.post("/api/alerts", json=dup, headers=_auth("alice"))
    assert r.status_code == 409 and "already exists" in r.json()["detail"]
    # A different calcParams is a different alert, not a duplicate.
    other = {**_ind_body(calcParams=[55]), "id": "al-ind-3"}
    assert client.post("/api/alerts", json=other, headers=_auth("alice")).status_code == 200


def test_indicator_non_native_timeframe_422(clerk):
    r = client.post("/api/alerts", json=_ind_body(timeframe="HOUR_2"), headers=_auth("alice"))
    assert r.status_code == 422 and "timeframe" in r.text
    r = client.post("/api/alerts", json=_ind_body(timeframe="SECOND_5"), headers=_auth("alice"))
    assert r.status_code == 422


def test_deferred_indicator_422(clerk):
    r = client.post("/api/alerts", json=_ind_body(indicator="BOLL", calcParams=[20, 2]), headers=_auth("alice"))
    assert r.status_code == 422 and "not alertable" in r.text


def test_malformed_old_shape_422(clerk):
    r = client.post("/api/alerts", json=_ind_body(indicator="RSI", calcParams=["x"], config={}),
                    headers=_auth("alice"))
    assert r.status_code == 422 and "params.calcParams" in r.text


def test_indicator_patch_validates_merged_params(clerk):
    client.post("/api/alerts", json=_ind_body(), headers=_auth("alice"))
    inst = {"type": "MA", "calcParams": [100], "extendData": {"maType": "ema"}}
    r = client.patch("/api/alerts/al-ind", json={"params": {"instance": inst}}, headers=_auth("alice"))
    assert r.status_code == 200 and r.json()["params"]["config"]["length"] == 100
    assert "instance" not in r.json()["params"]
    bad = {"type": "BOLL", "calcParams": [20, 2], "extendData": {}}
    r = client.patch("/api/alerts/al-ind", json={"params": {"instance": bad}}, headers=_auth("alice"))
    assert r.status_code == 422


def test_indicator_patch_config_no_longer_deep_merges(clerk):
    # PATCH no longer deep-merges params.config against the stored config:
    # a raw partial config (missing required dataclass fields) 422s instead
    # of being filled in from the stored pane.
    r = client.post(
        "/api/alerts", json=_ind_body(config={"maType": "ema", "source": "hl2"}),
        headers=_auth("alice"),
    )
    assert r.status_code == 200, r.text
    cfg = r.json()["params"]["config"]
    assert (cfg["ma_type"], cfg["source"]) == ("ema", "hl2")

    r = client.patch(
        "/api/alerts/al-ind", json={"params": {"config": {"ma_type": "sma"}}},
        headers=_auth("alice"),
    )
    assert r.status_code == 422

    # params.instance replaces the stored pane whole: a previous extendData
    # field (source: hl2) does not survive an instance patch that omits it.
    r = client.patch(
        "/api/alerts/al-ind",
        json={"params": {"instance": {"type": "MA", "calcParams": [50], "extendData": {"maType": "sma"}}}},
        headers=_auth("alice"),
    )
    assert r.status_code == 200, r.text
    cfg = r.json()["params"]["config"]
    assert (cfg["ma_type"], cfg["source"]) == ("sma", "close")


def test_indicator_patch_non_dict_config_422(clerk):
    # A non-dict config (string/list/null) must fall through to
    # IndicatorKind.validate's own 422, not raise a TypeError from `**` on a
    # non-mapping during the deep merge.
    client.post("/api/alerts", json=_ind_body(), headers=_auth("alice"))
    r = client.patch(
        "/api/alerts/al-ind", json={"params": {"config": "notadict"}},
        headers=_auth("alice"),
    )
    assert r.status_code == 422, r.text


def test_vwma_intrabar_422_on_quote_only_broker(clerk):
    # dukascopy is a real registered data-only broker with no credentials
    # needed in tests (supports_streaming=False); capital (the default body
    # broker) streams, so this is the one case that actually exercises
    # `_streams`/`supports_streaming` end to end through the router.
    body = _ind_body(config={"maType": "vwma"}, evalOn="intrabar")
    body["broker"] = "dukascopy"
    r = client.post("/api/alerts", json=body, headers=_auth("alice"))
    assert r.status_code == 422 and "intrabar" in r.text


def test_triggered_entries_carry_parsed_alert(clerk):
    import json
    from auto_trader.api.routers import alerts as alerts_router
    store = alerts_router.ALERT_STORE
    import asyncio
    asyncio.run(store.add_triggered("alice", {
        "time": 5, "alert_id": "al-x", "broker": "capital", "epic": "US100", "kind": "indicator",
        "price": 1.0, "level": 2.0, "condition": "crossing", "message": "", "precision": 2,
        "alert_json": json.dumps({"id": "al-x", "params": {"indicator": "RSI"}}),
    }))
    r = client.get("/api/alerts/triggered", headers=_auth("alice"))
    entry = r.json()["entries"][0]
    assert entry["alert"]["params"]["indicator"] == "RSI" and "alert_json" not in entry


def test_triggered_entries_upgrade_old_shape_indicator_params(clerk):
    import asyncio
    import json

    from auto_trader.api.routers import alerts as alerts_router
    store = alerts_router.ALERT_STORE
    old_params = {
        "indicator": "RSI", "calcParams": [14], "config": {"source": "close"}, "line": "value",
        "timeframe": "HOUR", "target": "value", "value": 70, "evalOn": "close",
        "condition": "crossing", "trigger": "once", "link": None,
    }
    asyncio.run(store.add_triggered("alice", {
        "time": 5, "alert_id": "al-y", "broker": "capital", "epic": "US100", "kind": "indicator",
        "price": 1.0, "level": 2.0, "condition": "crossing", "message": "", "precision": 2,
        "alert_json": json.dumps({"id": "al-y", "kind": "indicator", "params": old_params}),
    }))
    r = client.get("/api/alerts/triggered", headers=_auth("alice"))
    entry = r.json()["entries"][0]
    assert entry["alert"]["params"]["type"] == "RSI"
    assert "indicator" not in entry["alert"]["params"]
    assert entry["alert"]["label"]


def test_list_includes_status_for_indicator_alerts(clerk, monkeypatch):
    from auto_trader.api.routers import alerts as alerts_router
    client.post("/api/alerts", json=_ind_body(), headers=_auth("alice"))
    client.post("/api/alerts", json=_body(id="al-p"), headers=_auth("alice"))
    monkeypatch.setattr(alerts_router.ALERT_ENGINE, "statuses",
                        lambda u: {"al-ind": "waiting_for_data"})
    rows = {r["id"]: r for r in client.get("/api/alerts", headers=_auth("alice")).json()["alerts"]}
    assert rows["al-ind"]["status"] == "waiting_for_data"
    assert "status" not in rows["al-p"]


H = 3_600_000


def _line_body(**kw):
    p = {"timeframe": "HOUR", "evalOn": "close", "condition": "crossing", "trigger": "every",
         "tRef": 9 * H, "pRef": 100.0, "slope": 0.5,
         "anchors": {"t1": 2 * H, "p1": 96.0, "t2": 6 * H, "p2": 98.0},
         "link": {"scope": "s", "instanceId": "TRENDLINES", "lineKey": "7200000:21600000"}}
    p.update(kw)
    return _body(id="al-line", kind="line", params=p)


@pytest.fixture
def bars(monkeypatch):
    state = {"bars": [Candle(datetime.fromtimestamp(h * 3600, tz=timezone.utc), 1, 1, 1, 1, 1.0)
                      for h in range(5, 11)], "degraded": False}

    async def fake(broker, epic, res, side, count):
        return state["bars"], state["degraded"]

    monkeypatch.setattr(deps_mod, "load_alert_bars", fake)
    return state


def test_line_create_round_trip(clerk, bars):
    r = client.post("/api/alerts", json=_line_body(), headers=_auth("alice"))
    assert r.status_code == 200, r.text
    assert r.json()["params"]["tRef"] == 9 * H


def test_duplicate_line_alert_409(clerk, bars):
    client.post("/api/alerts", json=_line_body(), headers=_auth("alice"))
    # tRef/pRef roll forward (engine rebase) and are excluded from the line's
    # sig; a second alert on the SAME slope/anchors is still the same line.
    dup = {**_line_body(tRef=10 * H, pRef=100.5), "id": "al-line-2"}
    r = client.post("/api/alerts", json=dup, headers=_auth("alice"))
    assert r.status_code == 409 and "already exists" in r.json()["detail"]
    other = {**_line_body(slope=1.0), "id": "al-line-3"}
    assert client.post("/api/alerts", json=other, headers=_auth("alice")).status_code == 200


def test_line_create_with_unknown_reference_422(clerk, bars):
    r = client.post("/api/alerts", json=_line_body(tRef=3 * H), headers=_auth("alice"))
    assert r.status_code == 422 and "reload the chart" in r.json()["detail"]


def test_line_create_when_bars_fail_503(clerk, bars):
    bars["degraded"] = True
    r = client.post("/api/alerts", json=_line_body(), headers=_auth("alice"))
    assert r.status_code == 503


def test_line_patch_keeps_the_server_reference(clerk, bars):
    client.post("/api/alerts", json=_line_body(), headers=_auth("alice"))
    r = client.patch("/api/alerts/al-line", json={"params": {"condition": "greater"}}, headers=_auth("alice"))
    assert r.status_code == 200
    assert r.json()["params"]["tRef"] == 9 * H and r.json()["params"]["condition"] == "greater"


def test_line_patch_refuses_geometry(clerk, bars):
    client.post("/api/alerts", json=_line_body(), headers=_auth("alice"))
    for key, value in (("tRef", 8 * H), ("pRef", 1.0), ("slope", 0.0),
                       ("anchors", {"t1": 1 * H, "p1": 1.0, "t2": 2 * H, "p2": 2.0})):
        r = client.patch("/api/alerts/al-line", json={"params": {key: value}}, headers=_auth("alice"))
        assert r.status_code == 422, key
        assert r.json()["detail"] == "A line alert's geometry can't be changed"
    row = client.get("/api/alerts", headers=_auth("alice")).json()["alerts"][0]
    assert row["params"]["tRef"] == 9 * H and row["params"]["pRef"] == 100.0


def test_line_rows_report_a_status(clerk, bars, monkeypatch):
    # Pins the router's line branch: with no engine status for the row, a
    # line alert still reports waiting_for_data (a price alert would not).
    from auto_trader.api.routers import alerts as alerts_router
    client.post("/api/alerts", json=_line_body(), headers=_auth("alice"))
    monkeypatch.setattr(alerts_router.ALERT_ENGINE, "statuses", lambda u: {})
    rows = client.get("/api/alerts", headers=_auth("alice")).json()["alerts"]
    assert rows[0]["status"] == "waiting_for_data"
