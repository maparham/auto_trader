"""OperandDTO validation rules."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from auto_trader.api.schemas import OperandDTO


def test_slope_allowed_on_indicator_and_price():
    OperandDTO(kind="indicator", indicator="EMA", length=9, slope={"len": 3})
    OperandDTO(kind="price", field="close", slope={"len": 1})


@pytest.mark.parametrize(
    "payload",
    [
        {"kind": "const", "value": 5.0, "slope": {"len": 3}},
        {"kind": "entry", "slope": {"len": 3}},
    ],
)
def test_slope_rejected_on_const_and_entry(payload):
    # Slope is only meaningful on a curve; a constant/entry-price slope is 0 and
    # would render a misleading reason like slope(5,3). Mirror the frontend, which
    # never offers the toggle for these kinds.
    with pytest.raises(ValidationError):
        OperandDTO(**payload)
