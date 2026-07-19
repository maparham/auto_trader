"""Walk-forward DTO shapes and defaults."""
from auto_trader.api.schemas import (
    BacktestRequest, WalkForwardDTO, WfoAxisDTO, WfoObjectiveDTO, WfoScheduleDTO,
    axis_dicts,
)


def test_walkforward_dto_defaults():
    dto = WalkForwardDTO(
        combos=[{"param:fast": 5}],
        axes=[WfoAxisDTO(kind="range", targets=["param:fast"], values=[5, 10])],
        schedule=WfoScheduleDTO(trainSpan="3m", testSpan="1m"),
    )
    assert dto.schedule.mode == "rolling"
    assert dto.schedule.step is None
    assert dto.schedule.minTrainTrades == 30
    assert dto.evalMode == "auto"
    assert dto.matrixTrainSpans == []
    assert WfoObjectiveDTO().selection == "plateau"
    assert axis_dicts(dto.axes) == [
        {"kind": "range", "targets": ["param:fast"], "values": [5.0, 10.0]}]


def test_backtest_request_accepts_walkforward():
    assert "walkforward" in BacktestRequest.model_fields
    assert BacktestRequest.model_fields["walkforward"].default is None
