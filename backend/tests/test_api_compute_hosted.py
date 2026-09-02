"""Hosted mode must not expose the operator's private remote-compute host:
forward() carries COMPUTE_HOST_TOKEN and no per-user identity, so any
signed-in user could reach the operator's box and other users' remote jobs."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from auto_trader.api.app import app
from tests import clerk_fake


@pytest.fixture()
def hosted_client(monkeypatch):
    clerk_fake.install(monkeypatch)
    # A configured host must STILL be refused in hosted mode.
    monkeypatch.setenv("COMPUTE_HOST_URL", "https://compute.example")
    monkeypatch.setenv("COMPUTE_HOST_TOKEN", "sekret")
    with TestClient(app) as client:
        yield client


def _auth() -> dict:
    return {"Authorization": f"Bearer {clerk_fake.make_token(sub='user_a')}"}


def test_forward_routes_403_in_hosted_mode(hosted_client):
    # The job-status GET forwards without request-body validation, so the
    # response code isolates forward()'s own behavior. In dev mode this same
    # call would be 502 (unreachable host), never 403/404.
    r = hosted_client.get(
        "/api/backtest/sweep/jobs/any-id?target=remote", headers=_auth()
    )
    assert r.status_code == 403
    assert "hosted" in r.json()["detail"]


def test_compute_status_reports_unconfigured_in_hosted_mode(hosted_client):
    r = hosted_client.get("/api/compute/status", headers=_auth())
    assert r.status_code == 200
    assert r.json() == {"remoteConfigured": False}


def test_compute_status_still_reads_config_in_dev_mode(monkeypatch):
    monkeypatch.delenv("CLERK_JWKS_URL", raising=False)
    monkeypatch.setenv("COMPUTE_HOST_URL", "https://compute.example")
    monkeypatch.setenv("COMPUTE_HOST_TOKEN", "sekret")
    with TestClient(app) as client:
        r = client.get("/api/compute/status")
    assert r.json() == {"remoteConfigured": True}
