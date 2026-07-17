"""POST /api/backtest/sweep/jobs: the operator / period / timeWindow sweep
dimensions (spec 2026-07-14). Rule-mode requests are hand-built (price vs
const rules need no posted series: the backend recomputes natives)."""

import pytest
from fastapi.testclient import TestClient

import auto_trader.strategy.loader as loader
from auto_trader.api.app import app

from test_api_backtest_sweep import run_sweep_via_jobs

client = TestClient(app)

T0 = 19676 * 86400  # a UTC midnight, hourly bars land on clean day boundaries


def make_step_candles(n=80, split=40, lo=95.0, hi=105.0):
    """First `split` bars close at `lo`, the rest at `hi`."""
    out = []
    for i in range(n):
        px = lo if i < split else hi
        out.append({"time": T0 + i * 3600, "open": px, "high": px + 1,
                    "low": px - 1, "close": px, "volume": 100})
    return out


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


def test_op_sweep_patches_operator():
    # Step candles: "gt 100" enters at the step (entry ~105, ends ~105);
    # "lt 100" enters at bar 0 (entry ~95, ends ~105). Different net P/L.
    rows = post_rows(rule_request(make_step_candles(), [
        {"op:long.entry.0": "gt"}, {"op:long.entry.0": "lt"},
    ]))
    assert rows[0]["error"] is None and rows[1]["error"] is None
    assert rows[0]["metrics"]["net_pnl"] != rows[1]["metrics"]["net_pnl"]


def test_op_sweep_crosses_above_fires():
    rows = post_rows(rule_request(make_step_candles(), [
        {"op:long.entry.0": "crossesAbove"},
    ]))
    assert rows[0]["error"] is None
    assert rows[0]["metrics"]["n_trades"] == 1


def test_op_sweep_invalid_operator_422():
    res = client.post("/api/backtest/sweep/jobs", json=rule_request(
        make_step_candles(), [{"op:long.entry.0": "banana"}]))
    assert res.status_code == 422
    assert "op:long.entry.0" in res.json()["detail"]


def test_op_sweep_index_out_of_range_422():
    res = client.post("/api/backtest/sweep/jobs", json=rule_request(
        make_step_candles(), [{"op:long.entry.5": "gt"}]))
    assert res.status_code == 422


# --- period + timeWindow environment combos ----------------------------------

ALWAYS_TRUE = 0.0  # entry "close gt 0" is true on every bar


def test_period_sweep_truncates_and_gates():
    # Ramp candles: flat first half, +1/bar second half. W1 (flat half) must
    # end at the midpoint: near-zero P/L. W2 rides the ramp: clearly positive.
    candles = make_ramp_candles()
    mid = T0 + 40 * 3600
    end = T0 + 79 * 3600
    rows = post_rows(rule_request(candles, [
        {"period:from": T0, "period:to": mid},
        {"period:from": mid, "period:to": end},
    ], entry_value=ALWAYS_TRUE))
    assert rows[0]["error"] is None and rows[1]["error"] is None
    # Truncation proof: without it W1's open trade would exit at the ramp top
    # (P/L ~ +39); truncated it exits at the flat midpoint.
    assert abs(rows[0]["metrics"]["net_pnl"]) < 5
    assert rows[1]["metrics"]["net_pnl"] > rows[0]["metrics"]["net_pnl"]


def test_period_sweep_bad_pair_422():
    candles = make_ramp_candles()
    for combos in ([{"period:from": T0 + 3600, "period:to": T0}],   # to <= from
                   [{"period:from": T0}],                            # missing to
                   [{"period:banana": 1}]):                          # unknown subkey
        res = client.post("/api/backtest/sweep/jobs",
                          json=rule_request(candles, combos, entry_value=ALWAYS_TRUE))
        assert res.status_code == 422, combos


def test_timewindow_sweep_restricts_entries():
    # Always-true entry + always-true exit cycles trades all day. A narrow
    # 3-hour window admits fewer entries than the full day. No mask is
    # configured on the request: the backend synthesizes one per combo.
    candles = make_ramp_candles(n=96, split=96)   # 4 days, flat (P/L noise-free)
    exit_rules = [{"left": {"kind": "price", "field": "close"},
                   "op": "gt", "right": {"kind": "const", "value": 0.0}}]
    rows = post_rows(rule_request(candles, [
        {"timeWindow:startMin": 0, "timeWindow:endMin": 1440, "timeWindow:tz": "UTC"},
        {"timeWindow:startMin": 180, "timeWindow:endMin": 360, "timeWindow:tz": "UTC"},
    ], entry_value=ALWAYS_TRUE, exit_rules=exit_rules))
    assert rows[0]["error"] is None and rows[1]["error"] is None
    assert rows[0]["metrics"]["n_trades"] > rows[1]["metrics"]["n_trades"] > 0


def test_timewindow_sweep_bad_tz_422():
    res = client.post("/api/backtest/sweep/jobs", json=rule_request(
        make_ramp_candles(),
        [{"timeWindow:startMin": 0, "timeWindow:endMin": 60, "timeWindow:tz": "Not/AZone"}],
        entry_value=ALWAYS_TRUE))
    assert res.status_code == 422


# --- coded-mode environment combos --------------------------------------------

ALWAYS_BUY = '''
def on_bar(ctx):
    if ctx.position.is_flat:
        return [ctx.buy(reason="go")]
    return []
'''


@pytest.fixture
def coded_strategies(tmp_path, monkeypatch):
    (tmp_path / "always_buy.py").write_text(ALWAYS_BUY)
    monkeypatch.setattr(loader, "STRATEGIES_DIR", tmp_path)
    yield


def coded_request(candles, combos):
    req = rule_request(candles, combos)
    empty = {"combine": "AND", "rules": []}
    req["longEntry"] = empty
    req["codedStrategy"] = "always_buy.py"
    return req


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
