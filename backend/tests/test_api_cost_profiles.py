"""GET prefill, PUT manual wins, refetch reports old vs new."""
import pytest
from fastapi.testclient import TestClient

from auto_trader.api.app import app


class StubBroker:
    async def get_market_detail(self, epic):
        return {
            "snapshot": {"bid": 100.0, "offer": 100.8},
            "instrument": {"overnightFee": {
                "longRate": -0.0026, "shortRate": 0.001,
                "swapChargeTimestamp": 1784241600000,
            }},
        }


@pytest.fixture
def client(monkeypatch, tmp_path):
    from auto_trader.core import cost_profiles
    fresh = cost_profiles.CostProfileStore(str(tmp_path / "c.db"))
    monkeypatch.setattr(cost_profiles, "COST_PROFILES", fresh)
    from auto_trader.api.routers import costs as costs_router
    monkeypatch.setattr(costs_router, "COST_PROFILES", fresh)
    monkeypatch.setattr(costs_router, "get_data", lambda broker_id: StubBroker())
    return TestClient(app)


def test_get_prefills_from_broker(client):
    r = client.get("/api/costs/US100?broker=capital")
    body = r.json()
    assert r.status_code == 200
    assert body["spread"] == pytest.approx(0.8)
    # Fees are user-entered, not prefetched: prefill leaves financing at 0.0.
    assert body["finLongDailyPct"] == 0.0
    assert body["finShortDailyPct"] == 0.0
    assert body["source"] == "broker"


def test_put_manual_wins_over_next_get(client):
    client.get("/api/costs/US100?broker=capital")
    client.put("/api/costs/US100", json={"spread": 2.5})
    r = client.get("/api/costs/US100?broker=capital")
    assert r.json()["spread"] == 2.5
    assert r.json()["source"] == "manual"


def test_refetch_reports_old_and_new(client):
    client.put("/api/costs/US100", json={"spread": 9.9})
    r = client.post("/api/costs/US100/refetch?broker=capital")
    assert r.json()["old"]["spread"] == 9.9
    assert r.json()["new"]["spread"] == pytest.approx(0.8)


def test_zero_spread_quote_is_not_persisted(client, monkeypatch):
    # A closed-market/stale snapshot (no usable quote) must not be stored as an
    # authoritative source:"broker" profile with spread 0.
    class DeadQuoteBroker:
        async def get_market_detail(self, epic):
            return {"snapshot": {"bid": None, "offer": None}, "instrument": {}}

    from auto_trader.api.routers import costs as costs_router
    monkeypatch.setattr(costs_router, "get_data", lambda broker_id: DeadQuoteBroker())

    r = client.get("/api/costs/US100?broker=capital")
    assert r.json()["spread"] == 0.0
    assert r.json()["source"] == "manual"  # zeroed fallback, not "broker"

    # Nothing persisted: once the quote comes back, GET prefills for real.
    monkeypatch.setattr(costs_router, "get_data", lambda broker_id: StubBroker())
    r = client.get("/api/costs/US100?broker=capital")
    assert r.json()["spread"] == pytest.approx(0.8)
    assert r.json()["source"] == "broker"
