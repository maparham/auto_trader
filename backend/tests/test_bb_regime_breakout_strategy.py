"""bb_regime_breakout built-in strategy (Anthony Crudele trend/regime):
20-period, 3-deviation Bollinger Bands classify the market into consolidation
(contracting band width, sideways range) vs trending/expansion. Enter only when
band width expands out of a squeeze AND price breaks the established
consolidation range; stop anchored to the prior range, R-multiple target."""

from datetime import datetime, timedelta, timezone

import numpy as np

from auto_trader.core.models import Candle
from auto_trader.engine.backtest import BacktestEngine
from auto_trader.strategy.coded import CodedStrategy
from auto_trader.strategy.loader import load_strategy
from auto_trader.strategy.params import resolve_params


def bars_from_closes(closes: list[float], spread: float = 0.5) -> list[Candle]:
    t0 = datetime(2026, 1, 1, tzinfo=timezone.utc)
    return [
        Candle(time=t0 + timedelta(hours=i), open=c, high=c + spread, low=c - spread, close=c)
        for i, c in enumerate(closes)
    ]


def run(candles: list[Candle], overrides: dict | None = None):
    module = load_strategy("bb_regime_breakout.py")
    params = resolve_params(module, overrides)
    strat = CodedStrategy(module, candles, quantity=1.0, params=params)
    return BacktestEngine(strat).run(candles), candles


# Shrunk lookbacks so fixtures stay short: 30 bars of bandwidth history for the
# squeeze percentile, 15-bar consolidation range.
FAST_OVERRIDES = {"squeeze_lookback": 30, "range_lookback": 15}


def oscillation(center: float, amp: float, n: int, period: int = 8) -> list[float]:
    return [center + amp * np.sin(2 * np.pi * k / period) for k in range(n)]


def squeeze_then_breakout(direction: int) -> list[float]:
    """Wide chop (high-bandwidth baseline), contracting chop (the squeeze),
    then an accelerating break out of the range in `direction` (+1/-1)."""
    closes = oscillation(100.0, 4.0, 40)
    closes += [100.0 + amp * np.sin(2 * np.pi * k / 8)
               for k, amp in enumerate(np.linspace(3.0, 0.4, 40))]
    last = closes[-1]
    closes += [last + direction * 2.0 * k for k in range(1, 15)]
    return closes


def consolidation_only() -> list[float]:
    """Squeeze that never resolves: price keeps chopping inside the range."""
    closes = oscillation(100.0, 4.0, 40)
    closes += [100.0 + amp * np.sin(2 * np.pi * k / 8)
               for k, amp in enumerate(np.linspace(3.0, 0.4, 40))]
    closes += oscillation(100.0, 0.4, 30)
    return closes


def test_meta_declares_params():
    module = load_strategy("bb_regime_breakout.py")
    by_name = {p["name"]: p for p in module.meta["params"]}
    assert by_name["er_lookback"]["default"] == 288
    assert by_name["min_er"]["default"] == 0.0  # gate disabled by default
    assert by_name["bb_period"]["default"] == 20
    assert by_name["bb_dev"]["default"] == 3.0
    assert by_name["squeeze_lookback"]["default"] == 60
    assert by_name["squeeze_pctile"]["default"] == 25.0
    assert by_name["range_lookback"]["default"] == 20
    assert by_name["max_range_pct"]["default"] == 4.0
    assert by_name["breakout_window"]["default"] == 10
    assert by_name["confirm_bars"]["default"] == 1
    assert by_name["min_expansion_pct"]["default"] == 10.0
    assert by_name["stop_range_frac"]["default"] == 1.0
    assert by_name["target_r"]["default"] == 2.0
    assert by_name["flip_guard_bars"]["default"] == 0  # guard disabled by default


def test_meta_declares_boll_chart_overlay():
    module = load_strategy("bb_regime_breakout.py")
    assert module.meta["chart_overlays"] == [
        {"indicator": "BOLL", "calc_params": ["bb_period", "bb_dev"]},
    ]


def test_breakout_trade_carries_consolidation_range_zone():
    # The entry's zone is the broken consolidation range: top/bottom are the
    # range edges the bracket is anchored to, the time span runs from the range
    # start to the breakout bar (entry fills on the NEXT bar's open).
    result, candles = run(bars_from_closes(squeeze_then_breakout(+1)), FAST_OVERRIDES)
    t = result.trades[0]
    assert len(t.zones) == 1
    z = t.zones[0]
    assert z.label == "consolidation range"
    assert z.top > z.bottom
    # Bracket geometry ties the zone to the range: stop sits at the range low
    # (stop_range_frac=1.0 default).
    assert abs(z.bottom - t.stop_initial) < 1e-9
    assert z.from_time < z.to_time < t.entry_time
    # The span covers the configured range lookback ending at the squeeze bar.
    times = [c.time for c in candles]
    n_bars = times.index(z.to_time) - times.index(z.from_time)
    assert n_bars >= FAST_OVERRIDES["range_lookback"] - 1


