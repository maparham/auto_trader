"""MT5 deploy-lifecycle endpoints: unconfigured mapping, pass-through to the
broker's deploy_state/pause/resume, and 502 on MetaApi errors."""
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from fastapi.testclient import TestClient

from auto_trader.api.app import app

client = TestClient(app)

_GET_DATA = "auto_trader.api.routers.mt5.deps.get_data"


def _broker(**async_returns) -> AsyncMock:
    b = AsyncMock()
    for name, value in async_returns.items():
        getattr(b, name).return_value = value
    return b


def test_unconfigured_when_registry_has_no_mt5():
    with patch(_GET_DATA, side_effect=HTTPException(404, "unknown broker: mt5")):
        body = client.get("/api/mt5/deploy-state").json()
    assert body == {"state": "unconfigured", "detail": None}


def test_deploy_state_passthrough():
    broker = _broker(deploy_state="on")
    with patch(_GET_DATA, return_value=broker):
        assert client.get("/api/mt5/deploy-state").json() == {"state": "on", "detail": None}


def test_deploy_calls_resume():
    broker = _broker(resume="turning-on")
    with patch(_GET_DATA, return_value=broker):
        body = client.post("/api/mt5/deploy").json()
    broker.resume.assert_awaited_once()
    assert body["state"] == "turning-on"


def test_undeploy_calls_pause():
    broker = _broker(pause="turning-off")
    with patch(_GET_DATA, return_value=broker):
        body = client.post("/api/mt5/undeploy").json()
    broker.pause.assert_awaited_once()
    assert body["state"] == "turning-off"


def test_metaapi_error_is_502():
    broker = AsyncMock()
    broker.deploy_state.side_effect = RuntimeError("boom")
    with patch(_GET_DATA, return_value=broker):
        res = client.get("/api/mt5/deploy-state")
    assert res.status_code == 502
    assert "boom" in res.json()["detail"]
