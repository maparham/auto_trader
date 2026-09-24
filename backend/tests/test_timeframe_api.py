from auto_trader.api.deps import _parse_resolution
from auto_trader.core.telegram_notify import _timeframe_label
from auto_trader.strategy.expr.tfs import tf_resolution
from auto_trader.strategy.expr.parser import parse
from auto_trader.strategy.expr.validate import validate


def test_tf_resolution_accepts_grammar():
    assert tf_resolution("6H") == "HOUR_6"
    assert tf_resolution("90m") == "MINUTE_90"
    assert tf_resolution("D") == "DAY"
    assert tf_resolution("4H") == "HOUR_4"
    assert tf_resolution("HOUR_4") == "HOUR_4"
    assert tf_resolution("MINUTE_120") == "HOUR_2"
    assert tf_resolution("7h") is None
    assert tf_resolution("SECOND_5") is None


def test_pin_on_custom_timeframe_validates():
    # "close" alone is not a valid bare identifier in this grammar (only
    # candle/entry/barsSinceEntry/registered names are); every real usage in
    # the codebase and corpus spells it candle.close, so that's what's used
    # here to exercise the @6H pin on an otherwise-valid expression.
    validate(parse("candle.close@6H > candle.close"), is_exit=False)


def test_bad_pin_message_names_the_grammar():
    import pytest
    from auto_trader.strategy.expr.errors import ExprError

    with pytest.raises(ExprError, match="7m, 6H, 2D"):
        validate(parse("candle.close@6h > candle.close"), is_exit=False)


def test_parse_resolution_still_rejects_non_native():
    import pytest
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as e:
        _parse_resolution("HOUR_99")
    assert e.value.status_code == 422


def test_invalid_candles_resolution_raises_timeframe_error():
    # Direct-call convention of tests/test_api_candles.py (no lifespan, no
    # pytest-asyncio): the route raises; the app handler below maps it to 422.
    import asyncio

    import pytest

    import auto_trader.api.app as app_module
    from auto_trader.core.timeframe import TimeframeError

    async def scenario():
        return await app_module.candles(
            epic="US100", resolution="HOUR_99", bars=500, from_ts=None,
            to_ts=None, price_side="mid", broker_id="capital",
        )

    with pytest.raises(TimeframeError, match="between 1 and 24"):
        asyncio.run(scenario())


def test_timeframe_error_handler_is_422():
    import asyncio
    import json

    from auto_trader.api.app import _timeframe_error
    from auto_trader.core.timeframe import TimeframeError

    resp = asyncio.run(_timeframe_error(None, TimeframeError("hours must be between 1 and 24")))
    assert resp.status_code == 422
    assert json.loads(resp.body) == {"detail": "hours must be between 1 and 24"}


def test_stream_resolution_canonicalizes_or_explains():
    from auto_trader.api.routers.stream import _stream_resolution

    assert _stream_resolution("MINUTE_120") == ("HOUR_2", None)
    assert _stream_resolution("SECOND_5") == ("SECOND_5", None)
    res, err = _stream_resolution("HOUR_99")
    assert res is None and "between 1 and 24" in err


def test_telegram_label_falls_back_to_grammar():
    assert _timeframe_label("HOUR_4") == "4h"   # existing native wording kept
    assert _timeframe_label("HOUR_6") == "6H"
    assert _timeframe_label("garbage") == "garbage"


def test_alert_timeframe_param_canonicalizes():
    from auto_trader.api.routers.alerts import _validate_params

    params = {
        "level": 100.0,
        "condition": "greater",
        "trigger": "once",
        "timeframe": "6H",
    }
    _validate_params("price_level", params)
    assert params["timeframe"] == "HOUR_6"


def test_alert_timeframe_param_rejects_bad_grammar():
    import pytest
    from fastapi import HTTPException

    from auto_trader.api.routers.alerts import _validate_params

    params = {
        "level": 100.0,
        "condition": "greater",
        "trigger": "once",
        "timeframe": "HOUR_99",
    }
    with pytest.raises(HTTPException) as e:
        _validate_params("price_level", params)
    assert e.value.status_code == 422


# ---------------------------------------------------------------------------
# Router boundaries: request resolutions are canonicalized once, at the top of
# each handler (before any remote-forward branch), so a bad one is a 422 with
# the grammar's reason and an alias reaches the engine under its canonical key.
# ---------------------------------------------------------------------------

def _router_client():
    from fastapi.testclient import TestClient

    from auto_trader.api.app import app

    return TestClient(app)


