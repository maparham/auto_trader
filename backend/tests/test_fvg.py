"""FVG backend series: fair value gaps as mitigation-tracked zones. Mirrors the
frontend suite (frontend/src/lib/indicators/fvg.test.ts) — same fixtures, same
expectations — plus config-parsing/registry behavior. Exact cross-runtime parity
is separately pinned by test_indicator_parity.py."""

from dataclasses import replace
from datetime import datetime, timezone

from auto_trader.core.models import Candle
from auto_trader.indicators.fvg import (
    FvgConfig,
    fvg_outputs,
    fvg_series,
    fvg_warmup,
    parse_fvg_config,
)
from auto_trader.indicators.registry import SERIES_INDICATORS


def hl(low: float, high: float, i: int) -> Candle:
    """Bar spanning [low, high]; open/close sit inside the range."""
    return Candle(
        time=datetime.fromtimestamp(1700000000 + i * 3600, tz=timezone.utc),
        open=low + (high - low) * 0.25,
        high=high,
        low=low,
        close=low + (high - low) * 0.75,
        volume=1,
    )


def filler(n: int, frm: int, low: float = 99.5, high: float = 100.5) -> list[Candle]:
    """Identical bars — they warm ATR(14) without opening or filling anything."""
    return [hl(low, high, frm + k) for k in range(n)]


CFG = FvgConfig(min_size=0, max_bars=500, max_gaps=10)
# One bullish gap [100.5, 103] confirmed at bar 22, nothing else.
BULL_BASE = [*filler(20, 0), hl(99.5, 100.5, 20), hl(100.5, 104, 21), hl(103, 105, 22)]
# One bearish gap [97, 99.5] confirmed at bar 22, nothing else.
BEAR_BASE = [*filler(20, 0), hl(99.5, 100.5, 20), hl(96, 99.5, 21), hl(95, 97, 22)]


def points(cfg: FvgConfig, candles: list[Candle]) -> list[tuple]:
    """Zip the four output series back into per-bar tuples."""
    cols = [fvg_series(cfg, o, candles, 1.0) for o in fvg_outputs(cfg)]
    return list(zip(*cols))


def test_detects_bullish_gap():
    bars = [*BULL_BASE, *filler(3, 23, 103.5, 104.5)]
    bull_top, bull_bottom, bear_top, _ = points(CFG, bars)[-1]
    assert (bull_bottom, bull_top) == (100.5, 103)
    assert bear_top is None
    # The zone exists from its confirm bar onward, not before.
    assert points(CFG, bars)[21][0] is None
    assert points(CFG, bars)[22][0] == 103


def test_detects_bearish_gap():
    bars = [*BEAR_BASE, *filler(3, 23, 95.5, 96.5)]
    bull_top, _, bear_top, bear_bottom = points(CFG, bars)[-1]
    assert (bear_bottom, bear_top) == (97, 99.5)
    assert bull_top is None


def test_flat_range_emits_nothing():
    assert all(p == (None, None, None, None) for p in points(CFG, filler(40, 0)))


def test_skips_gap_before_atr_is_warm():
    bars = [*filler(3, 0), hl(100.5, 104, 3), hl(103, 105, 4), *filler(25, 5, 103.5, 104.5)]
    assert all(p[0] is None for p in points(CFG, bars))


def test_size_filter():
    # The gap is 2.5 wide; ATR(14) at the confirm bar is ~1.25.
    bars = [*BULL_BASE, *filler(3, 23, 103.5, 104.5)]
    assert points(replace(CFG, min_size=1), bars)[-1][0] == 103
    assert points(replace(CFG, min_size=3), bars)[-1][0] is None
    assert points(replace(CFG, min_size=0), bars)[-1][0] == 103


def test_shrinks_on_partial_fill():
    bars = [*BULL_BASE, hl(102, 104, 23), *filler(3, 24, 102.5, 103.5)]
    bull_top, bull_bottom, _, _ = points(CFG, bars)[-1]
    # The low of 102 ate the 102-103 slice; the live zone is now [100.5, 102].
    assert (bull_bottom, bull_top) == (100.5, 102)


def test_kills_gap_on_full_fill():
    exact = [*BULL_BASE, hl(100.5, 104, 23), *filler(3, 24, 102.5, 103.5)]
    through = [*BULL_BASE, hl(99, 104, 23), *filler(3, 24, 102.5, 103.5)]
    assert points(CFG, exact)[-1][0] is None
    assert points(CFG, through)[-1][0] is None


