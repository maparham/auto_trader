"""Fold planning: backwards tiling from the range end, rolling and anchored."""
import pytest

from auto_trader.api.wfo_plan import Fold, WfoPlanError, parse_span, plan

D = 86400


def test_parse_span_units():
    assert parse_span("10d", 3600) == 10 * D
    assert parse_span("2w", 3600) == 14 * D
    assert parse_span("3m", 3600) == 90 * D
    assert parse_span("500b", 3600) == 500 * 3600
    for bad in ("", "d", "10", "10x", "-3d", "1.5m"):
        with pytest.raises(WfoPlanError):
            parse_span(bad, 3600)


def test_rolling_tiles_backwards_from_range_end():
    # 100 days total, train 20d, test 10d, step 10d -> tests tile the tail.
    folds = plan(0, 100 * D, "rolling", 20 * D, 10 * D, 10 * D)
    assert folds[-1].test_to == 100 * D
    assert folds[-1].test_from == 90 * D
    assert folds[-1].train_from == 70 * D
    assert folds[-1].train_to == 90 * D
    # Consecutive test segments are contiguous.
    for a, b in zip(folds, folds[1:]):
        assert a.test_to == b.test_from
    # Every fold fits inside the range.
    assert all(f.train_from >= 0 for f in folds)
    # 8 folds fit: earliest needs train_from >= 0.
    assert len(folds) == 8


def test_anchored_pins_train_start():
    folds = plan(0, 100 * D, "anchored", 20 * D, 10 * D, 10 * D)
    assert all(f.train_from == 0 for f in folds)
    # Earliest fold still needs a full minimum train span.
    assert folds[0].train_to - folds[0].train_from >= 20 * D
    # Latest fold trains on everything before its test.
    assert folds[-1].train_to == 90 * D


def test_too_few_folds_raises():
    with pytest.raises(WfoPlanError):
        plan(0, 35 * D, "rolling", 20 * D, 10 * D, 10 * D)  # only 1 fold fits
