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
    forming_pivot_at,
    forming_pivots,
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


def _forming_closes():
    # A sharp drop to a first low, a rebound, then a slow drop to a lower low
    # with a higher RSI, then 2 rising bars: the second low is a forming pivot
    # (2 right bars) that the 5-bar confirmation has not reached yet.
    closes = [100 + (i % 7) * 0.3 for i in range(80)]
    p = closes[-1]
    for step, k in ((-3, 5), (2, 8), (-1, 20), (1.5, 2)):
        for _ in range(k):
            p += step
            closes.append(p)
    return closes


def _close_bars(closes):
    return [Candle(time=datetime.fromtimestamp(1700000000 + i * 3600, tz=timezone.utc),
                   open=c, high=c + 0.5, low=c - 0.5, close=c, volume=0) for i, c in enumerate(closes)]


def test_forming_bull_divergence_holds_on_the_tail_before_confirmation():
    candles = _close_bars(_forming_closes())
    cfg = parse_rsi_config([14], {"divergence": {"on": True}})
    forming = rsi_pane_series(cfg, "bullDivForming", candles, 1.0)
    confirmed = rsi_pane_series(cfg, "bullDiv", candles, 1.0)
    last = len(candles) - 1
    assert forming[last] == 1.0 and forming_pivot_at(candles, cfg, "bullDivForming", last) == last - 2
    assert confirmed[-10:] == [0.0] * 10


def test_forming_series_never_reads_ahead():
    # Every bar's value is what the chart would draw with only bars up to it.
    random.seed(7)
    p, closes = 100.0, []
    for _ in range(400):
        p += random.uniform(-1, 1)
        closes.append(p)
    candles = _close_bars(closes)
    cfg = parse_rsi_config([14], {"divergence": {"lookbackLeft": 3, "lookbackRight": 4, "formingLookbackRight": 1}})
    for out in ("bullDivForming", "bearDivForming", "hBullDivForming", "hBearDivForming"):
        full = rsi_pane_series(cfg, out, candles, 1.0)
        assert any(v == 1.0 for v in full)
        for t in range(100, 400, 7):
            assert rsi_pane_series(cfg, out, candles[:t + 1], 1.0)[t] == full[t]


def test_forming_lookback_right_is_clamped_below_the_confirmed_one():
    assert parse_rsi_config([14], {"divergence": {"lookbackRight": 3, "formingLookbackRight": 9}}).forming_lookback_right == 2
    assert parse_rsi_config([14], {"divergence": {"formingLookbackRight": 0}}).forming_lookback_right == 0
    assert parse_rsi_config(None, None).forming_lookback_right == 2


def test_scan_back_stops_where_the_chart_does_for_every_enabled_kind():
    # The chart's forming scan stops at the first tail swing that diverges for
    # ANY enabled kind of the side, so bull and hidden bull can never hold on
    # two different swings at once.
    random.seed(0)  # holds a bull and a hidden bull tail swing at bars 282-284
    p, closes = 100.0, []
    for _ in range(600):
        p += random.uniform(-1, 1)
        closes.append(p)
    candles = _close_bars(closes)
    cfg = parse_rsi_config([14], {"divergence": {
        "hiddenBullish": True, "hiddenBearish": True, "formingLookbackRight": 0, "formingScanBack": True}})
    rsi = rsi_series_for(cfg, candles)
    for a, b in (("bullish", "hiddenBullish"), ("bearish", "hiddenBearish")):
        pa, pb = forming_pivots(candles, rsi, cfg, a), forming_pivots(candles, rsi, cfg, b)
        both = [t for t in range(len(candles)) if pa[t] is not None and pb[t] is not None]
        assert all(pa[t] == pb[t] for t in both)
        assert any(x is not None for x in pa) and any(x is not None for x in pb)
