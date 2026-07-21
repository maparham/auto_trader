"""POST /api/backtest/sweep/jobs: the period / timeWindow environment sweep
dimensions (spec 2026-07-14), run in coded mode (env combos are mode-agnostic:
they patch the request's candle window / trade mask before the strategy runs)."""

import pytest
from fastapi.testclient import TestClient

import auto_trader.strategy.loader as loader
from auto_trader.api.app import app

from test_api_backtest_sweep import run_sweep_via_jobs

client = TestClient(app)

T0 = 19676 * 86400  # a UTC midnight, hourly bars land on clean day boundaries


def make_ramp_candles(n=80, split=40, base=100.0):
    """Flat at `base` for `split` bars, then +1 per bar."""
    out = []
    for i in range(n):
        px = base + max(0, i - split + 1)
        out.append({"time": T0 + i * 3600, "open": px, "high": px + 1,
                    "low": px - 1, "close": px, "volume": 100})
    return out


def rule_request(candles, combos, entry_op="gt", entry_value=100.0, exit_rules=None):
    empty = {"combine": "AND", "rules": []}
    return {
        "epic": "TEST", "resolution": "HOUR", "candles": candles, "series": {},
        "longEntry": {"combine": "AND", "rules": [{
            "left": {"kind": "price", "field": "close"},
            "op": entry_op,
            "right": {"kind": "const", "value": entry_value},
        }]},
        "longExit": {"combine": "AND", "rules": exit_rules} if exit_rules else empty,
        "shortEntry": empty, "shortExit": empty,
        "costs": {"quantity": 1, "commissionPerSide": 0, "slippage": {"kind": "fixed", "value": 0}, "startingCash": 10000},
        "tradeFromTime": candles[0]["time"],
        "sweep": {"combos": combos},
    }


def post_rows(req):
    return run_sweep_via_jobs(client, req)


ALWAYS_BUY = '''
def on_bar(ctx):
    if ctx.position.is_flat:
        return [ctx.buy(reason="go")]
    return []
'''

# Buy when flat, close when long: cycles a trade every bar it is allowed to
# enter, so a narrower trade window yields fewer entries (window-gating proof).
BUY_CYCLE = '''
def on_bar(ctx):
    if ctx.position.is_flat:
        return [ctx.buy(reason="go")]
    return [ctx.close_long(reason="out")]
'''


@pytest.fixture
def coded_strategies(tmp_path, monkeypatch):
    (tmp_path / "always_buy.py").write_text(ALWAYS_BUY)
    (tmp_path / "buy_cycle.py").write_text(BUY_CYCLE)
    monkeypatch.setattr(loader, "STRATEGIES_DIR", tmp_path)
    yield


def coded_request(candles, combos):
    req = rule_request(candles, combos)
    empty = {"combine": "AND", "rules": []}
    req["longEntry"] = empty
    req["codedStrategy"] = "always_buy.py"
    return req


# --- period + timeWindow environment combos (coded mode) ----------------------


def test_period_sweep_bad_pair_422(coded_strategies):
    candles = make_ramp_candles()
    for combos in ([{"period:from": T0 + 3600, "period:to": T0}],   # to <= from
                   [{"period:from": T0}],                            # missing to
                   [{"period:banana": 1}]):                          # unknown subkey
        res = client.post("/api/backtest/sweep/jobs",
                          json=coded_request(candles, combos))
        assert res.status_code == 422, combos


def test_timewindow_sweep_restricts_entries(coded_strategies):
    # A buy-then-exit coded strategy cycles trades every allowed bar. A narrow
    # 3-hour window admits fewer entries than the full day. No mask is
    # configured on the request: the backend synthesizes one per combo.
    candles = make_ramp_candles(n=96, split=96)   # 4 days, flat (P/L noise-free)
    req = coded_request(candles, [
        {"timeWindow:startMin": 0, "timeWindow:endMin": 1440, "timeWindow:tz": "UTC"},
        {"timeWindow:startMin": 180, "timeWindow:endMin": 360, "timeWindow:tz": "UTC"},
    ])
    req["codedStrategy"] = "buy_cycle.py"
    rows = post_rows(req)
    assert rows[0]["error"] is None and rows[1]["error"] is None
    assert rows[0]["metrics"]["n_trades"] > rows[1]["metrics"]["n_trades"] > 0


def test_timewindow_sweep_bad_tz_422(coded_strategies):
    res = client.post("/api/backtest/sweep/jobs", json=coded_request(
        make_ramp_candles(),
        [{"timeWindow:startMin": 0, "timeWindow:endMin": 60, "timeWindow:tz": "Not/AZone"}]))
    assert res.status_code == 422


def test_period_sweep_coded_mode(coded_strategies):
    candles = make_ramp_candles()
    mid = T0 + 40 * 3600
    rows = post_rows(coded_request(candles, [
        {"period:from": T0, "period:to": mid},
        {"period:from": mid, "period:to": T0 + 79 * 3600},
    ]))
    assert rows[0]["error"] is None and rows[1]["error"] is None
    assert abs(rows[0]["metrics"]["net_pnl"]) < 5
    assert rows[1]["metrics"]["net_pnl"] > rows[0]["metrics"]["net_pnl"]


def test_op_target_in_coded_mode_422(coded_strategies):
    res = client.post("/api/backtest/sweep/jobs", json=coded_request(
        make_ramp_candles(), [{"op:long.entry.0": "gt"}]))
    assert res.status_code == 422
