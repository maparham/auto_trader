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
    assert dto.evalMode == "exact"
    assert dto.matrixTrainSpans == []
    assert WfoObjectiveDTO().selection == "plateau"
    assert axis_dicts(dto.axes) == [
        {"kind": "range", "targets": ["param:fast"], "values": [5.0, 10.0]}]


def test_axis_dicts_passes_ui_through_verbatim():
    # `ui` is the frontend's SweepAxis, opaque here; it must survive into the
    # result (and archive) so the UI can label combos, and stay absent when the
    # client didn't send it (pre-field payloads).
    ui = {"kind": "range", "target": "param:fast", "label": "fast", "from": 5, "to": 10, "step": 5}
    axes = [
        WfoAxisDTO(kind="range", targets=["param:fast"], values=[5, 10], ui=ui),
        WfoAxisDTO(kind="list", targets=["op:long.entry.0"]),
    ]
    assert axis_dicts(axes) == [
        {"kind": "range", "targets": ["param:fast"], "values": [5.0, 10.0], "ui": ui},
        {"kind": "list", "targets": ["op:long.entry.0"]},
    ]


def test_eval_mode_normalizes_legacy_values():
    # Legacy "auto"/"sliced" both mean the one-run-sliced approximation now
    # called "fast"; older clients keep working.
    def _mode(v):
        return WalkForwardDTO(
            combos=[{"param:fast": 5}],
            axes=[WfoAxisDTO(kind="range", targets=["param:fast"], values=[5, 10])],
            schedule=WfoScheduleDTO(trainSpan="3m", testSpan="1m"),
            evalMode=v,
        ).evalMode

    assert _mode("auto") == "fast"
    assert _mode("sliced") == "fast"
    assert _mode("fast") == "fast"
    assert _mode("exact") == "exact"


def test_backtest_request_accepts_walkforward():
    assert "walkforward" in BacktestRequest.model_fields
    assert BacktestRequest.model_fields["walkforward"].default is None
