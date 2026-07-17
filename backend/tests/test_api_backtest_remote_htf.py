"""Remote sweeps ship higher-timeframe bars from the local cache; the remote
compute host runs on those shipped bars and NEVER fetches from a broker.

Three guarantees:
- the local proxy fills req.htfCandles from its cache before forwarding,
- a COMPUTE_ONLY host uses shipped bars and makes zero broker calls,
- a COMPUTE_ONLY host with a bar NOT shipped fails loudly (503) instead of
  silently reaching the live API.
"""

import asyncio
import json as _json
from datetime import datetime, timezone

import httpx
import pytest
import respx
from fastapi import HTTPException
from fastapi.testclient import TestClient

import auto_trader.strategy.loader as loader
from auto_trader.api import deps
from auto_trader.api.app import app
from auto_trader.brokers.base import MarketDataBroker
from auto_trader.brokers.registry import BrokerRegistry
from auto_trader.core.models import Candle

from test_api_backtest_sweep import run_sweep_via_jobs

client = TestClient(app)

REMOTE_URL = "https://x.fly.dev"
REMOTE_TOKEN = "secret-token"

_T0 = 1_700_000_000  # ~2023-11-14T22:13:20Z


@pytest.fixture
def remote_env(monkeypatch):
    monkeypatch.setenv("COMPUTE_HOST_URL", REMOTE_URL)
    monkeypatch.setenv("COMPUTE_HOST_TOKEN", REMOTE_TOKEN)
    yield


def _base_candles(n=30) -> list[dict]:
    out, px = [], 10.0
    for i in range(n):
        px += 0.1
        out.append({"time": _T0 + i * 3600, "open": px, "high": px + 1,
                    "low": px - 1, "close": px + 0.3, "volume": 1.0})
    return out


def _htf_dtos(n=40) -> list[dict]:
    """HOUR_4 bars (as request JSON) covering the base window with warmup room."""
    t0 = _T0 - 20 * 4 * 3600  # 20 bars of warmup before the base window
    out, px = [], 9.0
    for i in range(n):
        px += 0.3
        out.append({"time": t0 + i * 4 * 3600, "open": px, "high": px + 1,
                    "low": px - 1, "close": px, "volume": 1.0})
    return out


def _htf_candles(n=40) -> list[Candle]:
    return [
        Candle(time=datetime.fromtimestamp(c["time"], tz=timezone.utc),
               open=c["open"], high=c["high"], low=c["low"],
               close=c["close"], volume=c["volume"])
        for c in _htf_dtos(n)
    ]


def _htf_rule_sweep() -> dict:
    """Rule sweep whose entry references an HOUR_4 EMA — so the run needs an HTF
    bar set (base timeframe is HOUR)."""
    empty = {"combine": "AND", "rules": []}
    return {
        "epic": "EURUSD", "resolution": "HOUR", "candles": _base_candles(), "series": {},
        "longEntry": {"combine": "AND", "rules": [
            {"left": {"kind": "indicator", "indicator": "EMA", "length": 3,
                      "timeframe": "HOUR_4"},
             "op": "gt", "right": {"kind": "const", "value": 0.0}}]},
        "longExit": {"combine": "AND", "rules": [
            {"left": {"kind": "price", "field": "close"}, "op": "lt",
             "right": {"kind": "const", "value": 0}, "count": 1}]},
        "shortEntry": empty, "shortExit": empty,
        "costs": {"quantity": 1, "commissionPerSide": 0,
                  "slippage": {"kind": "fixed", "value": 0}, "startingCash": 1000},
        "tradeFromTime": _T0,
        "sweep": {"combos": [{"rule:long.entry.0.left.length": 3},
                             {"rule:long.entry.0.left.length": 5}]},
    }


@respx.mock
def test_remote_proxy_ships_htf_from_cache(remote_env, monkeypatch):
    """The local proxy fetches the HTF set (through its cache) and puts it in the
    forwarded request, so the remote gets the bars and never fetches them itself."""
    calls = {"n": 0}

    async def fake_fetch(broker_id, epic, resolution, bars, from_ts, to_ts, price_side):
        calls["n"] += 1
        assert resolution == "HOUR_4"
        return _htf_candles()

    monkeypatch.setattr(deps, "_fetch_symbol_candles", fake_fetch)
    route = respx.post(f"{REMOTE_URL}/api/backtest/sweep/jobs").mock(
        return_value=httpx.Response(200, json={"jobId": "r1", "total": 2})
    )

    res = client.post("/api/backtest/sweep/jobs?target=remote", json=_htf_rule_sweep())

    assert res.status_code == 200
    assert calls["n"] == 1  # HTF fetched ONCE, locally, before forwarding
    body = _json.loads(route.calls.last.request.content)
    shipped = body["htfCandles"]["HOUR_4"]
    assert len(shipped) == len(_htf_dtos())
    assert shipped[0]["time"] == _htf_dtos()[0]["time"]