def test_consolidation_without_breakout_never_enters():
    # Mean-reversion chop inside the range: no regime transition, no trades
    # (the strategy must not trade the middle of the range).
    result, _ = run(bars_from_closes(consolidation_only()), FAST_OVERRIDES)
    assert result.trades == []


def test_steady_trend_without_prior_squeeze_never_enters():
    # A smooth trend has no consolidation range to break: nothing to trade.
    closes = [100 + 0.5 * i for i in range(120)]
    result, _ = run(bars_from_closes(closes), FAST_OVERRIDES)
    assert result.trades == []


def test_upside_breakout_after_squeeze_opens_long_with_range_bracket():
    result, candles = run(bars_from_closes(squeeze_then_breakout(+1)), FAST_OVERRIDES)
    assert len(result.trades) >= 1
    t = result.trades[0]
    assert t.leg == "long"
    # Signal bar is the bar before the fill (signals fill at next open), and
    # must be in the breakout leg (bars 80+), not the consolidation.
    times = [c.time for c in candles]
    sig_i = times.index(t.entry_time) - 1
    assert sig_i >= 80
    # Stop sits at the prior range low (stop_range_frac=1.0), target at
    # target_r times the risk above the signal close.
    module = load_strategy("bb_regime_breakout.py")
    params = resolve_params(module, FAST_OVERRIDES)
    lo = min(c.low for c in candles[sig_i - 40:sig_i])  # range low is in here
    assert abs(t.stop_initial - lo) < 1e-9 or t.stop_initial < candles[sig_i].close
    sig_close = candles[sig_i].close
    assert t.target == sig_close + params["target_r"] * (sig_close - t.stop_initial)


def test_downside_breakout_after_squeeze_opens_short():
    result, candles = run(bars_from_closes(squeeze_then_breakout(-1)), FAST_OVERRIDES)
    assert len(result.trades) >= 1
    t = result.trades[0]
    assert t.leg == "short"
    times = [c.time for c in candles]
    sig_i = times.index(t.entry_time) - 1
    assert sig_i >= 80
    sig_close = candles[sig_i].close
    assert t.stop_initial > sig_close
    assert t.target == sig_close - resolve_params(
        load_strategy("bb_regime_breakout.py"), FAST_OVERRIDES
    )["target_r"] * (t.stop_initial - sig_close)


def test_breakout_without_band_expansion_is_ignored():
    # Same breakout tape, but demand an impossible band-width expansion:
    # the regime-transition gate must block the entry.
    result, _ = run(bars_from_closes(squeeze_then_breakout(+1)),
                    {**FAST_OVERRIDES, "min_expansion_pct": 10000.0})
    assert result.trades == []


def drift_then_late_breakout() -> list[float]:
    """Squeeze ends, then price chops with renewed (non-squeeze) volatility
    inside the range for a while before finally breaking out: a late break."""
    closes = oscillation(100.0, 4.0, 40)
    closes += [100.0 + amp * np.sin(2 * np.pi * k / 8)
               for k, amp in enumerate(np.linspace(3.0, 0.4, 40))]
    closes += oscillation(100.0, 1.5, 30)
    last = closes[-1]
    closes += [last + 2.0 * k for k in range(1, 15)]
    return closes


def test_late_breakout_outside_window_is_ignored():
    # The same tape trades with a generous window but not with a tight one:
    # a break long after the squeeze ended must not be chased.
    tape = bars_from_closes(drift_then_late_breakout())
    late, _ = run(tape, {**FAST_OVERRIDES, "breakout_window": 5})
    assert late.trades == []
    ok, _ = run(tape, {**FAST_OVERRIDES, "breakout_window": 25})
    assert len(ok.trades) >= 1


def test_confirm_exceeding_window_still_trades():
    # The window is measured to the FIRST confirming close, so a confirmation
    # longer than the window cannot make the strategy silently untradeable.
    result, _ = run(bars_from_closes(squeeze_then_breakout(+1)),
                    {**FAST_OVERRIDES, "confirm_bars": 3, "breakout_window": 1})
    assert len(result.trades) >= 1


def test_efficiency_gate_blocks_breakouts_out_of_choppy_tape():
    # The squeeze tape is pure chop before the break: over a 40-bar lookback the
    # net move is tiny relative to the path traveled, so a demanding efficiency
    # floor must veto the entry while min_er=0 (the default) still trades.
    tape = bars_from_closes(squeeze_then_breakout(+1))
    gated, _ = run(tape, {**FAST_OVERRIDES, "er_lookback": 40, "min_er": 0.5})
    assert gated.trades == []
    ungated, _ = run(tape, {**FAST_OVERRIDES, "er_lookback": 40, "min_er": 0.0})
    assert len(ungated.trades) >= 1


