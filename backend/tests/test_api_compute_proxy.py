"""GET /api/compute/status + the ?target=remote proxy for the three sweep-job
endpoints (submit / poll / cancel).

target=remote forwards the request UNTOUCHED to the remote compute host: no local
validation, no probe, no local job creation. The remote host does all of that, so
these tests never create the strategies dir yet the forward still succeeds."""

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from auto_trader.api.app import app

from test_api_backtest_coded import base_request, make_candles

client = TestClient(app)

REMOTE_URL = "https://x.fly.dev"
REMOTE_TOKEN = "secret-token"


@pytest.fixture
def remote_env(monkeypatch):
    monkeypatch.setenv("COMPUTE_HOST_URL", REMOTE_URL)
    monkeypatch.setenv("COMPUTE_HOST_TOKEN", REMOTE_TOKEN)
    yield


@pytest.fixture
def no_remote_env(monkeypatch):
    # Empty strings, not delenv: process env must shadow any COMPUTE_HOST_*
    # values in the developer's real backend/.env (the config falls back to it).
    monkeypatch.setenv("COMPUTE_HOST_URL", "")
    monkeypatch.setenv("COMPUTE_HOST_TOKEN", "")
    yield


# --- status endpoint ----------------------------------------------------------


def test_status_false_when_unconfigured(no_remote_env):
    res = client.get("/api/compute/status")
    assert res.status_code == 200
    assert res.json() == {"remoteConfigured": False}


def test_status_false_when_only_url_set(monkeypatch):
    monkeypatch.setenv("COMPUTE_HOST_URL", REMOTE_URL)
    monkeypatch.setenv("COMPUTE_HOST_TOKEN", "")
    res = client.get("/api/compute/status")
    assert res.json() == {"remoteConfigured": False}


def test_status_true_when_configured(remote_env):
    res = client.get("/api/compute/status")
    assert res.status_code == 200
    assert res.json() == {"remoteConfigured": True}


# --- submit proxy -------------------------------------------------------------


@respx.mock
def test_submit_remote_forwards_body_and_bearer(remote_env):
    route = respx.post(f"{REMOTE_URL}/api/backtest/sweep/jobs").mock(
        return_value=httpx.Response(200, json={"jobId": "r1", "total": 5})
    )
    req = base_request("does-not-exist.py", make_candles(20))
    req["sweep"] = {"combos": [{"param:n": 3}]}

    res = client.post("/api/backtest/sweep/jobs?target=remote", json=req)

    assert res.status_code == 200
    assert res.json() == {"jobId": "r1", "total": 5}
    assert route.called
    sent = route.calls.last.request
    assert sent.headers["authorization"] == f"Bearer {REMOTE_TOKEN}"
    # The forward re-dumps the parsed BacktestRequest (full model with defaults),
    # so the meaningful fields must survive verbatim.
    import json as _json
    body = _json.loads(sent.content)
    assert body["epic"] == req["epic"]
    assert body["codedStrategy"] == "does-not-exist.py"
    assert body["sweep"]["combos"] == [{"param:n": 3}]
    assert body["candles"] == req["candles"]


# --- poll proxy ---------------------------------------------------------------


@respx.mock
def test_poll_remote_forwards_cursor(remote_env):
    route = respx.get(f"{REMOTE_URL}/api/backtest/sweep/jobs/r1").mock(
        return_value=httpx.Response(
            200,
            json={"rows": [], "done": 5, "total": 5, "running": False,
                  "cancelled": False, "error": None, "etaSeconds": None},
        )
    )
    res = client.get("/api/backtest/sweep/jobs/r1?target=remote&cursor=7")

    assert res.status_code == 200
    assert res.json()["done"] == 5
    assert route.called
    assert route.calls.last.request.url.params["cursor"] == "7"
    assert route.calls.last.request.headers["authorization"] == f"Bearer {REMOTE_TOKEN}"


# --- cancel proxy (status + body passthrough) ---------------------------------


@respx.mock
def test_cancel_remote_relays_404(remote_env):
    respx.post(f"{REMOTE_URL}/api/backtest/sweep/jobs/nope/cancel").mock(
        return_value=httpx.Response(404, json={"detail": "job not found"})
    )
    res = client.post("/api/backtest/sweep/jobs/nope/cancel?target=remote")

    assert res.status_code == 404
    assert res.json() == {"detail": "job not found"}


# --- unconfigured + connect-error mappings ------------------------------------


@respx.mock(assert_all_called=False)
def test_submit_remote_unconfigured_422_no_http(no_remote_env):
    route = respx.post(f"{REMOTE_URL}/api/backtest/sweep/jobs")
    req = base_request("does-not-exist.py", make_candles(20))
    req["sweep"] = {"combos": [{"param:n": 3}]}

    res = client.post("/api/backtest/sweep/jobs?target=remote", json=req)

    assert res.status_code == 422
    assert not route.called


@respx.mock
def test_submit_remote_non_json_maps_502(remote_env):
    respx.post(f"{REMOTE_URL}/api/backtest/sweep/jobs").mock(
        return_value=httpx.Response(200, text="<html>gateway</html>")
    )
    req = base_request("does-not-exist.py", make_candles(20))
    req["sweep"] = {"combos": [{"param:n": 3}]}

    res = client.post("/api/backtest/sweep/jobs?target=remote", json=req)

    assert res.status_code == 502
    assert "non-JSON" in res.json()["detail"]


@respx.mock
def test_submit_remote_connect_error_maps_502(remote_env):
    respx.post(f"{REMOTE_URL}/api/backtest/sweep/jobs").mock(
        side_effect=httpx.ConnectError("boom")
    )
    req = base_request("does-not-exist.py", make_candles(20))
    req["sweep"] = {"combos": [{"param:n": 3}]}

    res = client.post("/api/backtest/sweep/jobs?target=remote", json=req)

    assert res.status_code == 502
    assert "unreachable" in res.json()["detail"]


@respx.mock
def test_submit_remote_read_timeout_maps_502(remote_env):
    # A read timeout mid-request (Fly hiccup) is a TimeoutException, not a
    # ConnectError: it must still map to 502 unreachable, not surface as a 500.
    respx.post(f"{REMOTE_URL}/api/backtest/sweep/jobs").mock(
        side_effect=httpx.ReadTimeout("slow")
    )
    req = base_request("does-not-exist.py", make_candles(20))
    req["sweep"] = {"combos": [{"param:n": 3}]}

    res = client.post("/api/backtest/sweep/jobs?target=remote", json=req)

    assert res.status_code == 502
    assert "unreachable" in res.json()["detail"]
