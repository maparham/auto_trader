"""AUTO_FIB backend series. Mirrors the frontend suites
(frontend/src/lib/indicators/autoFib.test.ts, autoFibOutputs.test.ts): same
fixtures, same expectations, same name table. Exact cross-runtime parity is
separately pinned by test_indicator_parity.py."""

from datetime import datetime, timezone

import pytest

from auto_trader.core.models import Candle
from auto_trader.indicators.auto_fib import (
    AutoFibConfig,
    auto_fib_outputs,
    auto_fib_series,
    auto_fib_warmup,
    compute_pairs,
    fib_level_price,
    fib_output_name,
    parse_auto_fib_config,
)
from auto_trader.indicators.registry import SERIES_INDICATORS


def bar(close: float, i: int, open_: float | None = None, high: float | None = None,
        low: float | None = None) -> Candle:
    return Candle(
        time=datetime.fromtimestamp(1700000000 + i * 3600, tz=timezone.utc),
        open=close if open_ is None else open_,
        high=close + 1 if high is None else high,
        low=close - 1 if low is None else low,
        close=close,
        volume=1,
    )


def triangle(peaks: list[float]) -> list[Candle]:
    closes: list[float] = []
    for p in peaks:
        up = (p - 100) / 4
        closes.extend([100, 100 + up, 100 + 2 * up, 100 + 3 * up, p, 100 + 3 * up, 100 + 2 * up, 100 + up])
    closes.append(100)
    return [bar(c, i) for i, c in enumerate(closes)]


CFG = parse_auto_fib_config([2, 0], {})
TRI = triangle([110, 110, 110, 110])


@pytest.mark.parametrize("value,name", [
    (0, "f0"), (0.236, "f0_236"), (0.5, "f0_5"), (0.618, "f0_618"), (1, "f1"),
    (1.618, "f1_618"), (-0.236, "fm0_236"), (10, "f10"), (0.03125, "f0_0313"),
    (1.005, "f1_005"), (-0.00001, "fm0"),
])
def test_fib_output_name(value, name):
    # Same table as frontend autoFibOutputs.test.ts.
    assert fib_output_name(value) == name


def test_fib_output_name_rejects_huge_and_non_finite():
    assert fib_output_name(1e6) is None
    assert fib_output_name(float("inf")) is None
    assert fib_output_name(float("nan")) is None


def test_parse_defaults_and_garbage():
    assert parse_auto_fib_config(None, None) == parse_auto_fib_config([5, 0], {})
    cfg = parse_auto_fib_config([0, -1], "junk")
    assert (cfg.pivot_len, cfg.min_swing_atr, cfg.reverse, cfg.timeframe) == (5, 0.0, False, None)
    assert parse_auto_fib_config([7.9, 1.5], {}).pivot_len == 7


def test_outputs_default_levels_and_enabled_only():
    assert auto_fib_outputs(CFG) == (
        "high", "low", "dir", "f0", "f0_236", "f0_382", "f0_5", "f0_618", "f0_786", "f1",
    )
    cfg = parse_auto_fib_config([5, 0], {"fib": {"levels": [
        {"value": 0.618, "enabled": True, "color": "#000"},
        {"value": 0.618, "enabled": True, "color": "#111"},
        {"value": 0.5, "enabled": False, "color": "#222"},
        {"value": -0.236, "enabled": True, "color": "#333"},
        {"value": True, "enabled": True, "color": "#444"},  # a bool is not a number
    ], "reverse": True}})
    assert auto_fib_outputs(cfg) == ("high", "low", "dir", "f0_618", "fm0_236")
    assert cfg.reverse is True


def test_all_invalid_levels_fall_back_to_defaults():
    cfg = parse_auto_fib_config([5, 0], {"fib": {"levels": [{"value": "x"}]}})
    assert auto_fib_outputs(cfg) == auto_fib_outputs(CFG)


def test_first_pair_and_replacement():
    pair_of, pairs = compute_pairs(CFG, TRI)
    assert all(p is None for p in pair_of[:10])
    assert pair_of[10] == 0  # pair index 0 is a real pair
    p0 = pairs[0]
    assert (p0.hi_idx, p0.hi_price, p0.lo_idx, p0.lo_price, p0.direction) == (4, 111, 8, 99, -1)
    assert (pairs[1].hi_idx, pairs[1].lo_idx, pairs[1].direction) == (12, 8, 1)
    assert pair_of[13] == 0 and pair_of[14] == 1


def test_outside_bar_tie():
    def mk(open_, close):
        flat = [bar(100, i) for i in range(5)]
        flat[2] = bar(close, 2, open_=open_, high=105, low=95)
        return flat
    up_of, up = compute_pairs(CFG, mk(96, 104))
    _, down = compute_pairs(CFG, mk(104, 96))
    assert len(up) == 1 and up[0].direction == 1
    assert down[0].direction == -1
    assert up_of[4] == 0


def test_swing_filter_waits_for_atr_and_uses_raw_turns():
    pair_of, pairs = compute_pairs(parse_auto_fib_config([2, 0.01], {}), TRI)
    assert pair_of[21] is None
    assert (pairs[0].hi_idx, pairs[0].lo_idx, pairs[0].direction) == (20, 16, 1)
    assert compute_pairs(parse_auto_fib_config([2, 100], {}), TRI)[1] == []


def test_series_values():
    assert auto_fib_series(CFG, "high", TRI, 1.0)[10] == 111
    assert auto_fib_series(CFG, "dir", TRI, 1.0)[10] == -1.0
    assert auto_fib_series(CFG, "f0", TRI, 1.0)[10] == 99
    assert auto_fib_series(CFG, "f0_5", TRI, 1.0)[10] == 105
    assert auto_fib_series(CFG, "f0_5", TRI, 1.0)[9] is None
    assert all(v is None for v in auto_fib_series(CFG, "fm0_236", TRI, 1.0))


def test_level_price_and_warmup():
    assert fib_level_price(110, 90, 1, False, 0) == 110
    assert fib_level_price(110, 90, -1, False, 0) == 90
    assert fib_level_price(110, 90, 1, True, 0) == 90
    assert auto_fib_warmup(parse_auto_fib_config([5, 0], {}), "f0_618") == 24
    assert auto_fib_warmup(CFG, "bogus") == 0


def test_registry_entry_and_pin():
    spec = SERIES_INDICATORS["AUTO_FIB"]
    cfg = spec.parse_config([5, 0], {"mtf": {"timeframe": "HOUR_4"}})
    assert isinstance(cfg, AutoFibConfig)
    assert spec.timeframe(cfg) == "HOUR_4"
    assert spec.timeframe(spec.parse_config([5, 0], {"mtf": {"timeframe": "chart"}})) is None
    assert spec.outputs(cfg)[:3] == ("high", "low", "dir")
