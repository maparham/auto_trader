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


PARAMS_STRAT = '''
meta = {"name": "P", "params": [
    {"name": "ema_fast", "type": "int", "default": 9, "min": 2, "max": 50},
]}
def on_bar(ctx):
    return []
'''

BAD_PARAMS_STRAT = '''
meta = {"name": "BP", "params": [{"name": "x", "type": "int"}]}
def on_bar(ctx):
    return []
'''


def test_strategies_list_includes_params(tmp_path, monkeypatch):
    (tmp_path / "p.py").write_text(PARAMS_STRAT)
    monkeypatch.setattr(loader, "STRATEGIES_DIR", tmp_path)
    body = client.get("/api/strategies").json()
    p = next(s for s in body if s["filename"] == "p.py")
    assert p["params"] == [{
        "name": "ema_fast", "label": "ema_fast", "type": "int", "default": 9,
        "min": 2, "max": 50, "step": None, "options": None, "help": None,
    }]


def test_bad_params_schema_is_a_load_error(tmp_path, monkeypatch):
    (tmp_path / "bp.py").write_text(BAD_PARAMS_STRAT)
    monkeypatch.setattr(loader, "STRATEGIES_DIR", tmp_path)
    body = client.get("/api/strategies").json()
    bp = next(s for s in body if s["filename"] == "bp.py")
    assert bp["error"] and "default" in bp["error"]
    assert bp["params"] == []
