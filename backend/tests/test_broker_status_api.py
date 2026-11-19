"""GET /api/brokers/status: the broker menu's connection dots."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from auto_trader.api import deps
from auto_trader.api.app import app
from auto_trader.api.routers import markets
from auto_trader.brokers.registry import BrokerRegistry
from auto_trader.core.broker_health import BrokerHealth


class _Pinged:
    broker_id = ""

    def __init__(self, fail: bool = False) -> None:
        self.fail = fail
        self.pings = 0

    async def ping(self) -> None:
        self.pings += 1
        if self.fail:
            raise RuntimeError("login refused")


class _NoPing:
    broker_id = ""


@pytest.fixture()
def setup(monkeypatch):
    brokers = {"yfinance": _Pinged(), "capital": _Pinged(fail=True), "noping": _NoPing()}
    registry = BrokerRegistry()
    for bid, broker in brokers.items():
        registry.add_data(bid, broker)
    with TestClient(app) as client:
        monkeypatch.setattr(deps, "_registry", registry)
        monkeypatch.setattr(deps, "BROKER_HEALTH", BrokerHealth())
        monkeypatch.setattr(markets, "_status_pings", {})
        yield client, brokers


def test_without_probe_nothing_is_called(setup):
    client, brokers = setup
    body = client.get("/api/brokers/status").json()["brokers"]
    assert {b["state"] for b in body.values()} == {"unknown"}
    assert brokers["yfinance"].pings == 0


def test_probe_tests_stale_brokers_only(setup):
    client, brokers = setup
    body = client.get("/api/brokers/status?probe=1").json()["brokers"]
    assert body["yfinance"]["state"] == "ok"
    assert body["capital"]["state"] == "down"
    assert "login refused" in body["capital"]["reason"]
    # No ping method: never tested, stays unknown.
    assert body["noping"]["state"] == "unknown"

    # A fresh success is not tested again; a failed one is.
    client.get("/api/brokers/status?probe=1")
    assert brokers["yfinance"].pings == 1
    assert brokers["capital"].pings == 2


def test_probe_skips_an_open_breaker(setup):
    client, brokers = setup
    client.get("/api/brokers/status?probe=1")
    client.get("/api/brokers/status?probe=1")  # second failure opens it
    assert deps.BROKER_HEALTH.is_open("capital")
    body = client.get("/api/brokers/status?probe=1").json()["brokers"]
    assert brokers["capital"].pings == 2
    assert body["capital"]["state"] == "down"
