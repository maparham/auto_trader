"""RSI divergence rule outputs. The detector fixtures mirror the frontend suite
(frontend/src/lib/rsiDivergence.test.ts) so both stacks agree on which pairs
diverge; the event series adds the no-lookahead shift (fire at pivot + lbR)."""

import random
from dataclasses import replace
from datetime import datetime, timezone

from auto_trader.core.models import Candle
from auto_trader.indicators.registry import SERIES_INDICATORS, resolve_instances
from auto_trader.indicators.rsi import (
    RSI_OUTPUTS,
    RsiConfig,
    divergence_pivots,
    parse_rsi_config,
    rsi_pane_series,
    rsi_series_for,
    rsi_warmup,
)


def bars(n: int, highs: dict[int, float] | None = None, lows: dict[int, float] | None = None) -> list[Candle]:
    highs, lows = highs or {}, lows or {}
    out = []
    for i in range(n):
        h, lo = highs.get(i, 90.0), lows.get(i, 10.0)
        out.append(Candle(time=datetime.fromtimestamp(1700000000 + i * 3600, tz=timezone.utc),
                          open=h, high=h, low=lo, close=h, volume=0))
    return out


CFG = RsiConfig(lookback_left=2, lookback_right=3, range_min=2, range_max=60, pivot_depth=3)


def test_regular_bearish_matches_frontend_fixture():
    rsi = [40, 41, 42, 43, 45, 60, 45, 44, 43, 44, 46, 50, 55, 50, 48, 49, 52, 48]
    got = divergence_pivots(bars(18, highs={5: 100, 12: 105, 16: 108}), rsi, CFG, "bearish")
    # 16 sits in the unconfirmed tail (16 + 3 >= 18), so only 5 -> 12.
    assert got == [(5, 12)]


def test_regular_bullish_matches_frontend_fixture():
    rsi = [50, 49, 48, 47, 45, 20, 45, 46, 47, 46, 44, 30, 25, 30, 32, 31, 28, 33, 40, 41]
    got = divergence_pivots(bars(20, lows={5: 100, 12: 95, 16: 92}), rsi, CFG, "bullish")
    assert got == [(5, 12), (12, 16)]


# Low pivots (lb 1/1): A at 2, a small swing B at 5, then C at 8. C vs A is hidden bullish.
RSI_D = [40, 35, 30, 45, 55, 50, 55, 40, 28, 40, 45]
LOWS_D = {2: 100, 5: 110, 8: 105}
CFG_D = RsiConfig(lookback_left=1, lookback_right=1, range_min=2, range_max=60, pivot_depth=3)


def test_depth_one_only_checks_latest_pivot():
    got = divergence_pivots(bars(11, lows=LOWS_D), RSI_D, replace(CFG_D, pivot_depth=1), "hiddenBullish")
    assert got == []


def test_depth_looks_past_small_swing():
    assert divergence_pivots(bars(11, lows=LOWS_D), RSI_D, CFG_D, "hiddenBullish") == [(2, 8)]


def test_pierced_line_rejects_older_pivot():
    rsi = list(RSI_D)
    rsi[5] = 25  # B dips below the A -> C line (B vs A is its own hidden bull)
    assert divergence_pivots(bars(11, lows=LOWS_D), rsi, CFG_D, "hiddenBullish") == [(2, 5)]


def test_event_fires_on_confirming_bar_not_pivot():
    # A seeded random walk yields real RSI pivots; whatever the detector finds,
    # each 1.0 must sit exactly lookback_right bars after it.
    rng = random.Random(7)
    closes = [100.0]
    for _ in range(299):
        closes.append(closes[-1] + rng.uniform(-2, 2))
    candles = [Candle(time=datetime.fromtimestamp(1700000000 + i * 3600, tz=timezone.utc),
                      open=c, high=c + 1, low=c - 1, close=c, volume=0) for i, c in enumerate(closes)]
    cfg = RsiConfig(length=5, lookback_left=2, lookback_right=2, range_min=2, range_max=60)
    rsi = rsi_series_for(cfg, candles)
    for output, kind in (("bullDiv", "bullish"), ("bearDiv", "bearish"),
                         ("hBullDiv", "hiddenBullish"), ("hBearDiv", "hiddenBearish")):
        ev = rsi_pane_series(cfg, output, candles, 1.0)
        want = {to + cfg.lookback_right for _, to in divergence_pivots(candles, rsi, cfg, kind)}
        assert {i for i, v in enumerate(ev) if v == 1.0} == want
        assert all(ev[i] is None for i in range(cfg.length))
    assert any(v == 1.0 for o in ("bullDiv", "bearDiv", "hBullDiv", "hBearDiv")
               for v in rsi_pane_series(cfg, o, candles, 1.0))


def test_parse_merges_defaults_and_clamps():
    cfg = parse_rsi_config([21], {"source": "hl2", "divergence": {"lookbackLeft": 0, "rangeMin": 10, "rangeMax": 3}})
    assert cfg == RsiConfig(length=21, source="hl2", lookback_left=1, lookback_right=5,
                            range_min=10, range_max=10, pivot_depth=3)
    assert parse_rsi_config(None, None) == RsiConfig()


def test_registry_and_warmup():
    inst = resolve_instances({"RSI": {"type": "RSI", "calcParams": [14], "extendData": {}}})["RSI"]
    assert inst.spec is SERIES_INDICATORS["RSI"]
    assert inst.spec.outputs(inst.config) == RSI_OUTPUTS
    assert rsi_warmup(RsiConfig(), "value") == 14
    assert rsi_warmup(RsiConfig(), "bullDiv") == 14 + 60 + 5 + 5
    assert rsi_warmup(RsiConfig(), "nope") == 0
