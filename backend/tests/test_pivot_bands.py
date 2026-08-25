"""PIVOT_BANDS backend series: fractal swing-high/low step-lines. Mirrors the
frontend suite (frontend/src/lib/indicators/pivotBands.test.ts) — same shape of
expectations — plus config-parsing/registry behavior."""

from datetime import datetime, timezone

from auto_trader.core.models import Candle
from auto_trader.indicators.pivot_bands import (
    PivotBandsConfig,
    parse_pivot_bands_config,
    pivot_bands_outputs,
    pivot_bands_series,
    pivot_bands_warmup,
)
from auto_trader.indicators.registry import SERIES_INDICATORS


def bar(i: int, low: float, high: float) -> Candle:
    return Candle(
        time=datetime.fromtimestamp(1700000000 + i * 3600, tz=timezone.utc),
        open=low, high=high, low=low, close=high, volume=1,
    )


def flat(n: int, frm: int, low: float = 99.0, high: float = 101.0) -> list[Candle]:
    return [bar(frm + k, low, high) for k in range(n)]


def points(cfg: PivotBandsConfig, candles: list[Candle]) -> list[tuple]:
    """The two step-line columns only (the bars-since outputs have their own
    tests below), so these tuples stay (pivotHigh, pivotLow)."""
    cols = [pivot_bands_series(cfg, o, candles, 1.0) for o in ("pivotHigh", "pivotLow")]
    return list(zip(*cols))


def bars_since(cfg: PivotBandsConfig, candles: list[Candle], side: str) -> list:
    return pivot_bands_series(cfg, f"barsSince{side}", candles, 1.0)


CFG = PivotBandsConfig(n=2, k=3, mode="last", source=None)


def test_no_pivot_before_enough_bars():
    bars = flat(4, 0)
    assert points(CFG, bars) == [(None, None)] * 4


def test_confirms_a_swing_high_two_bars_later():
    # bar 2 is a strict swing high over window n=2: bars 0,1,3,4 all lower highs.
    bars = [
        bar(0, 99, 100), bar(1, 99, 100.5),
        bar(2, 99, 105),
        bar(3, 99, 100.5), bar(4, 99, 100),
        *flat(3, 5),
    ]
    pts = points(CFG, bars)
    # Confirms at i + n = 4; flat before, stepped from there on.
    assert pts[3][0] is None
    assert pts[4][0] == 105
    assert pts[7][0] == 105


def test_confirms_a_swing_low_two_bars_later():
    bars = [
        bar(0, 99, 100), bar(1, 98.5, 100),
        bar(2, 90, 100),
        bar(3, 98.5, 100), bar(4, 99, 100),
        *flat(3, 5),
    ]
    pts = points(CFG, bars)
    assert pts[3][1] is None
    assert pts[4][1] == 90
    assert pts[7][1] == 90


def test_flat_extremes_do_not_confirm_strict_mode():
    # A tie with a neighbour on the SAME side disqualifies a strict pivot.
    bars = [bar(0, 99, 100), bar(1, 99, 105), bar(2, 99, 105), bar(3, 99, 100), *flat(3, 4)]
    pts = points(CFG, bars)
    assert all(p[0] is None for p in pts)


def test_avg_mode_averages_the_newest_k_pivots():
    # Three ascending swing highs at bars 2, 6, 10 (n=2, so each needs isolation
    # over its 2-bar window); avg over the newest k=2.
    bars = (
        [bar(0, 99, 100), bar(1, 99, 100.5), bar(2, 99, 110),
         bar(3, 99, 100.5), bar(4, 99, 100)]
        + [bar(5, 99, 100), bar(6, 99, 120), bar(7, 99, 100), bar(8, 99, 99.5)]
        + [bar(9, 99, 100), bar(10, 99, 130), bar(11, 99, 100), bar(12, 99, 99.5)]
        + flat(2, 13)
    )
    cfg = PivotBandsConfig(n=2, k=2, mode="avg", source=None)
    pts = points(cfg, bars)
    # After only the first pivot (110) confirms: avg of just that one.
    assert pts[4][0] == 110
    # After the second (120) confirms: avg(110, 120).
    assert pts[8][0] == 115
    # After the third (130) confirms: avg of the newest 2 -> (120, 130).
    assert pts[12][0] == 125


