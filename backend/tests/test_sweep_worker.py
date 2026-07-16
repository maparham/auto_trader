"""Worker-process combo runner: init-once state, per-combo rows, determinism."""
import pytest
from concurrent.futures import ProcessPoolExecutor

from auto_trader.api import sweep_worker
from auto_trader.strategy import loader

from test_api_backtest_coded import base_request, make_candles

STRAT = '''
meta = {"params": [{"name": "n", "type": "int", "default": 3, "min": 1, "max": 50}]}
def on_bar(ctx):
    if ctx.param("n") == 13:
        raise RuntimeError("unlucky combo")
    if ctx.position.is_flat and len(ctx.closes) >= ctx.param("n"):
        return [ctx.buy(sl=ctx.close * 0.99, reason="go")]
    return []
'''


@pytest.fixture(autouse=True)
def restore_strategies_dir(monkeypatch):
    """The inline (non-pool) tests call worker_init, which mutates the global
    loader.STRATEGIES_DIR in-process. Snapshot and restore it so a sweep-worker
    test can never leak a tmp_path into later tests (ordering landmine)."""
    monkeypatch.setattr(loader, "STRATEGIES_DIR", loader.STRATEGIES_DIR)


@pytest.fixture
def strat_dir(tmp_path):
    (tmp_path / "sweep.py").write_text(STRAT)
    return str(tmp_path)


def req_dict(candles):
    return {**base_request("sweep.py", candles), "sweep": {"combos": []}}


COMBOS = [{"param:n": 3}, {"param:n": 5}, {"param:n": 13}, {"param:n": 20}]


def rows_inline(candles, strat_dir):
    sweep_worker.worker_init(req_dict(candles), {}, strat_dir, None)
    return [sweep_worker.run_combo(c) for c in COMBOS]


def test_run_combo_rows_and_error_isolation(strat_dir):
    rows = rows_inline(make_candles(30), strat_dir)
    assert [r["combo"] for r in rows] == COMBOS
    assert rows[0]["error"] is None and rows[0]["metrics"]["n_trades"] > 0
    assert "unlucky" in rows[2]["error"] and rows[2]["metrics"] is None


def test_pool_matches_inline(strat_dir):
    candles = make_candles(30)
    inline = rows_inline(candles, strat_dir)
    with ProcessPoolExecutor(
        max_workers=2, initializer=sweep_worker.worker_init,
        initargs=(req_dict(candles), {}, strat_dir, None),
    ) as pool:
        pooled = list(pool.map(sweep_worker.run_combo, COMBOS))
    assert pooled == inline


def test_missing_htf_is_error_row_not_crash(strat_dir, tmp_path):
    (tmp_path / "mtf.py").write_text(
        'meta = {"params": []}\n'
        'def on_bar(ctx):\n'
        '    ctx.ema(5, tf="1h")\n'
        '    return []\n'
    )
    d = req_dict(make_candles(30))
    d["codedStrategy"] = "mtf.py"
    sweep_worker.worker_init(d, {}, str(tmp_path), None)
    row = sweep_worker.run_combo({})
    assert row["error"] is not None and "1h" in row["error"]
