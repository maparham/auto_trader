"""Admin history-download endpoints on /api/candle-cache/backfill: gating,
resolution mapping, IG refusal, duplicate rejection, cancel."""

from __future__ import annotations

import asyncio
import time
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from auto_trader.api import auth, deps, history_jobs
from auto_trader.api.app import app
from auto_trader.api.history_jobs import HistoryJobManager
from auto_trader.brokers.ig import IGBroker
from auto_trader.brokers.registry import BrokerRegistry
from auto_trader.core.candle_cache import CandleCache
from auto_trader.core.models import Candle
from tests import clerk_fake


def _c(ts: int, close: float = 1.0) -> Candle:
    return Candle(
        time=datetime.fromtimestamp(ts, tz=timezone.utc),
        open=close, high=close, low=close, close=close, volume=0.0,
    )


class _FakeBroker:
    """Data broker with bars at `have_ts`; optional per-call delay so a job
    stays observably running across a couple of HTTP requests."""

    broker_id = "capital"
    display_name = None

    def __init__(self, have_ts=(), delay_s: float = 0.0):
        self._have = sorted(have_ts)
        self._delay = delay_s

    async def get_candles(self, epic, resolution, start, end, price_side="mid"):
        if self._delay:
            await asyncio.sleep(self._delay)
        s, e = int(start.timestamp()), int(end.timestamp())
        return [_c(t) for t in self._have if s <= t <= e]

    async def get_recent_candles(self, epic, resolution, n, price_side="mid"):
        if self._delay:
            await asyncio.sleep(self._delay)
        return [_c(t) for t in self._have[-n:]]


def _registry_with(brokers: dict) -> BrokerRegistry:
    r = BrokerRegistry()
    for bid, b in brokers.items():
        r.add_data(bid, b)
    return r


@pytest.fixture()
def cache(tmp_path) -> CandleCache:
    return CandleCache(str(tmp_path / "c.db"))


@pytest.fixture()
def client(monkeypatch, cache):
    clerk_fake.install(monkeypatch)
    monkeypatch.setenv(auth.ADMIN_USER_IDS_ENV, "user_admin")
    class _FakeIG(IGBroker):  # isinstance-only stand-in
        def __init__(self):
            pass

        async def aclose(self):
            pass

    fake_ig = _FakeIG()
    with TestClient(app) as c:
        monkeypatch.setattr(
            deps, "_registry",
            _registry_with({
                "capital": _FakeBroker(have_ts=list(range(100, 1060, 60))),
                "ig": fake_ig,
            }),
        )
        monkeypatch.setattr(history_jobs, "MANAGER", HistoryJobManager(cache))
        yield c


@pytest.fixture()
def admin_headers() -> dict:
    return {"Authorization": f"Bearer {clerk_fake.make_token(sub='user_admin')}"}


@pytest.fixture()
def user_headers() -> dict:
    return {"Authorization": f"Bearer {clerk_fake.make_token(sub='user_pleb')}"}


def _post(client, headers, **over):
    body = {"epic": "EURUSD", "resolution": "MINUTE_5", "years": 10, **over}
    return client.post("/api/candle-cache/backfill?broker=capital", json=body, headers=headers)


def _poll_done(client, headers, timeout_s=5.0) -> dict:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        jobs = client.get("/api/candle-cache/backfill/jobs", headers=headers).json()
        if jobs and jobs[0]["status"] != "running":
            return jobs[0]
        time.sleep(0.02)
    pytest.fail("job never left running")


def test_post_requires_admin(client, user_headers):
    assert _post(client, user_headers).status_code == 403


def test_jobs_list_requires_admin(client, user_headers):
    r = client.get("/api/candle-cache/backfill/jobs", headers=user_headers)
    assert r.status_code == 403


def test_seconds_resolution_refused(client, admin_headers):
    r = _post(client, admin_headers, resolution="S10")
    assert r.status_code == 422


def test_ig_refused(client, admin_headers):
    r = client.post(
        "/api/candle-cache/backfill?broker=ig",
        json={"epic": "EURUSD", "resolution": "MINUTE_5", "years": 10},
        headers=admin_headers,
    )
    assert r.status_code == 422
    assert "allowance" in r.json()["detail"]


def test_download_runs_and_warms_cache(client, admin_headers, cache):
    # Warm block so the walk has an anchor; the fake broker has bars to ts=100.
    cache._store_closed(
        ("capital", "EURUSD", "MINUTE_5", "mid"), [_c(1000)], cutoff_ts=10 ** 12
    )
    r = _post(client, admin_headers, years=None)  # None = all available history
    assert r.status_code == 200
    assert r.json()["status"] == "running"
    job = _poll_done(client, admin_headers)
    assert job["status"] == "done"
    assert job["resolution"] == "MINUTE_5"
    assert cache._coverage(("capital", "EURUSD", "MINUTE_5", "mid"))[0] == 100


def test_derived_resolution_maps_to_base(client, admin_headers, cache):
    cache._store_closed(
        ("capital", "EURUSD", "DAY", "mid"), [_c(1000)], cutoff_ts=10 ** 12
    )
    r = _post(client, admin_headers, resolution="MONTH", years=None)
    assert r.status_code == 200
    assert r.json()["resolution"] == "DAY"


def test_duplicate_post_conflicts(client, admin_headers, cache, monkeypatch):
    monkeypatch.setitem(
        deps._registry.data, "capital",
        _FakeBroker(have_ts=list(range(100, 1060, 60)), delay_s=0.3),
    )
    cache._store_closed(
        ("capital", "EURUSD", "MINUTE_5", "mid"), [_c(1000)], cutoff_ts=10 ** 12
    )
    assert _post(client, admin_headers).status_code == 200
    assert _post(client, admin_headers).status_code == 409
    _poll_done(client, admin_headers)


def test_delete_cancels_running_job(client, admin_headers, cache, monkeypatch):
    monkeypatch.setitem(
        deps._registry.data, "capital",
        _FakeBroker(have_ts=list(range(100, 1060, 60)), delay_s=0.3),
    )
    cache._store_closed(
        ("capital", "EURUSD", "MINUTE_5", "mid"), [_c(1000)], cutoff_ts=10 ** 12
    )
    assert _post(client, admin_headers, years=None).status_code == 200
    r = client.delete(
        "/api/candle-cache/backfill?broker=capital&epic=EURUSD&resolution=MINUTE_5",
        headers=admin_headers,
    )
    assert r.status_code == 200
    assert _poll_done(client, admin_headers)["status"] == "cancelled"


def test_delete_without_running_job_404s(client, admin_headers):
    r = client.delete(
        "/api/candle-cache/backfill?broker=capital&epic=EURUSD&resolution=MINUTE_5",
        headers=admin_headers,
    )
    assert r.status_code == 404
