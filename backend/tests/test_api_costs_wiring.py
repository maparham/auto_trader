"""CostsDTO -> engine wiring and cost-sensitivity scaling."""
import pytest
from pydantic import ValidationError

from auto_trader.api.schemas import BacktestRequest, CostsDTO, SlippageDTO
from auto_trader.api.sweep_apply import candle_from_dto, run_rule_sync


def test_slippage_is_a_model_object():
    c = CostsDTO(quantity=1, commissionPerSide=0,
                 slippage={"kind": "atr", "value": 0.1, "atrMult": 2.0},
                 startingCash=1000)
    assert c.slippage.kind == "atr"
    assert c.spread == 0.0 and c.finLongDailyPct == 0.0


def test_numeric_slippage_rejected():
    with pytest.raises(ValidationError):
        CostsDTO(quantity=1, commissionPerSide=0, slippage=0.5, startingCash=1000)


def _candles(closes: list[float]) -> list[dict]:
    return [
        {"time": 1_700_000_000 + i * 3600, "open": c, "high": c, "low": c, "close": c, "volume": 0.0}
        for i, c in enumerate(closes)
    ]


def _empty():
    return {"combine": "AND", "rules": []}


def test_spread_shifts_buy_entry_through_run_rule_sync():
    """Task-1 wiring end to end: with flat candles at 100 and spread 1.0, an
    always-firing BUY entry fills at open + half_spread = 100.5."""
    body = {
        "epic": "EURUSD",
        "resolution": "HOUR",
        "candles": _candles([100.0, 100.0, 100.0, 100.0, 100.0]),
        "series": {},
        "longEntry": {
            "combine": "AND",
            "rules": [
                {"left": {"kind": "price", "field": "close"}, "op": "gt",
                 "right": {"kind": "const", "value": 99.0}},
            ],
        },
        "longExit": _empty(),
        "shortEntry": _empty(),
        "shortExit": _empty(),
        "costs": {"quantity": 1.0, "commissionPerSide": 0.0,
                  "slippage": {"kind": "fixed", "value": 0.0},
                  "spread": 1.0, "startingCash": 10_000.0},
        "tradeFromTime": 1_700_000_000,
    }
    req = BacktestRequest(**body)
    candles = [candle_from_dto(c) for c in req.candles]

    result = run_rule_sync(req, candles, {})

    assert len(result.trades) > 0
    assert result.trades[0].side.value == "buy"
    assert result.trades[0].entry_price == pytest.approx(100.5)
