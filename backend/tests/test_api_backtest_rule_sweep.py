from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from auto_trader.api import deps
from auto_trader.api.app import app
from auto_trader.api.sweep_apply import SweepValidationError, apply_rule_combo
from auto_trader.api.schemas import BacktestRequest
from auto_trader.core.models import Candle

from test_api_backtest_sweep import run_sweep_via_jobs

client = TestClient(app)


@pytest.fixture(autouse=True)
def _no_htf_fetch(monkeypatch):
    """All endpoint tests below use base-timeframe-only rule configs (no
    per-operand `timeframe`), so the sweep's rule branch must never reach for
    an HTF fetch. Fail loudly if a config accidentally introduces one."""
    async def _boom(*args, **kwargs):
        raise AssertionError("deps._fetch_symbol_candles must not be called (HTF operand present)")

    monkeypatch.setattr(deps, "_fetch_symbol_candles", _boom)
    yield


def _req(**over):
    base = {
        "epic": "X", "resolution": "HOUR", "candles": [], "series": {},
        "longEntry": {"combine": "AND", "rules": [
            {"left": {"kind": "indicator", "indicator": "EMA", "length": 9}, "op": "gt",
             "right": {"kind": "const", "value": 50.0}}]},
        "longExit": {"combine": "AND", "rules": [
            {"left": {"kind": "price", "field": "close"}, "op": "lt",
             "right": {"kind": "const", "value": 0}, "count": 1}]},
        "shortEntry": {"combine": "AND", "rules": []},
        "shortExit": {"combine": "AND", "rules": []},
        "costs": {"quantity": 1, "commissionPerSide": 0, "slippage": 0, "startingCash": 1000},
        "tradeFromTime": 0,
    }
    base.update(over)
    return BacktestRequest(**base)


def test_patch_indicator_length():
    out = apply_rule_combo(_req(), {"rule:long.entry.0.left.length": 21})
    assert out.longEntry.rules[0].left.length == 21


def test_patch_const_value_and_count():
    out = apply_rule_combo(_req(), {"rule:long.entry.0.right.value": 75.0,
                                     "rule:long.exit.0.count": 3})
    assert out.longEntry.rules[0].right.value == 75.0
    assert out.longExit.rules[0].count == 3


def test_bad_path_422s():
    with pytest.raises(SweepValidationError) as e:
        apply_rule_combo(_req(), {"rule:long.entry.9.left.length": 5})
    assert e.value.status_code == 422


# --- endpoint: POST /api/backtest/sweep/jobs, rule branch --------------------


def _candles(closes: list[float]) -> list[dict]:
    return [
        {"time": 1_700_000_000 + i * 3600, "open": c, "high": c, "low": c, "close": c, "volume": 0.0}
        for i, c in enumerate(closes)
    ]


def _costs() -> dict:
    return {"quantity": 1.0, "commissionPerSide": 0.0, "slippage": 0.0, "startingCash": 10_000.0}


def _groups(long_entry=None, long_exit=None, short_entry=None, short_exit=None):
    empty = {"combine": "AND", "rules": []}
    return {
        "longEntry": long_entry or empty,
        "longExit": long_exit or empty,
        "shortEntry": short_entry or empty,
        "shortExit": short_exit or empty,
    }


def _sweep_payload() -> dict:
    # Rise, sharp dip, then rise again: EMA(3) tracks the dip/recovery more
    # closely than EMA(5), so `close crossesAbove EMA(length)` fires on a
    # different bar for length=3 vs length=5, producing different
    # n_trades/net_pnl across the two combos.
    closes = [
        10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
        15, 11, 8, 6, 5, 5, 6,
        8, 12, 17, 23, 28,
    ]
    return {
        "epic": "EURUSD",
        "resolution": "HOUR",
        "candles": _candles(closes),
        "series": {},
        **_groups(
            long_entry={
                "combine": "AND",
                "rules": [
                    {"left": {"kind": "indicator", "indicator": "EMA", "length": 3},
                     "op": "crosses", "right": {"kind": "price", "field": "close"}},
                ],
            },
        ),
        "costs": _costs(),
        # Start trading after the initial rise-crossing (idx 1) and the
        # dip-entry crossing (idx 10, identical for both lengths), so only the
        # divergent dip-recovery crossing (idx 16 vs 17) is in scope.
        "tradeFromTime": 1_700_000_000 + 11 * 3600,
        "sweep": {"combos": [
            {"rule:long.entry.0.left.length": 3},
            {"rule:long.entry.0.left.length": 5},
        ]},
    }