_COSTS = {"quantity": 1, "commissionPerSide": 0,
          "slippage": {"kind": "fixed", "value": 0}, "spread": 0, "startingCash": 10000}


def _flat_candles(n=5):
    return [{"time": 3600 * k, "open": 1, "high": 1, "low": 1, "close": 1, "volume": 1}
            for k in range(n)]


def _backtest_body(resolution):
    return {"epic": "TEST", "resolution": resolution, "candles": _flat_candles(),
            "series": {}, "costs": _COSTS, "tradeFromTime": 0}


def _expr_body(resolution):
    return {
        "epic": "TEST", "resolution": resolution,
        "candles": [{"time": 3600 * k, "open": c, "high": c, "low": c, "close": c,
                     "volume": 100.0} for k, c in enumerate([1, 2, 3, 2, 1])],
        "htfCandles": None,
        "longEntry": [{"expr": "crossAbove(candle.close, 2)"}],
        "longExit": [{"expr": "candle.close < entry"}],
        "shortEntry": [], "shortExit": [],
        "longEnabled": True, "shortEnabled": True,
        "longRisk": None, "shortRisk": None, "longScaling": None, "shortScaling": None,
        "costs": _COSTS, "tradeFromTime": 0, "mask": None, "inspect": False,
    }


import pytest as _pytest


@_pytest.mark.parametrize("path", [
    "/api/backtest",
    "/api/backtest/sweep/jobs",
    "/api/backtest/sweep/jobs?target=remote",
    "/api/backtest/walkforward/jobs",
    "/api/backtest/walkforward/jobs?target=remote",
])
def test_backtest_routes_reject_invalid_resolution_with_422(path):
    r = _router_client().post(path, json=_backtest_body("HOUR_99"))
    assert r.status_code == 422, r.text
    assert "between 1 and 24" in r.json()["detail"]


@_pytest.mark.parametrize("path", [
    "/api/expr/backtest", "/api/expr/sweep/jobs", "/api/expr/walkforward/jobs",
])
def test_expr_routes_reject_invalid_resolution_with_422(path):
    r = _router_client().post(path, json=_expr_body("HOUR_99"))
    assert r.status_code == 422, r.text
    assert "between 1 and 24" in r.json()["detail"]


def test_expr_series_and_closeness_reject_invalid_resolution_with_422():
    c = _router_client()
    r = c.post("/api/expr/series", json={
        "epic": "TEST", "resolution": "MINUTE_1500", "expr": "candle.close",
        "fromTime": 0, "toTime": 3600})
    assert r.status_code == 422, r.text
    assert "minutes" in r.json()["detail"]
    for base, disp in (("HOUR_99", "HOUR"), ("HOUR", "HOUR_99")):
        r = c.post("/api/expr/closeness", json={
            "epic": "TEST", "rows": ["candle.close > 1"], "baseResolution": base,
            "displayResolution": disp, "fromTime": 0, "toTime": 3600})
        assert r.status_code == 422, r.text
        assert "between 1 and 24" in r.json()["detail"]


def test_expr_backtest_canonicalizes_an_alias_resolution():
    r = _router_client().post("/api/expr/backtest", json=_expr_body("MINUTE_60"))
    assert r.status_code == 200, r.text
    assert r.json()["resolution"] == "HOUR"


def _evaluate_body(resolution):
    return {
        "epic": "TEST", "resolution": resolution, "candles": _flat_candles(),
        "series": {}, "exprMode": True,
        "exprLongEntry": [{"expr": "candle.close > 0"}],
    }


def test_strategy_evaluate_rejects_invalid_resolution_with_422():
    r = _router_client().post("/api/strategy/evaluate", json=_evaluate_body("HOUR_99"))
    assert r.status_code == 422, r.text
    assert "between 1 and 24" in r.json()["detail"]


def test_strategy_evaluate_canonicalizes_an_alias_resolution(monkeypatch):
    import auto_trader.api.routers.strategy as strategy_router

    seen = []
    real = strategy_router._compile_expr_group

    def spy(rows, candles, resolution, *a, **kw):
        seen.append(resolution)
        return real(rows, candles, resolution, *a, **kw)

    monkeypatch.setattr(strategy_router, "_compile_expr_group", spy)
    r = _router_client().post("/api/strategy/evaluate", json=_evaluate_body("MINUTE_60"))
    assert r.status_code == 200, r.text
    assert seen and set(seen) == {"HOUR"}
