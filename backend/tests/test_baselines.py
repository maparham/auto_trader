"""null_request / hold_request: synthesize baseline variants of an expr
backtest request. Null keeps everything but the entry signal; Hold strips
exits, risk, scaling, and the session mask so one position rides per side."""
from auto_trader.api.baselines import (
    expr_request_from_structured,
    hold_request,
    null_request,
)
from auto_trader.api.schemas import BacktestRequest, ExprBacktestRequest


def _req(**over):
    d = {
        "epic": "TEST", "resolution": "HOUR",
        "candles": [{"time": 3600 * k, "open": 1.0, "high": 1.0, "low": 1.0,
                     "close": 1.0, "volume": 1.0} for k in range(3)],
        "longEntry": [{"expr": "EMA(9) x> EMA(21)"}],
        "longExit": [{"expr": "candle.close < entry"}],
        "shortEntry": [{"expr": "EMA(9) x< EMA(21)"}],
        "shortExit": [],
        "longEnabled": True, "shortEnabled": False,
        "longRisk": {"stop": {"kind": "pct", "value": 1.0},
                     "target": {"kind": "pct", "value": 1.0}},
        "mask": {"enabled": True, "session": "NYSE"},
        "costs": {"quantity": 1, "commissionPerSide": 0,
                  "slippage": {"kind": "fixed", "value": 0},
                  "spread": 0, "startingCash": 10000},
        "tradeFromTime": 0,
        "sweep": {"combos": [{"lit:long.entry.0.0": 9}]},
    }
    d.update(over)
    return ExprBacktestRequest.model_validate(d)


def test_null_replaces_enabled_entries_keeps_the_rest():
    req = _req()
    out = null_request(req)
    assert [r.expr for r in out.longEntry] == ["1==1"]
    # Disabled side's entries left alone (it never trades anyway).
    assert [r.expr for r in out.shortEntry] == ["EMA(9) x< EMA(21)"]
    # Exit rules, risk, mask survive.
    assert [r.expr for r in out.longExit] == ["candle.close < entry"]
    assert out.longRisk is not None
    assert out.mask is not None
    # Sweep/WFO stripped: a baseline is a single run.
    assert out.sweep is None and out.walkforward is None


def test_null_both_sides_when_both_enabled():
    out = null_request(_req(shortEnabled=True))
    assert [r.expr for r in out.longEntry] == ["1==1"]
    assert [r.expr for r in out.shortEntry] == ["1==1"]


def test_hold_strips_exits_risk_scaling_mask():
    out = hold_request(_req())
    assert [r.expr for r in out.longEntry] == ["1==1"]
    assert out.longExit == [] and out.shortExit == []
    assert out.longRisk is None and out.shortRisk is None
    assert out.longScaling is None and out.shortScaling is None
    assert out.mask is None
    assert out.sweep is None and out.walkforward is None


def test_input_not_mutated():
    req = _req()
    null_request(req)
    hold_request(req)
    assert [r.expr for r in req.longEntry] == ["EMA(9) x> EMA(21)"]
    assert req.longRisk is not None and req.mask is not None


def _structured(**over):
    d = {
        "epic": "TEST", "resolution": "HOUR",
        "candles": [{"time": 3600 * k, "open": 1.0, "high": 1.0, "low": 1.0,
                     "close": 1.0, "volume": 1.0} for k in range(3)],
        "series": {"IGNORED": [1.0, 1.0, 1.0]},
        "exprLongExit": [{"expr": "candle.close < entry"}],
        "exprShortExit": [],
        "exprLongExitCombine": "OR",
        "exprShortExitCombine": "AND",
        "longEnabled": True, "shortEnabled": False,
        "longRisk": {"stop": {"kind": "pct", "value": 1.0},
                     "target": {"kind": "pct", "value": 1.0}},
        "mask": {"enabled": True, "session": "NYSE"},
        "costs": {"quantity": 1, "commissionPerSide": 0,
                  "slippage": {"kind": "fixed", "value": 0},
                  "spread": 0, "startingCash": 10000},
        "tradeFromTime": 0,
        "codedStrategy": "whatever.py",
        "broker": "capital", "priceSide": "bid",
    }
    d.update(over)
    return BacktestRequest.model_validate(d)


def test_converter_maps_panel_fields():
    out = expr_request_from_structured(_structured())
    assert out.longEntry == [] and out.shortEntry == []
    assert [r.expr for r in out.longExit] == ["candle.close < entry"]
    assert out.longExitCombine == "OR"
    assert out.shortExitCombine == "AND"
    assert out.longEnabled is True and out.shortEnabled is False
    assert out.longRisk is not None and out.mask is not None
    assert out.broker == "capital" and out.priceSide == "bid"
    assert out.epic == "TEST" and len(out.candles) == 3
    assert out.sweep is None and out.walkforward is None
    assert out.baselines is None and out.progressId is None


def test_converter_carries_indicator_instances():
    # Exit rows may name chart indicator outputs (SLOPE.14 etc.); their pane
    # settings ride the request's `indicators` dict and must pass through so
    # the expr pipeline can compile the exits.
    req = _structured(
        exprLongExit=[{"expr": "SLOPE.14 < 0"}],
        indicators={"slope1": {"type": "SLOPE", "calcParams": [9, 14, 50]}},
    )
    out = expr_request_from_structured(req)
    assert "slope1" in out.indicators


def test_converter_does_not_mutate_input():
    req = _structured()
    expr_request_from_structured(req)
    assert req.codedStrategy == "whatever.py"
    assert [r.expr for r in req.exprLongExit] == ["candle.close < entry"]
