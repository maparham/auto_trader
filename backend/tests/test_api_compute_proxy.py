"""GET /api/compute/status + the ?target=remote proxy for the three sweep-job
endpoints (submit / poll / cancel).

On a remote SUBMIT the local proxy first fills req.htfCandles from its cache (so
the remote never fetches bars from a broker), then forwards; poll/cancel forward
verbatim. The remote host owns validation/probe/job creation. These submit tests
use a base-timeframe-only rule sweep so the HTF pre-fetch is a trivial empty set
(no broker call, no strategies dir needed)."""

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from auto_trader.api.app import app

from test_api_backtest_coded import make_candles

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


def rule_sweep_request() -> dict:
    """A base-timeframe-only RULE sweep: no coded strategy, no HTF operand. The
    local proxy's HTF pre-fetch is therefore trivial (empty set, no broker call),
    so these tests exercise pure forward mechanics without a strategies dir."""
    empty = {"combine": "AND", "rules": []}
    return {
        "epic": "EURUSD", "resolution": "HOUR", "candles": make_candles(20), "series": {},
        "longEntry": {"combine": "AND", "rules": [
            {"left": {"kind": "indicator", "indicator": "EMA", "length": 9},
             "op": "gt", "right": {"kind": "const", "value": 50.0}}]},
        "longExit": empty, "shortEntry": empty, "shortExit": empty,
        "costs": {"quantity": 1, "commissionPerSide": 0,
                  "slippage": {"kind": "fixed", "value": 0}, "startingCash": 1000},
        "tradeFromTime": make_candles(20)[0]["time"],
        "sweep": {"combos": [{"rule:long.entry.0.left.length": 9},
                             {"rule:long.entry.0.left.length": 12}]},
    }


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
    req = rule_sweep_request()

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
    assert body["sweep"]["combos"] == req["sweep"]["combos"]
    assert body["candles"] == req["candles"]
    # The proxy attaches an htfCandles set (empty here — no HTF operand) so the
    # remote never fetches from a broker.
    assert body["htfCandles"] == {}


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
    req = rule_sweep_request()

    res = client.post("/api/backtest/sweep/jobs?target=remote", json=req)

    assert res.status_code == 422
    assert not route.called


@respx.mock
def test_submit_remote_non_json_maps_502(remote_env):
    respx.post(f"{REMOTE_URL}/api/backtest/sweep/jobs").mock(
        return_value=httpx.Response(200, text="<html>gateway</html>")
    )
    req = rule_sweep_request()

    res = client.post("/api/backtest/sweep/jobs?target=remote", json=req)

    assert res.status_code == 502
    assert "non-JSON" in res.json()["detail"]


@respx.mock
def test_submit_remote_connect_error_maps_502(remote_env):
    respx.post(f"{REMOTE_URL}/api/backtest/sweep/jobs").mock(
        side_effect=httpx.ConnectError("boom")
    )
    req = rule_sweep_request()

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
    req = rule_sweep_request()

    res = client.post("/api/backtest/sweep/jobs?target=remote", json=req)

    assert res.status_code == 502
    assert "unreachable" in res.json()["detail"]
