"""CostsDTO -> engine wiring and cost-sensitivity scaling."""
import pytest
from pydantic import ValidationError

from auto_trader.api.schemas import CostsDTO


def test_slippage_is_a_model_object():
    c = CostsDTO(quantity=1, commissionPerSide=0,
                 slippage={"kind": "atr", "value": 0.1, "atrMult": 2.0},
                 startingCash=1000)
    assert c.slippage.kind == "atr"
    assert c.spread == 0.0 and c.finLongDailyPct == 0.0


def test_numeric_slippage_rejected():
    with pytest.raises(ValidationError):
        CostsDTO(quantity=1, commissionPerSide=0, slippage=0.5, startingCash=1000)
