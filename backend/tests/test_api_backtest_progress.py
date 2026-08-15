"""progressId plumbing on POST /api/backtest and the progress GET route.

Direct-call convention per test_api_candles.py (no pytest-asyncio): the handler
coroutines are awaited via asyncio.run so the registry can be spied on in-process.
The request/strategy fixtures mirror test_api_backtest_coded.py.
"""

from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException

import auto_trader.strategy.loader as loader
from auto_trader.api.routers import backtest as bt
from auto_trader.api.schemas import BacktestRequest
from auto_trader.core import progress as pr

STRAT = '''"""Test strat."""
def on_bar(ctx):
    if ctx.position.is_flat and len(ctx.closes) % 10 == 0:
        return [ctx.buy(sl=ctx.close * 0.9, tp=ctx.close * 1.2, reason="in")]
    if ctx.position.is_long and ctx.bars_since_entry >= 3:
        return [ctx.close_long(reason="out")]
    return []
'''


def make_candles(n=60):
    t0 = 1_700_000_000
    out = []
    px = 100.0
    for i in range(n):
        px += 0.5 if i % 3 else -0.5
        out.append({
            "time": t0 + i * 3600, "open": px, "high": px + 1,
            "low": px - 1, "close": px + 0.3, "volume": 10,
        })
    return out


def base_request(strategy: str, candles, **extra) -> BacktestRequest:
    return BacktestRequest(**{
        "epic": "TEST", "resolution": "HOUR", "candles": candles, "series": {},
        "costs": {"quantity": 1, "commissionPerSide": 0,
                  "slippage": {"kind": "fixed", "value": 0}, "startingCash": 10000},
        "tradeFromTime": candles[0]["time"],
        "codedStrategy": strategy,
        **extra,
    })


@pytest.fixture(autouse=True)
def _drop_stray_entries():
    """Cleanup insurance for ids these tests register. Teardown, NOT an in-test
    finally: it must run AFTER the assertions so the handler's own
    `finally: clear_progress(...)` is what the clear-on-finish assertion tests."""
    yield
    for pid in ("live", "gone", "prog-test"):
        pr.clear_progress(pid)


@pytest.fixture
def strategies(tmp_path, monkeypatch):
    (tmp_path / "test.py").write_text(STRAT)
    monkeypatch.setattr(loader, "STRATEGIES_DIR", tmp_path)
    yield


def test_progress_route_reads_registry_and_404s_when_absent():
    pr.set_progress("live", stage="simulate", done=42, total=100)
    try:
        out = asyncio.run(bt.backtest_progress("live"))
    finally:
        pr.clear_progress("live")
    assert out == {"stage": "simulate", "done": 42, "total": 100}

    with pytest.raises(HTTPException) as e:
        asyncio.run(bt.backtest_progress("gone"))
    assert e.value.status_code == 404


def test_backtest_run_with_progress_id_updates_then_clears(strategies, monkeypatch):
    req = base_request("test.py", make_candles(), progressId="prog-test")
    snapshots: list[dict] = []

    real_update = pr.update_progress

    def spying_update(pid, done, total, now=None):
        real_update(pid, done, total, now=now)
        snapshots.append(pr.get_progress(pid))

    monkeypatch.setattr(pr, "update_progress", spying_update)
    asyncio.run(bt.backtest(req))
    assert snapshots, "engine progress never reached the registry"
    assert all(s["stage"] == "simulate" for s in snapshots)
    dones = [s["done"] for s in snapshots]
    assert dones == sorted(dones), "progress must advance monotonically"
    assert snapshots[-1]["done"] == snapshots[-1]["total"] > 0
    assert pr.get_progress("prog-test") is None  # cleared in finally


def test_backtest_resets_stage_before_exit_time_resolution(strategies, monkeypatch):
    """The exit-time minute fetch can trigger a long candle backfill; the entry
    must be reset (total=0) first so the frontend poller falls through to the
    backfill row instead of showing a frozen 'Simulating (100%)'."""
    req = base_request("test.py", make_candles(), progressId="prog-test")
    seen: list[dict | None] = []

    async def spying_attach(trades, *, run_tf_seconds, load_minutes):
        seen.append(pr.get_progress("prog-test"))

    monkeypatch.setattr(bt, "attach_exit_times", spying_attach)
    asyncio.run(bt.backtest(req))
    assert seen == [{"stage": "exit-times", "done": 0, "total": 0}]


def test_multi_pass_stages_never_rewind_the_wire_fraction(strategies, monkeypatch):
    """cost-sensitivity and baselines each run several engine passes under one
    stage label. If every pass restarts its counter at 0, the UI bar visibly
    rewinds under an unchanged label — so the wire payload must aggregate the
    passes: within a stage, done/total may never decrease."""
    req = base_request(
        "test.py", make_candles(), progressId="prog-test",
        costs={"quantity": 1, "commissionPerSide": 1,
               "slippage": {"kind": "fixed", "value": 0}, "startingCash": 10000},
        baselines=["null", "hold", "reversed"], costSensitivity=True,
    )
    snapshots: list[dict] = []
    real_update = pr.update_progress

    def spying_update(pid, done, total, now=None):
        real_update(pid, done, total, now=now)
        snapshots.append(pr.get_progress(pid))

    monkeypatch.setattr(pr, "update_progress", spying_update)
    asyncio.run(bt.backtest(req))

    stages = {s["stage"] for s in snapshots}
    assert {"cost-sensitivity", "baselines"} <= stages, stages
    for stage in stages:
        fracs = [s["done"] / s["total"]
                 for s in snapshots if s["stage"] == stage and s["total"]]
        assert fracs == sorted(fracs), f"{stage} fraction rewound: {fracs}"
        assert fracs and fracs[-1] == 1.0, f"{stage} never reached 100%: {fracs[-3:]}"


def test_backtest_without_progress_id_touches_no_registry(strategies, monkeypatch):
    """Zero behavior change when the client ships no id: nothing is registered."""
    calls: list[tuple] = []
    monkeypatch.setattr(pr, "set_progress",
                        lambda *a, **k: calls.append((a, k)))
    asyncio.run(bt.backtest(base_request("test.py", make_candles())))
    assert calls == []