def test_compute_host_uses_shipped_htf_without_fetching(monkeypatch):
    """On a COMPUTE_ONLY host, a sweep carrying htfCandles runs to completion and
    never calls the broker-fetch path."""
    monkeypatch.setenv("COMPUTE_ONLY", "1")

    async def _boom(*a, **k):
        raise AssertionError("compute host must not fetch bars — they were shipped")

    monkeypatch.setattr(deps, "_fetch_symbol_candles", _boom)

    req = _htf_rule_sweep()
    req["htfCandles"] = {"HOUR_4": _htf_dtos()}
    rows = run_sweep_via_jobs(client, req)  # target=local == the remote host running the job
    assert len(rows) == 2


_CODED_TF_STRAT = '''
meta = {"params": [{"name": "n", "type": "int", "default": 3, "min": 1, "max": 50}]}
def on_bar(ctx):
    if ctx.ema(ctx.param("n"), tf="HOUR_4") is None:
        return []
    if ctx.position.is_flat and len(ctx.closes) % 10 == 0:
        return [ctx.buy(reason="go")]
    return []
'''


@pytest.fixture
def coded_strategies(tmp_path, monkeypatch):
    (tmp_path / "tf_strat.py").write_text(_CODED_TF_STRAT)
    monkeypatch.setattr(loader, "STRATEGIES_DIR", tmp_path)
    yield


@respx.mock
def test_remote_proxy_ships_coded_discovered_htf(remote_env, coded_strategies, monkeypatch):
    """Coded strategies discover timeframes at runtime, so the proxy runs combos[0]
    as a local discovery probe: its tf= call pulls HOUR_4 from the cache, which is
    then shipped in the forwarded request."""
    calls = {"n": 0}

    async def fake_fetch(broker_id, epic, resolution, bars, from_ts, to_ts, price_side):
        calls["n"] += 1
        assert resolution == "HOUR_4"
        return _htf_candles()

    monkeypatch.setattr(deps, "_fetch_symbol_candles", fake_fetch)
    route = respx.post(f"{REMOTE_URL}/api/backtest/sweep/jobs").mock(
        return_value=httpx.Response(200, json={"jobId": "r1", "total": 2})
    )

    empty = {"combine": "AND", "rules": []}
    req = {
        "epic": "EURUSD", "resolution": "HOUR", "candles": _base_candles(), "series": {},
        "longEntry": empty, "longExit": empty, "shortEntry": empty, "shortExit": empty,
        "costs": {"quantity": 1, "commissionPerSide": 0,
                  "slippage": {"kind": "fixed", "value": 0}, "startingCash": 1000},
        "tradeFromTime": _T0,
        "codedStrategy": "tf_strat.py",
        "sweep": {"combos": [{"param:n": 3}, {"param:n": 5}]},
    }

    res = client.post("/api/backtest/sweep/jobs?target=remote", json=req)

    assert res.status_code == 200, res.text
    assert calls["n"] >= 1  # probe discovered + fetched HOUR_4 locally
    body = _json.loads(route.calls.last.request.content)
    assert body["htfCandles"]["HOUR_4"]  # shipped for the remote


class _RefusingBroker(MarketDataBroker):
    """Data broker that records if it was ever asked for bars (it must not be)."""
    def __init__(self) -> None:
        self.fetched = False

    async def get_candles(self, *a, **k):  # type: ignore[override]
        self.fetched = True
        return []

    async def get_recent_candles(self, *a, **k):  # type: ignore[override]
        self.fetched = True
        return []

    async def get_quote(self, epic: str):  # type: ignore[override]
        return (None, None)


def test_compute_host_refuses_broker_fetch_when_bars_missing(monkeypatch):
    """The negative case that actually proves the invariant: a COMPUTE_ONLY host
    asked for a bar it was NOT shipped raises 503 at the fetch boundary instead of
    calling the broker."""
    monkeypatch.setenv("COMPUTE_ONLY", "1")
    broker = _RefusingBroker()
    reg = BrokerRegistry()
    reg.add_data("capital-live", broker)
    monkeypatch.setattr(deps, "_registry", reg)

    async def scenario():
        with pytest.raises(HTTPException) as e:
            await deps._fetch_symbol_candles(
                "capital-live", "GUARDONLY_UNIQUE", "HOUR_4", 100,
                _T0, _T0 + 100 * 4 * 3600, "mid",
            )
        assert e.value.status_code == 503
        assert "must not" in e.value.detail
        assert not broker.fetched  # the broker was never reached

    asyncio.run(scenario())
