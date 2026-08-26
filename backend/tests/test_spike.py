"""SPIKE backend series: spike -> flat consolidation -> retrace state machine.
Mirrors the frontend suite (frontend/src/lib/indicators/spike.test.ts) — same
shape of expectations — plus config-parsing/registry behavior."""

from datetime import datetime, timezone

import pytest

from auto_trader.core.models import Candle
from auto_trader.indicators.registry import SERIES_INDICATORS
from auto_trader.indicators.spike import (
    SPIKE_OUTPUTS,
    SpikeConfig,
    parse_spike_config,
    spike_outputs,
    spike_series,
    spike_warmup,
)


def bar(i: int, low: float, high: float) -> Candle:
    return Candle(
        time=datetime.fromtimestamp(1700000000 + i * 3600, tz=timezone.utc),
        open=low, high=high, low=low, close=high, volume=1,
    )


def flat(n: int, frm: int, low: float = 100.0, high: float = 101.0) -> list[Candle]:
    return [bar(frm + k, low, high) for k in range(n)]


CFG = SpikeConfig(spike_bars=3, min_spike_pct=5.0, flat_bars=3, max_flat_range_pct=20.0)


def col(candles: list[Candle], output: str) -> list:
    return spike_series(CFG, output, candles, 1.0)


# Spike at bar 3: window lows over bars 1..3 bottom out at 100, high 106 is a
# +6% rise (>= 5%) within spike_bars=3. Height 6, flat floor 106 - 20% * 6 = 104.8.
SPIKE_BARS = [*flat(3, 0), bar(3, 100.5, 106)]

# Three in-band bars after the spike (no new high, lows >= 104.8) latch consolOk.
CONSOL_BARS = [*SPIKE_BARS, bar(4, 105, 106), bar(5, 105, 105.8), bar(6, 105.2, 105.9)]


def test_idle_before_any_spike_is_all_none():
    bars = flat(4, 0)
    for output in SPIKE_OUTPUTS:
        assert col(bars, output) == [None] * 4


def test_spike_detection_sets_anchors_at_the_spike_bar():
    assert col(SPIKE_BARS, "spikeHigh")[:3] == [None] * 3
    assert col(SPIKE_BARS, "spikeHigh")[3] == 106
    assert col(SPIKE_BARS, "spikeLow")[3] == 100
    assert col(SPIKE_BARS, "barsSinceSpike")[3] == 0
    assert col(SPIKE_BARS, "consolOk")[3] == 0
    # Current-bar dip as % of spike height: (106 - 100.5) / 6.
    assert col(SPIKE_BARS, "retracePct")[3] == pytest.approx(91.6667, abs=1e-3)
    assert col(SPIKE_BARS, "maxRetracePct")[3] == 0


def test_small_rise_does_not_arm():
    bars = [*flat(3, 0), bar(3, 100.5, 104)]  # +4% < 5%
    assert col(bars, "spikeHigh") == [None] * 4


def test_consolidation_latches_after_flat_bars():
    ok = col(CONSOL_BARS, "consolOk")
    assert ok[3:] == [0, 0, 0, 1]
    assert col(CONSOL_BARS, "barsSinceSpike")[6] == 3
    assert col(CONSOL_BARS, "spikeHigh")[6] == 106


def test_dip_below_flat_band_before_latch_voids_the_pattern():
    # Bar 4 low 103 < flat floor 104.8 with consolOk still 0; its own window
    # (rise 104 vs low 100 = +4%) does not re-arm.
    bars = [*SPIKE_BARS, bar(4, 103, 104)]
    assert col(bars, "spikeHigh")[4] is None
    assert col(bars, "consolOk")[4] is None


def test_new_high_extends_the_spike_and_restarts_the_clock():
    # Bar 5's window (bars 3..5) still bottoms at bar 3's low 100.5, so the
    # rise to 107 is +6.5% — steep, a true extension.
    bars = [*SPIKE_BARS, bar(4, 105, 106), bar(5, 105, 107)]
    assert col(bars, "spikeHigh")[5] == 107
    assert col(bars, "spikeLow")[5] == 100
    assert col(bars, "barsSinceSpike")[5] == 0
    assert col(bars, "consolOk")[5] == 0


def test_non_steep_new_high_ends_the_pattern_instead_of_extending():
    # Consolidation latches over bars 4..6, whose lows lift the trailing
    # window off the spike base. Bar 7's marginal new high 106.5 rises only
    # +1.4% from its own window low 105 — a grind, not a spike leg — so the
    # pattern dies rather than inflating (and the same failed check keeps the
    # bar from re-arming).
    bars = [*CONSOL_BARS, bar(7, 105.5, 106.5)]
    for output in SPIKE_OUTPUTS:
        assert col(bars, output)[7] is None


def test_retrace_after_latch_tracks_current_and_max_depth():
    # Post-latch dips below the FLAT band are fine — the tradeable retrace —
    # as long as they hold the (deeper) Max Retrace floor. CFG's default
    # max_retrace_pct 70 puts that floor at 101.8, so lows 104 / 104.5 track.
    bars = [*CONSOL_BARS, bar(7, 104, 105), bar(8, 104.5, 105.5)]
    retrace = col(bars, "retracePct")
    max_retrace = col(bars, "maxRetracePct")
    assert retrace[7] == pytest.approx(33.3333, abs=1e-3)  # (106-104)/6
    assert retrace[8] == pytest.approx(25.0, abs=1e-3)
    assert max_retrace[7] == pytest.approx(33.3333, abs=1e-3)
    assert max_retrace[8] == pytest.approx(33.3333, abs=1e-3)  # deepest so far
    assert col(bars, "consolOk")[8] == 1  # latched through the dip