def test_creating_bar_wick_does_not_fill_its_own_gap():
    # Bar 22's low (103) IS the gap's top edge — it must not shrink it to nothing.
    bars = [*BULL_BASE, *filler(2, 23, 103.5, 104.5)]
    assert points(CFG, bars)[22][:2] == (103, 100.5)


def test_bearish_shrink_and_full_fill():
    partial = [*BEAR_BASE, hl(95, 98, 23), *filler(2, 24, 97, 98)]
    assert points(CFG, partial)[-1][2:] == (99.5, 98)
    full = [*BEAR_BASE, hl(95, 100, 23), *filler(2, 24, 96.5, 97.5)]
    assert points(CFG, full)[-1][2] is None


def test_expires_after_max_bars():
    bars = [*BULL_BASE, *filler(20, 23, 103.5, 104.5)]
    assert points(CFG, bars)[-1][0] == 103
    # Created at 22, last bar is 42 — an age of 20 exceeds max_bars 10.
    assert points(replace(CFG, max_bars=10), bars)[-1][0] is None


LADDER = [
    *BULL_BASE,
    hl(103.5, 104.5, 23),
    hl(103.5, 104.5, 24),
    hl(104.5, 108, 25),
    hl(107, 109, 26),
    *filler(3, 27, 107.5, 108.5),
]


def test_reports_nearest_gap_below_close():
    # Live: [100.5, 103] and [104.5, 107]; the close is ~108.25.
    assert points(CFG, LADDER)[-1][:2] == (107, 104.5)


def test_max_gaps_keeps_the_newest_per_side():
    assert points(replace(CFG, max_gaps=1), LADDER)[-1][:2] == (107, 104.5)


def test_close_is_never_strictly_inside_a_live_zone():
    """Load-bearing invariant: shrink-on-partial keeps a bullish zone at or below
    the close and a bearish zone at or above, which is what makes the nearest-gap
    outputs total. Mirrors the frontend suite's check."""
    for bars in (LADDER, [*BEAR_BASE, hl(95, 98, 23), *filler(3, 24, 97, 98)]):
        for candle, (_, bull_bottom, _, bear_bottom) in zip(bars, points(CFG, bars)):
            if bull_bottom is not None:
                assert bull_bottom <= candle.close
            if bear_bottom is not None:
                assert bear_bottom >= candle.close


def test_is_causal():
    full = points(CFG, LADDER)
    for cut in (23, 27, 30):
        assert points(CFG, LADDER[:cut]) == full[:cut]


def test_parse_config_defaults_and_malformed():
    assert parse_fvg_config(None, None) == FvgConfig(min_size=0.25, max_bars=500, max_gaps=10)
    # Garbage falls back per field, never raises (resolve_instances must not 500).
    assert parse_fvg_config(["x", float("nan"), None], {"whatever": 1}) == FvgConfig(
        min_size=0.25, max_bars=500, max_gaps=10
    )


def test_parse_config_accepts_zero_min_size_only():
    assert parse_fvg_config([0, 500, 10], None).min_size == 0
    # A negative min_size is nonsense, so it falls back like any other bad value.
    assert parse_fvg_config([-1, 500, 10], None).min_size == 0.25


def test_parse_config_floors_and_clamps_counts():
    cfg = parse_fvg_config([0.25, 3.7, 2.9], None)
    assert (cfg.max_bars, cfg.max_gaps) == (3, 2)
    cfg = parse_fvg_config([0.25, 0, 0], None)
    assert (cfg.max_bars, cfg.max_gaps) == (500, 10)


def test_outputs_and_warmup_and_registry():
    cfg = parse_fvg_config(None, None)
    assert fvg_outputs(cfg) == ("bull_top", "bull_bottom", "bear_top", "bear_bottom")
    assert fvg_warmup(cfg, "bull_top") == 16
    assert fvg_warmup(cfg, "nope") == 0
    spec = SERIES_INDICATORS["FVG"]
    assert spec.outputs(cfg) == ("bull_top", "bull_bottom", "bear_top", "bear_bottom")
    assert spec.timeframe(cfg) is None


def test_mtf_timeframe_pin():
    cfg = parse_fvg_config(None, {"mtf": {"timeframe": "HOUR_4"}})
    assert cfg.timeframe == "HOUR_4"
    assert SERIES_INDICATORS["FVG"].timeframe(cfg) == "HOUR_4"
    # "chart", None, or malformed -> no pin.
    assert parse_fvg_config(None, {"mtf": {"timeframe": "chart"}}).timeframe is None
    assert parse_fvg_config(None, {"mtf": {"timeframe": None}}).timeframe is None
    assert parse_fvg_config(None, {"mtf": "junk"}).timeframe is None
    assert parse_fvg_config(None, None).timeframe is None
