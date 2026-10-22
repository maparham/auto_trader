from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from auto_trader.api import screen_jobs
from auto_trader.api.app import app
from auto_trader.core import screen_store
from auto_trader.core.models import Candle

client = TestClient(app)
T0 = datetime(2020, 1, 1, tzinfo=timezone.utc)
BODY = {"name": "Up", "broker": "yfinance", "resolution": "DAY",
        "symbols": ["A", "B"], "expression": "candle.close > 10",
        "columns": [{"name": "C", "expression": "candle.close"}]}


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(screen_store.SCREEN_STORE, "_db_path", str(tmp_path / "screens.db"))

    async def load(broker, epic, res, side, count):
        closes = [5, 11] if epic == "A" else [5, 5]
        return [Candle(time=T0 + timedelta(days=k), open=c, high=c, low=c, close=c, volume=1.0)
                for k, c in enumerate(closes)], False
    monkeypatch.setattr(screen_jobs, "SCREEN_JOBS", screen_jobs.ScreenJobs(loader=load))
    from auto_trader.api.routers import screens
    monkeypatch.setattr(screens, "SCREEN_JOBS", screen_jobs.SCREEN_JOBS)


def test_crud_roundtrip():
    created = client.post("/api/screens", json=BODY).json()
    assert created["symbols"] == ["A", "B"]
    assert client.get("/api/screens").json()["screens"][0]["id"] == created["id"]
    upd = client.put(f"/api/screens/{created['id']}", json={**BODY, "name": "Up2"}).json()
    assert upd["name"] == "Up2"
    assert client.delete(f"/api/screens/{created['id']}").status_code == 204
    assert client.delete(f"/api/screens/{created['id']}").status_code == 404


def test_save_bad_expression_422():
    r = client.post("/api/screens", json={**BODY, "expression": "candle.close >"})
    assert r.status_code == 422 and r.json()["detail"]["field"] == "expression"


def test_run_and_poll():
    body = {k: v for k, v in BODY.items() if k != "name"}
    r = client.post("/api/screens/run", json=body)
    assert r.status_code == 200
    jid = r.json()["jobId"]
    for _ in range(100):
        st = client.get(f"/api/screens/jobs/{jid}").json()
        if st["status"] != "running":
            break
    assert st["status"] == "done"
    assert [m["epic"] for m in st["result"]["matches"]] == ["A"]
    assert st["result"]["matches"][0]["columns"] == {"C": 11.0}


def test_run_bad_expression_422():
    body = {k: v for k, v in BODY.items() if k != "name"}
    r = client.post("/api/screens/run", json={**body, "expression": "EMA(9)@D > 1"})
    assert r.status_code == 422
    d = r.json()["detail"]
    assert d["code"] == "screen_tf_unsupported" and d["field"] == "expression"


def test_run_needs_symbols():
    body = {k: v for k, v in BODY.items() if k != "name"}
    assert client.post("/api/screens/run", json={**body, "symbols": []}).status_code == 422


def test_unknown_job_404():
    assert client.get("/api/screens/jobs/nope").status_code == 404
    assert client.post("/api/screens/jobs/nope/cancel").status_code == 404


def test_run_rejects_junk_price_side():
    body = {k: v for k, v in BODY.items() if k != "name"}
    assert client.post("/api/screens/run", json={**body, "priceSide": "junk"}).status_code == 422


def test_save_caps_symbols():
    r = client.post("/api/screens", json={**BODY, "symbols": [f"S{i}" for i in range(501)]})
    assert r.status_code == 422


def test_save_strips_and_dedupes_symbols():
    row = client.post("/api/screens", json={**BODY, "symbols": [" AAPL", "AAPL", " ", "MSFT "]}).json()
    assert row["symbols"] == ["AAPL", "MSFT"]
    upd = client.put(f"/api/screens/{row['id']}", json={**BODY, "symbols": ["X ", " X"]}).json()
    assert upd["symbols"] == ["X"]


def test_run_strips_symbols():
    body = {k: v for k, v in BODY.items() if k != "name"}
    r = client.post("/api/screens/run", json={**body, "symbols": [" A", "A ", "B"]})
    assert r.status_code == 200 and r.json()["total"] == 2


def test_length_caps():
    assert client.post("/api/screens", json={**BODY, "symbols": ["X" * 65]}).status_code == 422
    long_expr = "candle.close > " + "1" * 2000
    assert client.post("/api/screens", json={**BODY, "expression": long_expr}).status_code == 422


RSI_PANE = {"RSI": {"type": "RSI", "calcParams": [14], "extendData": {}}}


def test_run_with_indicator_ref():
    r = client.post("/api/screens/run", json={
        "broker": "yfinance", "resolution": "DAY", "symbols": ["AAPL"],
        "expression": "RSI.value < 101", "indicators": RSI_PANE})
    assert r.status_code == 200, r.text


def test_unknown_ref_422_names_field():
    r = client.post("/api/screens/run", json={
        "broker": "yfinance", "resolution": "DAY", "symbols": ["AAPL"],
        "expression": "RSI.value < 30"})
    assert r.status_code == 422
    assert r.json()["detail"]["field"] == "expression"


def test_unregistered_type_422():
    r = client.post("/api/screens/run", json={
        "broker": "yfinance", "resolution": "DAY", "symbols": ["AAPL"],
        "expression": "candle.close > 0",
        "indicators": {"MACD": {"type": "MACD", "calcParams": [12, 26, 9]}}})
    assert r.status_code == 422
    assert "MACD" in r.text


def test_indicator_caps_422():
    many = {f"RSI{i}": {"type": "RSI", "calcParams": [14]} for i in range(17)}
    big = {"RSI": {"type": "RSI", "calcParams": [14], "extendData": {"pad": "x" * 40000}}}
    for ind in (many, big):
        r = client.post("/api/screens/run", json={
            "broker": "yfinance", "resolution": "DAY", "symbols": ["AAPL"],
            "expression": "candle.close > 0", "indicators": ind})
        assert r.status_code == 422, ind.keys()


def test_save_roundtrips_indicators():
    r = client.post("/api/screens", json={
        "name": "Div", "broker": "yfinance", "resolution": "DAY", "symbols": ["AAPL"],
        "expression": "count(RSI.bullDiv > 0, 5) >= 1", "indicators": RSI_PANE})
    assert r.status_code == 200, r.text
    assert r.json()["indicators"]["RSI"]["type"] == "RSI"
