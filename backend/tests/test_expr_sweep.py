import pytest

from auto_trader.api.schemas import ExprBacktestRequest, ExprRowDTO
from auto_trader.api.sweep_apply import SweepValidationError, apply_lit_combo
from auto_trader.strategy.expr.literals import literals, substitute
from auto_trader.strategy.expr.parser import parse


def test_lit_substitution_changes_indicator_length():
    node = parse("EMA(50) > 0")
    swept = substitute(node, {0: 9})
    assert literals(swept)[0].value == 9


def _req(**groups) -> ExprBacktestRequest:
    """A minimal request carrying only the four expression groups. model_construct
    skips validation so we don't have to supply candles/costs/etc. apply_lit_combo
    reads only longEntry/longExit/shortEntry/shortExit."""
    base = {"longEntry": [], "longExit": [], "shortEntry": [], "shortExit": []}
    base.update(groups)
    return ExprBacktestRequest.model_construct(**base)


def test_apply_lit_combo_substitutes_addressed_row():
    req = _req(longEntry=[ExprRowDTO(expr="EMA(50) > 0")])
    out = apply_lit_combo(req, {"lit:long.entry.0.0": 9})
    node = out[("long", "entry", 0)]
    assert literals(node)[0].value == 9


def test_apply_lit_combo_ignores_non_lit_keys():
    req = _req(longEntry=[ExprRowDTO(expr="EMA(50) > 0")])
    out = apply_lit_combo(req, {"risk:long.stop.value": 2.0, "param:foo": 3})
    assert out == {}


def test_apply_lit_combo_merges_multiple_ordinals_on_one_row():
    # RSI(14) > 30 has two literals: length (ord 0) and threshold (ord 1).
    req = _req(longEntry=[ExprRowDTO(expr="RSI(14) > 30")])
    out = apply_lit_combo(
        req, {"lit:long.entry.0.0": 7, "lit:long.entry.0.1": 25})
    lits = literals(out[("long", "entry", 0)])
    assert [lit.value for lit in lits] == [7, 25]


def test_apply_lit_combo_malformed_key_422s():
    req = _req(longEntry=[ExprRowDTO(expr="EMA(50) > 0")])
    with pytest.raises(SweepValidationError) as ei:
        apply_lit_combo(req, {"lit:long.entry.0": 9})
    assert ei.value.status_code == 422


def test_apply_lit_combo_row_out_of_range_422s():
    req = _req(longEntry=[ExprRowDTO(expr="EMA(50) > 0")])
    with pytest.raises(SweepValidationError) as ei:
        apply_lit_combo(req, {"lit:long.entry.3.0": 9})
    assert ei.value.status_code == 422


def test_apply_lit_combo_non_numeric_value_422s():
    req = _req(longEntry=[ExprRowDTO(expr="EMA(50) > 0")])
    with pytest.raises(SweepValidationError) as ei:
        apply_lit_combo(req, {"lit:long.entry.0.0": "nope"})
    assert ei.value.status_code == 422
