"""GET /api/strategies (+ /source): discovery surface for the frontend picker."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import auto_trader.strategy.loader as loader
from auto_trader.api.app import app

client = TestClient(app)


@pytest.fixture
def setup_strategies(tmp_path, monkeypatch):
    (tmp_path / "alpha.py").write_text(
        '"""Alpha strat."""\nmeta = {"name": "Alpha"}\ndef on_bar(ctx):\n    return []\n'
    )
    (tmp_path / "broken.py").write_text("def on_bar(ctx:\n")
    monkeypatch.setattr(loader, "STRATEGIES_DIR", tmp_path)
    yield


def test_list(setup_strategies):
    res = client.get("/api/strategies")
    assert res.status_code == 200
    by_name = {s["filename"]: s for s in res.json()}
    assert by_name["alpha.py"]["name"] == "Alpha"
    assert by_name["alpha.py"]["description"] == "Alpha strat."
    assert by_name["alpha.py"]["hedged"] is False
    assert by_name["alpha.py"]["error"] is None
    assert by_name["broken.py"]["error"]  # broken file listed with its error


def test_source(setup_strategies):
    res = client.get("/api/strategies/alpha.py/source")
    assert res.status_code == 200
    body = res.json()
    assert body["filename"] == "alpha.py"
    assert "def on_bar" in body["source"]


def test_source_unknown_404(setup_strategies):
    assert client.get("/api/strategies/nope.py/source").status_code == 404
    assert client.get("/api/strategies/..%2Fevil.py/source").status_code == 404