def test_rule_sweep_endpoint():
    rows = run_sweep_via_jobs(client, _sweep_payload())
    assert len(rows) == 2
    assert all(row["metrics"] is not None for row in rows)
    assert rows[0]["combo"]["rule:long.entry.0.left.length"] == 3
    assert rows[1]["combo"]["rule:long.entry.0.left.length"] == 5
    assert rows[0]["metrics"] != rows[1]["metrics"]


def test_rule_sweep_endpoint_422_without_coded_strategy_no_longer_raised():
    """The old hard guard (`sweep requires a coded strategy`) must be gone:
    a rule-only payload (codedStrategy omitted) now sweeps successfully."""
    rows = run_sweep_via_jobs(client, _sweep_payload())
    assert all(row["error"] is None for row in rows)


def test_rule_sweep_endpoint_422_on_missing_chart_operand_series():
    payload = _sweep_payload()
    payload["longEntry"] = {
        "combine": "AND",
        "rules": [
            {"left": {"kind": "series", "seriesKey": "CHART_x", "label": "foo"},
             "op": "gt", "right": {"kind": "const", "value": 0}},
        ],
    }
    r = client.post("/api/backtest/sweep/jobs", json=payload)
    assert r.status_code == 422
    assert "CHART_x" in r.json()["detail"]


def _htf_candles(n=40) -> list[Candle]:
    """Synthetic HOUR_4 candles covering the base window with warmup room."""
    t0 = datetime(2023, 11, 14, tzinfo=timezone.utc)  # 1_700_000_000-ish
    out = []
    px = 10.0
    for i in range(n):
        px += 0.3
        out.append(Candle(time=t0 + timedelta(hours=4 * i), open=px, high=px + 1,
                          low=px - 1, close=px, volume=1.0))
    return out


def test_rule_sweep_htf_operand_fetches_once_across_combos(monkeypatch):
    """M1: the HTF candle set is combo-invariant (combos never sweep
    `timeframe`), so the sweep must fetch it ONCE for the whole sweep, not
    once per combo. This overrides the module's autouse `_boom` fixture."""
    calls = {"n": 0}

    async def fake_fetch(broker_id, epic, resolution, bars, from_ts, to_ts, price_side):
        calls["n"] += 1
        assert resolution == "HOUR_4"
        return _htf_candles()

    monkeypatch.setattr(deps, "_fetch_symbol_candles", fake_fetch)

    payload = {
        "epic": "EURUSD",
        "resolution": "HOUR",
        "candles": _candles([10 + i * 0.1 for i in range(30)]),
        "series": {},
        **_groups(
            long_entry={
                "combine": "AND",
                "rules": [
                    {"left": {"kind": "indicator", "indicator": "EMA", "length": 3,
                              "timeframe": "HOUR_4"},
                     "op": "gt", "right": {"kind": "const", "value": 0.0}},
                ],
            },
        ),
        "costs": _costs(),
        "tradeFromTime": 1_700_000_000,
        "sweep": {"combos": [
            {"rule:long.entry.0.left.length": 3},
            {"rule:long.entry.0.left.length": 5},
        ]},
    }

    rows = run_sweep_via_jobs(client, payload)
    assert len(rows) == 2
    assert all(row["metrics"] is not None for row in rows)
    assert calls["n"] == 1  # hoisted: fetched once, reused across both combos
