"""Pins the pair-based evaluator: crossings compare the SIGN of
(subject - level) before and after, so either side may move; "every" fires at
most once per bar (bar_open vs last_fired_bar)."""
import math

from auto_trader.core.alert_eval import EvalResult, condition_hit, evaluate_alert

BAR = 1_000_000  # an arbitrary bar open (ms)


def ev(prev, cur, condition="crossing", trigger="every", bar_open=BAR, last=None):
    return evaluate_alert(prev, cur, condition, trigger, bar_open, last)


def test_first_sample_never_fires_crossing():
    assert ev(None, (101, 100)).fired is False

def test_crossing_up_fires():
    r = ev((99, 100), (101, 100))
    assert r == EvalResult(True, False)

def test_crossing_down_fires():
    assert ev((101, 100), (99, 100)).fired

def test_crossing_up_only():
    assert ev((99, 100), (101, 100), "crossing_up").fired
    assert not ev((101, 100), (99, 100), "crossing_up").fired

def test_crossing_down_only():
    assert ev((101, 100), (99, 100), "crossing_down").fired
    assert not ev((99, 100), (101, 100), "crossing_down").fired

def test_touch_without_cross_does_not_fire():
    assert not ev((99, 100), (100, 100)).fired

def test_moving_line_crosses_stationary_subject():
    # Price flat at 100; the line rises from 99 to 101 -> subject goes from
    # above the line to below it: a crossing down.
    assert ev((100, 99), (100, 101), "crossing_down").fired
    assert ev((100, 101), (100, 99), "crossing_up").fired

def test_touch_without_cross_both_sides_moving():
    # gap goes -1 -> 0: a touch, not a cross
    assert not ev((99, 100), (100.5, 100.5)).fired

def test_greater_fires_with_no_prev():
    assert ev(None, (101, 100), "greater").fired

def test_less_fires_with_no_prev():
    assert ev(None, (99, 100), "less").fired

def test_greater_not_satisfied():
    assert not ev(None, (99, 100), "greater").fired

def test_once_fire_requests_removal():
    assert ev((99, 100), (101, 100), trigger="once") == EvalResult(True, True)

def test_every_blocked_within_the_fired_bar():
    assert not ev((99, 100), (101, 100), bar_open=BAR, last=BAR).fired

def test_every_fires_again_next_bar_on_fresh_cross():
    assert ev((101, 100), (99, 100), bar_open=BAR + 60_000, last=BAR).fired

def test_greater_fires_once_per_bar_while_true():
    assert ev((101, 100), (102, 100), "greater", bar_open=BAR + 60_000, last=BAR).fired
    assert not ev((101, 100), (102, 100), "greater", bar_open=BAR, last=BAR).fired

def test_nonfinite_inputs_never_fire():
    assert ev((99, 100), (math.nan, 100)) == EvalResult(False, False)
    assert ev((99, 100), (101, math.inf)) == EvalResult(False, False)
    assert not condition_hit((math.nan, 100), (101, 100), "crossing")
