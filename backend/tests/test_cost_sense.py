"""Breakeven cost multiple: interpolation + edge cases."""
from auto_trader.engine.cost_sense import breakeven_multiple


def test_interpolates_between_multiples():
    # net 100 at 1x, -50 at 2x -> crosses at 1 + 100/150
    assert breakeven_multiple([0, 1, 2, 3], [150, 100, -50, -200]) == round(1 + 100 / 150, 2)


def test_all_profitable_is_none():
    assert breakeven_multiple([0, 1, 2, 3], [90, 80, 70, 60]) is None


def test_unprofitable_at_zero_costs_is_zero():
    assert breakeven_multiple([0, 1, 2, 3], [-10, -20, -30, -40]) == 0.0


def test_exact_zero_counts_as_breakeven():
    assert breakeven_multiple([0, 1, 2], [50, 0, -50]) == 1.0
