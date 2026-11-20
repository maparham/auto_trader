"""Trendlines Log Scale (calcParams slot 33): the detector on ln prices."""

from __future__ import annotations

import math

import pytest
from dataclasses import replace
from auto_trader.core.models import Candle
from auto_trader.indicators.alert_specs import _tl_side
from auto_trader.indicators.trendlines import (
    TL_LOG_FLOOR,
    compute_trendlines,
    parse_trendlines_config,
    tl_exp,
    tl_log,
    tl_log_candle,
    trendlines_config_params,
)
from tests.test_trendlines_indicator import bar


def _walk(n: int, seed: int = 11) -> list[Candle]:
    """The random walk of test_trendlines_indicator, made geometric: each
    step is a percent of price, with an upward drift, so price climbs to
    levels where log and linear lines part ways."""
    s = seed
    out: list[Candle] = []
    px = 100.0
    for i in range(n):
        s = (s * 1664525 + 1013904223) % (2**32)
        px *= 1 + (s / 2**32 - 0.49) * 0.03
        out.append(bar(i, px * 0.995, px * 1.005))
    return out


def _cfg(**kw):
    base = parse_trendlines_config([3, 0, 2, 10, 60], {})
    return replace(base, major_pivots=0, **kw)


def test_math_matches_stdlib_closely_and_floors():
    for x in (1e-6, 0.5, 1.0, math.sqrt(2), 2.0, 99.99, 65432.1, 1e9):
        assert tl_log(x) == math.log(x) or abs(tl_log(x) - math.log(x)) <= 4e-16 * max(1.0, abs(math.log(x)))
        assert abs(tl_exp(tl_log(x)) / x - 1) < 1e-15
    assert tl_log(0.0) == tl_log(-3.0) == tl_log(TL_LOG_FLOOR)


def test_slot_33_round_trips():
    cfg = parse_trendlines_config([0] * 33 + [1], {})
    assert cfg.log_scale == 1
    assert trendlines_config_params(cfg)[33] == 1.0
    assert parse_trendlines_config([], {}).log_scale == 0


def test_log_mode_is_the_linear_detector_on_ln_candles():
    candles = _walk(500)
    log_pts, log_lines = compute_trendlines(candles, _cfg(log_scale=1))
    lin_pts, lin_lines = compute_trendlines([tl_log_candle(c) for c in candles], _cfg())
    assert log_lines and log_lines == lin_lines
    assert any(p for p in log_pts)
    assert log_pts == [{k: tl_exp(v) for k, v in p.items()} for p in lin_pts]


def test_alert_side_follows_the_log_line():
    candles = _walk(500)
    cfg = _cfg(log_scale=1)
    side = _tl_side(cfg, "tl_nearest", candles)
    checked = 0
    for i in range(1, len(candles) - 1):
        v, s, held_next = side["value"][i], side["slope"][i], side["held"][i + 1]
        # held at i+1 is the line nearest at i, one bar on: value + slope.
        if v is not None and s is not None and held_next is not None:
            assert v + s == held_next or abs(v + s - held_next) <= 1e-9 * held_next
            checked += 1
    assert checked > 50


# ---- Log Scale line geometry (picked lines L<n> and line alerts) ----


def test_line_level_linear_and_log():
    from auto_trader.core.line_level import line_level

    assert line_level(100.0, 2.0, 5) == 110.0
    assert line_level(100.0, math.log(2), 3, True) == pytest.approx(800.0, rel=1e-12)
    assert line_level(100.0, math.log(2), -1, True) == pytest.approx(50.0, rel=1e-12)


def test_picked_log_line_follows_the_trendline_from_either_anchor():
    from tests.test_expr_lines import _candles, _line, _ms

    from auto_trader.strategy.expr.lines import line_series, parse_lines

    # 100 at k=2, doubling every 3 bars: 200 at k=5, 400 at k=8 (tRef).
    ln = _line(p1=100.0, p2=200.0, slope=math.log(2) / 3, pRef=400.0, log=True)
    from_t2 = line_series(ln, _candles(10))
    assert from_t2[5] == pytest.approx(200.0) and from_t2[8] == pytest.approx(400.0)
    from_ref = line_series(ln, _candles(4, start_k=7))
    assert from_ref[1] == pytest.approx(400.0) and from_ref[3] == pytest.approx(400.0 * 2 ** (2 / 3))
    d = {"epic": "US100", "broker": "capital", "timeframe": "HOUR", "t1": _ms(2), "p1": 100.0,
         "t2": _ms(5), "p2": 200.0, "slope": 0.2, "tRef": _ms(8), "pRef": 400.0}
    assert parse_lines({"L1": {**d, "log": True}})["L1"].log is True
    assert parse_lines({"L1": d})["L1"].log is False


def test_line_alert_key_and_series_carry_log():
    from datetime import UTC, datetime, timedelta

    from auto_trader.core.alert_kinds import LINE
    from auto_trader.indicators.alert_series import compute

    t0 = datetime(2026, 1, 1, tzinfo=UTC)
    candles = [Candle(t0 + timedelta(hours=k), 1, 1, 1, 1) for k in range(6)]
    t_ref = int(candles[2].time.timestamp() * 1000)
    params = {"tRef": t_ref, "pRef": 100.0, "slope": math.log(2), "log": True,
              "anchors": {"t1": 1, "p1": 50.0, "t2": t_ref, "p2": 100.0}}
    key = LINE.indicator_key(params)
    vals = compute(key, candles)["value"]
    assert vals[:2] == [None, None]
    assert vals[2:] == pytest.approx([100.0, 200.0, 400.0, 800.0])
    linear = LINE.indicator_key({**params, "log": False, "slope": 10.0})
    assert len(linear.calc) == 3
    assert compute(linear, candles)["value"][3] == 110.0