def test_parse_config_defaults_and_clamping():
    cfg = parse_pivot_bands_config([], {})
    assert (cfg.n, cfg.k, cfg.mode, cfg.source, cfg.timeframe) == (5, 3, "last", None, None)

    cfg = parse_pivot_bands_config([10, 3], {"mode": "avg"})
    assert (cfg.n, cfg.k, cfg.mode) == (10, 3, "avg")

    # Garbage/zero falls back to the default, matching Number(x) || default.
    cfg = parse_pivot_bands_config(["x", 0], {})
    assert (cfg.n, cfg.k) == (5, 3)

    cfg = parse_pivot_bands_config([], {"mtf": {"timeframe": "HOUR_4"}})
    assert cfg.timeframe == "HOUR_4"
    cfg = parse_pivot_bands_config([], {"mtf": {"timeframe": "chart"}})
    assert cfg.timeframe is None


def test_outputs_are_the_four_fixed_names():
    assert pivot_bands_outputs(CFG) == ("pivotHigh", "pivotLow", "barsSinceHigh", "barsSinceLow")


# --- barsSinceHigh / barsSinceLow -------------------------------------------
# Mirrors frontend/src/lib/indicators/pivotBarsSince.test.ts: the count is taken
# from the PIVOT BAR, so it steps down to N (never 0) at each confirmation.


def two_swing_highs() -> list[Candle]:
    """Swing highs at bars 5 and 9 (n=2), nothing else extreme."""
    highs = {5: 100.0, 9: 105.0}
    return [bar(i, 80.0, highs.get(i, 90.0)) for i in range(14)]


def test_bars_since_is_none_until_the_first_pivot_confirms():
    col = bars_since(CFG, two_swing_highs(), "High")
    assert col[:7] == [None] * 7  # pivot at bar 5 confirms at bar 7
    assert col[7] == 2


def test_bars_since_counts_from_the_pivot_bar_never_below_n():
    col = bars_since(CFG, two_swing_highs(), "High")
    # First pivot (bar 5) confirms at 7 and the count climbs one per bar...
    assert col[7:11] == [2, 3, 4, 5]
    # ...then the second (bar 9) confirms at 11: back to N, NOT to 0.
    assert col[11:14] == [2, 3, 4]
    assert all(v >= CFG.n for v in col if v is not None)


def test_bars_since_tracks_the_two_sides_independently():
    # Swing high at bar 4 (confirms 6), swing low at bar 9 (confirms 11).
    candles = [
        bar(i, 70.0 if i == 9 else 80.0, 100.0 if i == 4 else 90.0) for i in range(14)
    ]
    assert bars_since(CFG, candles, "High")[11] == 7  # 11 - 4
    assert bars_since(CFG, candles, "Low")[11] == 2  # 11 - 9


def test_unknown_output_yields_no_series_rather_than_the_wrong_one():
    # The dispatch is by NAME: a typo must not silently return pivotLow.
    assert pivot_bands_series(CFG, "bogus", two_swing_highs(), 1.0) == [None] * 14


def test_warmup_is_the_confirm_lag():
    cfg = PivotBandsConfig(n=7, k=3, mode="last", source=None)
    assert pivot_bands_warmup(cfg, "pivotHigh") == 7
    assert pivot_bands_warmup(cfg, "pivotLow") == 7
    assert pivot_bands_warmup(cfg, "barsSinceHigh") == 7
    assert pivot_bands_warmup(cfg, "barsSinceLow") == 7
    assert pivot_bands_warmup(cfg, "bogus") == 0


def test_registered_in_series_indicators():
    assert "PIVOT_BANDS" in SERIES_INDICATORS
