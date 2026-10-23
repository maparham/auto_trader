import inspect

from auto_trader.strategy.expr import evaluate, validate, warmup


def test_every_walker_accepts_the_instances_map():
    for fn in (evaluate.series_of, evaluate.compile_row, warmup.warmup_bars, validate.validate):
        assert "instances" in inspect.signature(fn).parameters, fn.__name__


def test_instances_defaults_to_none_so_legacy_callers_still_work():
    for fn in (evaluate.series_of, evaluate.compile_row, warmup.warmup_bars, validate.validate):
        assert inspect.signature(fn).parameters["instances"].default is None, fn.__name__


def test_request_instances_includes_lines():
    from types import SimpleNamespace
    from auto_trader.api.sweep_apply import request_instances
    from auto_trader.strategy.expr.lines import line_key
    req = SimpleNamespace(indicators={}, epic="US100", broker="capital", resolution="HOUR", lines={
        "L1": SimpleNamespace(model_dump=lambda: dict(epic="US100", broker="capital", timeframe="HOUR",
            t1=1, p1=1.0, t2=2, p2=1.0, slope=0.0, tRef=2, pRef=1.0))})
    assert line_key("L1") in request_instances(req)
