from datetime import datetime, timezone

import pytest

from auto_trader.core.models import Candle
from auto_trader.core.synthetic import SyntheticError, combine, legs, parse


def _c(ts: int, o: float, h: float, l: float, cl: float) -> Candle:
    return Candle(datetime.fromtimestamp(ts, tz=timezone.utc), o, h, l, cl, 0.0)


def test_legs_distinct_first_seen_order():
    node = parse("(AAPL + MSFT) / AAPL")
    assert legs(node) == ["AAPL", "MSFT"]


def test_precedence_mul_over_add():
    # 2 + 3 * 4 == 14, not 20
    node = parse("2 + 3 * 4")
    assert combine(node, {})[0].close == pytest.approx(14.0)
    # combine with no legs still needs a timeline; see constant-only note below.


def test_unary_minus_and_parens():
    node = parse("-(2 - 5)")
    assert combine(node, {})[0].close == pytest.approx(3.0)


def test_unknown_char_raises():
    with pytest.raises(SyntheticError):
        parse("AAPL % MSFT")


def test_unbalanced_parens_raises():
    with pytest.raises(SyntheticError):
        parse("(AAPL / MSFT")


def test_ratio_element_wise_close():
    # A/B at each aligned ts
    a = [_c(60, 10, 12, 8, 11)]
    b = [_c(60, 2, 4, 1, 2)]
    out = combine(parse("A / B"), {"A": a, "B": b})
    assert out[0].close == pytest.approx(11 / 2)
    assert out[0].open == pytest.approx(10 / 2)


def test_hl_clamp_keeps_bar_well_ordered():
    # Division can invert wicks: A.high/B.high < A.low/B.low. H/L must be re-derived.
    a = [_c(60, 10, 20, 10, 15)]
    b = [_c(60, 1, 4, 1, 2)]   # highs->20/4=5, lows->10/1=10  => raw H(5) < raw L(10)
    out = combine(parse("A / B"), {"A": a, "B": b})
    bar = out[0]
    assert bar.high == max(bar.open, bar.close, 5.0, 10.0)
    assert bar.low == min(bar.open, bar.close, 5.0, 10.0)
    assert bar.high >= bar.low


def test_forward_fill_union_and_leading_seed():
    # B starts one bar later; the first ts (60) has no B -> dropped (leading seed).
    # At ts 180 A is missing -> carry A's ts-120 bar forward.
    a = [_c(60, 1, 1, 1, 1), _c(120, 2, 2, 2, 2)]
    b = [_c(120, 5, 5, 5, 5), _c(180, 7, 7, 7, 7)]
    out = combine(parse("A + B"), {"A": a, "B": b})
    times = [int(c.time.timestamp()) for c in out]
    assert times == [120, 180]           # ts 60 dropped (B not seeded)
    assert out[0].close == pytest.approx(2 + 5)
    assert out[1].close == pytest.approx(2 + 7)  # A carried forward from ts 120


def test_divide_by_zero_drops_bar():
    a = [_c(60, 1, 1, 1, 1), _c(120, 2, 2, 2, 2)]
    b = [_c(60, 0, 0, 0, 0), _c(120, 4, 4, 4, 4)]
    out = combine(parse("A / B"), {"A": a, "B": b})
    times = [int(c.time.timestamp()) for c in out]
    assert times == [120]                # ts 60 division by zero -> gap
