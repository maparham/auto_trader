"""REQUIRE_API_TOKEN + COMPUTE_ONLY guards."""
from fastapi.testclient import TestClient
from auto_trader.api.app import app

client = TestClient(app)


def test_no_flags_no_gate(monkeypatch):
    monkeypatch.delenv("REQUIRE_API_TOKEN", raising=False)
    assert client.get("/api/backtest/sweep/jobs").status_code == 200


def test_token_required_401_and_pass(monkeypatch):
    monkeypatch.setenv("REQUIRE_API_TOKEN", "1")
    monkeypatch.setenv("API_TOKEN", "s3cret")
    assert client.get("/api/backtest/sweep/jobs").status_code == 401
    ok = client.get("/api/backtest/sweep/jobs", headers={"Authorization": "Bearer s3cret"})
    assert ok.status_code == 200


def test_compute_only_blocks_dealing(monkeypatch):
    monkeypatch.setenv("COMPUTE_ONLY", "1")
    r = client.post("/api/orders", json={})
    assert r.status_code == 403 and "dealing disabled" in r.text
    assert client.get("/api/backtest/sweep/jobs").status_code == 200


def test_compute_only_rejects_before_validation(monkeypatch):
    """A dealing request is blocked (403) before body parsing, so a garbage
    body never reaches validation (which would 422)."""
    monkeypatch.setenv("COMPUTE_ONLY", "1")
    r = client.post("/api/orders", content=b"not json at all", headers={"Content-Type": "application/json"})
    assert r.status_code == 403
    assert "dealing disabled" in r.text


def test_token_required_empty_token_fails_closed(monkeypatch):
    """When REQUIRE_API_TOKEN=1 but API_TOKEN is empty/unset, all requests
    return 401 (fail closed). Even a header of 'Bearer ' should not pass."""
    monkeypatch.setenv("REQUIRE_API_TOKEN", "1")
    monkeypatch.delenv("API_TOKEN", raising=False)
    # Request without Authorization header
    assert client.get("/api/backtest/sweep/jobs").status_code == 401
    # Request with just "Bearer " (empty token)
    assert client.get("/api/backtest/sweep/jobs", headers={"Authorization": "Bearer "}).status_code == 401


def test_token_required_unset_token_fails_closed(monkeypatch):
    """When REQUIRE_API_TOKEN=1 and API_TOKEN is explicitly set to empty string."""
    monkeypatch.setenv("REQUIRE_API_TOKEN", "1")
    monkeypatch.setenv("API_TOKEN", "")
    # Both with and without the header should return 401
    assert client.get("/api/backtest/sweep/jobs").status_code == 401
    assert client.get("/api/backtest/sweep/jobs", headers={"Authorization": "Bearer "}).status_code == 401


def test_token_required_non_ascii_header(monkeypatch):
    """Non-ASCII characters in Authorization header should return 401, not 500.

    TestClient's httpx backend encodes headers as ASCII, so we test by passing
    bytes directly (latin-1 encoded).
    """
    monkeypatch.setenv("REQUIRE_API_TOKEN", "1")
    monkeypatch.setenv("API_TOKEN", "s3cret")
    # Header with non-ASCII character (latin-1 encodable) passed as bytes
    r = client.get(
        "/api/backtest/sweep/jobs",
        headers={"Authorization": b"Bearer caf\xe9"},
    )
    assert r.status_code == 401
    assert "detail" in r.json()
