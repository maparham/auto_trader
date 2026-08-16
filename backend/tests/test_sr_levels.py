"""SR_LEVELS backend series: clustered-pivot support/resistance. Mirrors the
frontend suite (frontend/src/lib/indicators/srLevels.test.ts) — same triangle
fixture, same expectations — plus config-parsing/registry behavior. Exact
cross-runtime parity is separately pinned by test_indicator_parity.py."""

from datetime import datetime, timezone

from auto_trader.core.models import Candle
from auto_trader.indicators.registry import SERIES_INDICATORS
from auto_trader.indicators.sr_levels import (
    SrConfig,
    parse_sr_config,
    sr_outputs,
    sr_series,
    sr_warmup,
)


def bar(close: float, i: int) -> Candle:
    return Candle(
        time=datetime.fromtimestamp(1700000000 + i * 3600, tz=timezone.utc),
        open=close,
        high=close + 1,
        low=close - 1,
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


CFG = SrConfig(pivot_len=2, atr_mult=0.5, min_touches=2, max_levels=8, max_bars=500)
CANDLES = triangle([110, 110, 110, 110])


def test_series_length_and_gating():
    sup = sr_series(CFG, "support", CANDLES, 1.0)
    res = sr_series(CFG, "resistance", CANDLES, 1.0)
    assert len(sup) == len(CANDLES) == len(res)
    # Single touch is not major yet.
    assert res[21] is None
    assert sup[21] is None


def test_nearest_levels_once_major():
    sup = sr_series(CFG, "support", CANDLES, 1.0)
    res = sr_series(CFG, "resistance", CANDLES, 1.0)
    # Second high touch (pivot at 20) confirms at bar 22; second low at bar 26.
    assert res[22] == 111
    assert sup[26] == 99
    assert res[-1] == 111
    assert sup[-1] == 99


def test_clusters_average_nearby_pivots():
    wobbly = triangle([110, 110.4, 109.8, 110])
    res = sr_series(CFG, "resistance", wobbly, 1.0)
    assert res[-1] is not None
    assert abs(res[-1] - (111.4 + 110.8 + 111) / 3) < 1e-10


def test_parse_config_defaults_and_malformed():
    cfg = parse_sr_config(None, None)
    assert cfg == SrConfig(pivot_len=15, atr_mult=0.5, min_touches=2, max_levels=8, max_bars=500)
    cfg = parse_sr_config([2, 0.5, 2, 8, 500], {})
    assert cfg.pivot_len == 2 and cfg.atr_mult == 0.5
    # Garbage falls back per-field, never raises (resolve_instances must not 500).
    cfg = parse_sr_config(["x", float("nan"), -3, 0, None], {"whatever": 1})
    assert cfg == SrConfig(pivot_len=15, atr_mult=0.5, min_touches=2, max_levels=8, max_bars=500)


def test_outputs_and_warmup_and_registry():
    cfg = parse_sr_config(None, None)
    assert sr_outputs(cfg) == ("support", "resistance")
    # Needs ATR(14) warm plus a full pivot window before the first touch can exist.
    assert sr_warmup(cfg, "support") == 14 + 2 * cfg.pivot_len
    assert sr_warmup(cfg, "nope") == 0
    spec = SERIES_INDICATORS["SR_LEVELS"]
    assert spec.outputs(cfg) == ("support", "resistance")
    assert spec.timeframe(cfg) is None


def test_mtf_timeframe_pin():
    # The settings pin rides extendData.mtf.timeframe (same as SLOPE); the spec
    # exposes it so the evaluator computes on that timeframe's candles.
    cfg = parse_sr_config(None, {"mtf": {"timeframe": "HOUR_4"}})
    assert cfg.timeframe == "HOUR_4"
    assert SERIES_INDICATORS["SR_LEVELS"].timeframe(cfg) == "HOUR_4"
    # "chart", None, or malformed → no pin.
    assert parse_sr_config(None, {"mtf": {"timeframe": "chart"}}).timeframe is None
    assert parse_sr_config(None, {"mtf": {"timeframe": None}}).timeframe is None
    assert parse_sr_config(None, {"mtf": "junk"}).timeframe is None
    assert parse_sr_config(None, None).timeframe is None
