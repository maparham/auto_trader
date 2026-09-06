"""Port of frontend/src/lib/alertEval.test.ts — pins the Python evaluator to the TS semantics."""
import math

from auto_trader.core.alert_eval import EvalResult, evaluate_alert


def ev(prev, price, level, condition="crossing", trigger="every", armed=True):
    return evaluate_alert(prev, price, level, condition, trigger, armed)


def test_first_tick_never_fires_crossing():
    assert ev(None, 101, 100).fired is False

def test_crossing_up_fires():
    r = ev(99, 101, 100, "crossing")
    assert r.fired and r.next_armed is False and r.remove is False

def test_crossing_down_fires():
    assert ev(101, 99, 100, "crossing").fired

def test_crossing_up_only():
    assert ev(99, 101, 100, "crossing_up").fired
    assert not ev(101, 99, 100, "crossing_up").fired

def test_crossing_down_only():
    assert ev(101, 99, 100, "crossing_down").fired
    assert not ev(99, 101, 100, "crossing_down").fired

def test_touch_without_cross_does_not_fire():
    # prev <= level and price == level is not "price > level"
    assert not ev(99, 100, 100, "crossing").fired

def test_greater_fires_immediately_even_with_none_prev():
    r = ev(None, 101, 100, "greater")
    assert r.fired

def test_less_fires_immediately_even_with_none_prev():
    assert ev(None, 99, 100, "less").fired

def test_greater_not_satisfied():
    assert not ev(None, 99, 100, "greater").fired

def test_once_fire_requests_removal():
    r = ev(99, 101, 100, "crossing", "once")
    assert r.fired and r.remove and r.next_armed is False

def test_disarmed_does_not_fire():
    assert not ev(99, 101, 100, "crossing", "every", armed=False).fired

def test_every_rearm_after_clearing_level():
    # level 100, margin = 100*5e-4 = 0.05; price must clear by > margin
    r = ev(100.0, 100.02, 100, "crossing", "every", armed=False)
    assert r.next_armed is False  # within margin: stays disarmed
    r = ev(100.02, 100.06, 100, "crossing", "every", armed=False)
    assert r.next_armed is True   # cleared the margin

def test_greater_rearm_only_when_condition_false_again():
    # satisfied "greater" must NOT re-arm while price is above the level
    r = ev(101, 102, 100, "greater", "every", armed=False)
    assert r.next_armed is False
    r = ev(102, 99.9, 100, "greater", "every", armed=False)
    assert r.next_armed is True   # below level - margin (99.95)

def test_less_rearm_above_level_plus_margin():
    r = ev(99, 100.06, 100, "less", "every", armed=False)
    assert r.next_armed is True

def test_zero_level_has_margin_floor():
    # abs(0)*frac == 0 → floor 1e-10 keeps hysteresis
    r = ev(0.0, 0.0, 0.0, "crossing", "every", armed=False)
    assert r.next_armed is False

def test_nonfinite_inputs_unchanged():
    r = evaluate_alert(99, math.nan, 100, "crossing", "every", True)
    assert r == EvalResult(False, True, False)
    r = evaluate_alert(99, 101, math.inf, "crossing", "every", True)
    assert r == EvalResult(False, True, False)