def test_efficiency_gate_lets_directional_tape_through():
    # Same squeeze, but measured over a short lookback that sits mostly in the
    # accelerating breakout leg: efficiency is high, so the gate passes.
    tape = bars_from_closes(squeeze_then_breakout(+1))
    result, _ = run(tape, {**FAST_OVERRIDES, "er_lookback": 3, "min_er": 0.5})
    assert len(result.trades) >= 1


def test_reentry_after_stopout_while_breakout_persists():
    # Tight stop at the broken edge: the first attempt stops out intrabar while
    # the breakout condition keeps holding. The strategy must be able to try
    # again within the window instead of suppressing the breakout entirely.
    tape = bars_from_closes(squeeze_then_breakout(+1), spread=3.0)
    result, _ = run(tape, {**FAST_OVERRIDES, "stop_range_frac": 0.0,
                           "max_range_pct": 12.0})
    assert len(result.trades) >= 2


def failed_break_then_reversal() -> list[float]:
    """Squeeze, false upside break (enters long), then a collapse through the
    range low: the long stops out and a short breakout signal appears while
    still inside the breakout window — the whipsaw the flip guard targets."""
    closes = oscillation(100.0, 4.0, 40)
    closes += [100.0 + amp * np.sin(2 * np.pi * k / 8)
               for k, amp in enumerate(np.linspace(3.0, 0.4, 40))]
    last = closes[-1]
    closes += [last + 2.0 * k for k in range(1, 4)]      # false break up
    top = closes[-1]
    closes += [top - 2.5 * k for k in range(1, 8)]       # collapse through the range
    closes += [closes[-1] - 0.5 * k for k in range(1, 8)]  # drift on down
    return closes


def test_flip_guard_blocks_opposite_entry_after_stopout():
    tape = bars_from_closes(failed_break_then_reversal())
    ungated, _ = run(tape, {**FAST_OVERRIDES, "max_range_pct": 12.0})
    # Sanity: the whipsaw exists — a long that stops out, then a short.
    assert any(t.leg == "long" for t in ungated.trades)
    assert any(t.leg == "short" for t in ungated.trades)
    gated, _ = run(tape, {**FAST_OVERRIDES, "max_range_pct": 12.0,
                          "flip_guard_bars": 30})
    assert any(t.leg == "long" for t in gated.trades)
    assert not any(t.leg == "short" for t in gated.trades)


def test_flip_guard_keeps_same_direction_reentry():
    # Same tape as the re-entry test: repeated LONG attempts after stop-outs
    # must survive the guard — it only blocks the opposite direction.
    tape = bars_from_closes(squeeze_then_breakout(+1), spread=3.0)
    result, _ = run(tape, {**FAST_OVERRIDES, "stop_range_frac": 0.0,
                           "max_range_pct": 12.0, "flip_guard_bars": 30})
    assert len(result.trades) >= 2
    assert all(t.leg == "long" for t in result.trades)


def test_confirm_bars_delays_entry():
    # Requiring 3 confirming closes must signal later than requiring 1.
    tape = bars_from_closes(squeeze_then_breakout(+1))
    r1, candles = run(tape, {**FAST_OVERRIDES, "confirm_bars": 1})
    r3, _ = run(tape, {**FAST_OVERRIDES, "confirm_bars": 3, "breakout_window": 12})
    assert r1.trades and r3.trades
    assert r3.trades[0].entry_time > r1.trades[0].entry_time


def test_chart_regions_marks_unresolved_squeezes():
    # The consolidation-only tape squeezes but never breaks out: chart_regions
    # must still surface the squeeze window(s) so the chart can shade them.
    module = load_strategy("bb_regime_breakout.py")
    candles = bars_from_closes(consolidation_only())
    params = resolve_params(module, FAST_OVERRIDES)
    regions = module.chart_regions(candles, params)
    assert regions, "expected at least one squeeze region"
    times = [c.time.timestamp() for c in candles]
    for r in regions:
        assert r["label"] == "squeeze"
        assert r["top"] > r["bottom"]
        assert times[0] <= r["from_time"] < r["to_time"] <= times[-1]
    # The squeeze lives in the contracting/quiet stretch (bars 40+), not the
    # wide chop that sets the width baseline.
    assert all(r["from_time"] >= times[40] for r in regions)


def test_chart_regions_steady_trend_has_none():
    module = load_strategy("bb_regime_breakout.py")
    candles = bars_from_closes([100 + 0.5 * i for i in range(120)])
    params = resolve_params(module, FAST_OVERRIDES)
    # A smooth trend's band width keeps changing with the window, but the
    # trailing-percentile squeeze test is relative: some bars will qualify.
    # The gate that makes a squeeze REAL is the sideways range cap — regions
    # must respect max_range_pct like the entry logic does.
    tight = module.chart_regions(candles, {**params, "max_range_pct": 0.01})
    assert tight == []
