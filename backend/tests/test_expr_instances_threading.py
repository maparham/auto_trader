import inspect

from auto_trader.strategy.expr import evaluate, validate, warmup


def test_every_walker_accepts_the_instances_map():
    for fn in (evaluate.series_of, evaluate.compile_row, warmup.warmup_bars, validate.validate):
        assert "instances" in inspect.signature(fn).parameters, fn.__name__


def test_instances_defaults_to_none_so_legacy_callers_still_work():
    for fn in (evaluate.series_of, evaluate.compile_row, warmup.warmup_bars, validate.validate):
        assert inspect.signature(fn).parameters["instances"].default is None, fn.__name__
