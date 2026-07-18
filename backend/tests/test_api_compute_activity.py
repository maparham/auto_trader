"""Activity endpoint: idleSeconds resets on real requests but not on activity
polls; activeJobs mirrors sweep_jobs.JOBS."""
import time

from fastapi.testclient import TestClient

from auto_trader.api import activity
from auto_trader.api.app import app


def test_activity_reports_idle_and_jobs(monkeypatch):
    client = TestClient(app)
    # A real request marks the host active.
    client.get("/api/compute/status")
    body = client.get("/api/compute/activity").json()
    assert body["activeJobs"] == 0
    assert body["idleSeconds"] < 1.0

    # Polling /api/compute/activity does NOT reset the idle clock.
    activity._last_request = time.monotonic() - 100.0
    body = client.get("/api/compute/activity").json()
    assert body["idleSeconds"] > 99.0


def test_activity_counts_running_jobs(monkeypatch):
    from auto_trader.api import sweep_jobs

    class _Job:
        running = True

    monkeypatch.setattr(sweep_jobs.JOBS, "_jobs", {"x": _Job()}, raising=False)
    client = TestClient(app)
    body = client.get("/api/compute/activity").json()
    assert body["activeJobs"] == 1