def test_dip_below_max_retrace_after_latch_invalidates():
    # Max Retrace is the post-latch hard floor: a dip past it means the bull
    # continuation is no longer high-probability, so the pattern dies. With
    # max_retrace_pct=30 the floor is 104.2; bar 7's low 104 crosses it.
    cfg = SpikeConfig(3, 5.0, 3, 20.0, 60, max_retrace_pct=30.0)
    bars = [*CONSOL_BARS, bar(7, 104, 105)]
    for output in SPIKE_OUTPUTS:
        assert spike_series(cfg, output, bars, 1.0)[7] is None


def test_break_below_spike_low_invalidates():
    # Bar 7 low 99.5 < spikeLow 100; its own window (104 vs 99.5 = +4.5%)
    # does not immediately re-arm.
    bars = [*CONSOL_BARS, bar(7, 99.5, 104)]
    for output in SPIKE_OUTPUTS:
        assert col(bars, output)[7] is None


def test_base_anchors_to_the_nearest_qualifying_swing_low():
    # Window reaches the old deep low 95, but a real pullback-up (bar 1, low
    # 101) separates it from the spike leg. The base walk stops at that
    # pullback: spikeLow anchors to the leg's own low 98, not the stale 95 —
    # matching the swing low a fib drawn over the leg would use.
    cfg = SpikeConfig(6, 5.0, 3, 20.0, 60)
    bars = [bar(0, 95, 96), bar(1, 101, 102), bar(2, 98.5, 99.5), bar(3, 98, 106)]
    assert spike_series(cfg, "spikeLow", bars, 1.0)[3] == 98
    assert spike_series(cfg, "spikeHigh", bars, 1.0)[3] == 106


def test_base_walk_extends_through_the_basing_region():
    # Qualification needs lookback (rise from bar 1's low), and the walk keeps
    # absorbing bars that stay near the running low — base is the full basing
    # region's low, same as the old window minimum when no pullback separates.
    cfg = SpikeConfig(6, 5.0, 3, 20.0, 60)
    bars = [bar(0, 100, 101), bar(1, 100, 101), bar(2, 100.5, 103), bar(3, 102, 105.5)]
    assert spike_series(cfg, "spikeLow", bars, 1.0)[3] == 100
    assert spike_series(cfg, "spikeHigh", bars, 1.0)[3] == 105.5


def test_pattern_expires_after_max_pattern_bars():
    cfg = SpikeConfig(3, 5.0, 3, 20.0, max_pattern_bars=5)
    # Spike at bar 3; bars 4..8 hold the flat band, so nothing else resets the
    # machine — at age 5 (bar 8) the pattern expires and the in-band bars
    # cannot re-arm (+1% < 5%).
    bars = [*SPIKE_BARS, *flat(5, 4, 105, 106)]
    s = spike_series(cfg, "spikeHigh", bars, 1.0)
    assert s[7] == 106  # age 4: still armed
    assert s[8] is None  # age 5: expired


def test_expiry_frees_a_new_spike_to_arm_with_fresh_anchors():
    cfg = SpikeConfig(3, 5.0, 3, 20.0, max_pattern_bars=4)
    # First spike at bar 3 expires at bar 7 (age 4). Bar 9's high 111 then arms
    # a NEW spike from its own trailing window (low 105). Without expiry the
    # old pattern would still be armed and 111 would EXTEND it, keeping
    # spikeLow 100 — the stale-anchor bug this parameter exists to fix.
    bars = [*SPIKE_BARS, *flat(4, 4, 105, 106), bar(8, 105, 105.5), bar(9, 105.5, 111)]
    assert spike_series(cfg, "spikeHigh", bars, 1.0)[8] is None
    assert spike_series(cfg, "spikeLow", bars, 1.0)[9] == 105
    assert spike_series(cfg, "spikeHigh", bars, 1.0)[9] == 111
    assert spike_series(cfg, "barsSinceSpike", bars, 1.0)[9] == 0


def test_parse_config_defaults_and_clamping():
    assert parse_spike_config(None, None) == SpikeConfig(5, 2.0, 5, 15.0, 60, 70.0)
    assert parse_spike_config([3, 5, 3, 20], None) == CFG
    assert parse_spike_config([3, 5, 3, 20, 50, 55], None) == SpikeConfig(3, 5.0, 3, 20.0, 50, 55.0)
    # Zero / negative / junk all fall back to defaults.
    assert parse_spike_config([0, -1, "x", 0, 0, -3], None) == SpikeConfig(5, 2.0, 5, 15.0, 60, 70.0)


def test_outputs_and_warmup():
    assert spike_outputs(CFG) == SPIKE_OUTPUTS
    assert SPIKE_OUTPUTS[0] == "spikeHigh"
    # Window plus pattern lifetime: state at a bar can depend on a pattern that
    # armed up to max_pattern_bars earlier, itself needing its trailing window.
    assert spike_warmup(CFG, "retracePct") == 3 + 60
    assert spike_warmup(CFG, "nope") == 0


def test_registered_in_series_indicators():
    spec = SERIES_INDICATORS["SPIKE"]
    cfg = spec.parse_config([3, 5, 3, 20], None)
    assert spec.outputs(cfg) == SPIKE_OUTPUTS
    assert spec.timeframe(cfg) is None
    bars = [*CONSOL_BARS, bar(7, 104.9, 105.4)]
    assert spec.series(cfg, "maxRetracePct", bars, 1.0)[7] == pytest.approx(18.3333, abs=1e-3)
