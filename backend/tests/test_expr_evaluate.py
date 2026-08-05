from datetime import datetime, timedelta, timezone

import pytest

from auto_trader.core.models import Candle
from auto_trader.strategy.expr.evaluate import compile_row, series_of
from auto_trader.strategy.expr.parser import parse


def _bars(ohlc):
    """ohlc: list of (open, close); high/low derived."""
    t0 = datetime(2026, 1, 1, tzinfo=timezone.utc)
    return [
        Candle(time=t0 + timedelta(minutes=5 * i), open=o, high=max(o, c) + 1, low=min(o, c) - 1, close=c, volume=100)
        for i, (o, c) in enumerate(ohlc)
    ]


def _candles(closes, resolution_s=3600):
    base = datetime(2026, 1, 1, tzinfo=timezone.utc)
    out = []
    for k, c in enumerate(closes):
        out.append(Candle(time=base + timedelta(seconds=resolution_s * k),
                          open=c, high=c, low=c, close=c, volume=100.0))
    return out


def _row_bools(src, candles, resolution="HOUR", htf=None, is_exit=False, entry=None):
    row = compile_row(parse(src), candles, resolution, htf or {})
    return [row.evaluate(i, entry) for i in range(len(candles))]


def test_ema_comparison():
    c = _candles([1, 2, 3, 2, 1])
    # EMA(2): 1, 1.6667, 2.5556, 2.3704, 1.7901
    assert _row_bools("EMA(2) > 2", c) == [False, False, True, True, False]


def test_arith_and_atr():
    c = _candles([1, 2, 3, 2, 1])
    # candle.close + 0 > EMA(2) at each bar
    assert _row_bools("candle.close > EMA(2)", c) == [False, True, True, False, False]


def test_highest_includes_current_bar():
    c = _candles([1, 2, 3, 2, 1])
    # highest(candle.close, 2): None, 2, 3, 3, 2  -> > 2.5 -> F,F,T,T,F
    assert _row_bools("highest(candle.close, 2) > 2.5", c) == [False, False, True, True, False]


def test_slope_positive():
    c = _candles([1, 2, 3, 2, 1])
    # slope(candle.close, 1) [%/hr]: None, 100, 50, -33.3, -50 -> > 0 -> F,T,T,F,F
    assert _row_bools("slope(candle.close, 1) > 0", c) == [False, True, True, False, False]


def test_offset_reads_prior_bar():
    c = _candles([1, 2, 3, 2, 1])
    # candle[-1].close: None, 1, 2, 3, 2 -> > 1.5 -> F,F,T,T,T
    assert _row_bools("candle[-1].close > 1.5", c) == [False, False, True, True, True]


def test_nan_poisons_to_false():
    c = _candles([1, 2, 3, 2, 1])
    # division by zero -> nan -> false everywhere
    assert _row_bools("candle.close / 0 > 0", c) == [False] * 5


def test_nan_poisons_highest_window():
    # closes [3, 2, 5, 4]; raw = close/(close-2): [3, nan (2/0), 5/3, 2].
    # highest(raw, 2) per bar:
    #   bar0: window too short -> None -> False
    #   bar1: window [3, nan] -> poisoned. Without the NaN screen, max(3, nan)
    #         returns 3 (order-dependent) and would leak 3 > 0 -> True.
    #   bar2: window [nan, 5/3] -> poisoned -> False
    #   bar3: window [5/3, 2] -> max 2 > 0 -> True
    c = _candles([3, 2, 5, 4])
    assert _row_bools("highest(candle.close / (candle.close - 2), 2) > 0", c) == [
        False, False, False, True]


def test_cross_above():
    c = _candles([1, 2, 3, 2, 1])
    # crossAbove(candle.close, 2): prev<=2 and now>2 -> only bar 2
    assert _row_bools("crossAbove(candle.close, 2)", c) == [False, False, True, False, False]


def test_entry_in_exit_rule():
    c = _candles([1, 2, 3, 2, 1])
    # candle.close > entry with entry price 2.5 -> only bar 2 (close 3)
    assert _row_bools("candle.close > entry", c, is_exit=True, entry=2.5) == [
        False, False, True, False, False]


def test_tf_forward_fill():
    # base hourly 5 bars; HOUR_4 has closes [10,20] at t=0 and t=4h. The first
    # HOUR_4 bar (opens t=0) closes at t=4h, so it becomes usable only at base
    # bar 4 (wait-close, no hindsight) -> [None, None, None, None, 10.0].
    base = _candles([1, 1, 1, 1, 1], resolution_s=3600)
    htf_base = datetime(2026, 1, 1, tzinfo=timezone.utc)
    htf = {"HOUR_4": [
        Candle(time=htf_base, open=10, high=10, low=10, close=10, volume=1),
        Candle(time=htf_base + timedelta(seconds=14400), open=20, high=20, low=20, close=20, volume=1),
    ]}
    arr = series_of(parse("candle.close@HOUR_4 > 5").left, base, "HOUR", htf)
    assert arr == [None, None, None, None, 10.0]


def test_tf_field_wrapped_over_tf():
    # Field wrapped over Tf: candle@HOUR_4.high pushes the field onto the inner
    # Candle leaf, then forward-fills the HTF highs the same way as the close path.
    base = _candles([1, 1, 1, 1, 1], resolution_s=3600)
    htf_base = datetime(2026, 1, 1, tzinfo=timezone.utc)
    htf = {"HOUR_4": [
        Candle(time=htf_base, open=10, high=10, low=10, close=10, volume=1),
        Candle(time=htf_base + timedelta(seconds=14400), open=20, high=20, low=20, close=20, volume=1),
    ]}
    arr = series_of(parse("candle@HOUR_4.high > 0").left, base, "HOUR", htf)
    assert arr == [None, None, None, None, 10.0]


def test_series_of_arith():
    c = _candles([1, 2, 3, 2, 1])
    assert series_of(parse("candle.close - EMA(1) > 0").left, c, "HOUR", {}) == [0.0, 0.0, 0.0, 0.0, 0.0]


def test_count_series_red_candles():
    # closes below opens on bars 1,2,4
    candles = _bars([(10, 11), (11, 10), (10, 9), (9, 10), (10, 8), (8, 9)])
    node = parse("count(candle.open > candle.close, 3) >= 2")
    vals = series_of(node.left, candles, "MINUTE_5", {})
    # window of 3 incl current: None,None,2,2,2,1? -> bar2 window [0,1,2]=2, bar3 [1,2,3]=2, bar4 [2,3,4]=2, bar5 [3,4,5]=1
    assert vals == [None, None, 2.0, 2.0, 2.0, 1.0]


def test_count_window_below_one_is_zero():
    candles = _bars([(10, 9), (9, 8)])
    node = parse("count(candle.open > candle.close, 0.5) > 0")
    assert series_of(node.left, candles, "MINUTE_5", {}) == [0.0, 0.0]


def test_count_undefined_cond_counts_zero():
    # window=2 needs 2 bars to fit, so the count itself is undefined (None) at
    # bar 0. EMA(3) is defined from bar 0 in this engine (SMA-seeded: 11, 11.5,
    # 12.25, 13.125), so close>EMA matches are [False, True, True, True]; the
    # count-so-far is 0,1,2,2 as the window fills: vals[1] = 1 (bars 0-1: only
    # bar 1 matches), and later bars stay consistent (both bars in the window
    # match once EMA is well past its seed).
    candles = _bars([(10, 11), (11, 12), (12, 13), (13, 14)])
    node = parse("count(candle.close > EMA(3), 2) >= 1")
    vals = series_of(node.left, candles, "MINUTE_5", {})
    assert vals[0] is None
    assert vals[1] == 1.0
    assert vals[2] == 2.0 and vals[3] == 2.0


def test_predicate_row_evaluate():
    candles = _bars([(10, 11), (11, 10), (10, 10)])
    row = compile_row(parse("bearish(candle)"), candles, "MINUTE_5", {})
    assert [row.evaluate(i, None) for i in range(3)] == [False, True, False]  # doji is neither


def test_bullish_predicate_row():
    candles = _bars([(10, 11), (11, 10)])
    row = compile_row(parse("bullish(candle)"), candles, "MINUTE_5", {})
    assert [row.evaluate(i, None) for i in range(2)] == [True, False]


def test_count_cross_condition():
    # close crossing above a constant-ish SMA is fiddly; use crossAbove(close, open) shape
    candles = _bars([(10, 9), (10, 11), (10, 9), (10, 11)])
    node = parse("count(crossAbove(candle.close, candle.open), 4) >= 2")
    vals = series_of(node.left, candles, "MINUTE_5", {})
    # window=4 doesn't fit until bar 3 -> None on bars 0-2 (bar 0 never matches:
    # a cross needs a prior bar). Matches at bars 1 and 3 (close moves from below
    # open to above) -> the window-4 count at bar 3 is 2.
    assert vals == [None, None, None, 2.0]


def test_bars_since_entry_not_a_series():
    candles = _bars([(10, 11)])
    with pytest.raises(ValueError):
        series_of(parse("barsSinceEntry > 1").left, candles, "MINUTE_5", {})


def test_bars_since_entry_value():
    candles = _bars([(10, 11)] * 6)
    row = compile_row(parse("barsSinceEntry > 2"), candles, "MINUTE_5", {})
    # entry at bar 2 -> barsSinceEntry = i - 2
    assert [row.evaluate(i, 10.0, 2) for i in range(6)] == [False, False, False, False, False, True]
    # flat (no entry_i) -> never fires
    assert row.evaluate(5, None, None) is False


def test_count_literal_window_per_bar_none_until_window_fits():
    # 6 bars; window=10 never fits (max i+1 is 6 < 10) -> every bar hits the
    # per-bar Count path's `i + 1 < k -> None` branch, so the row must NOT fire
    # even though every bar's close(9) < entry(100) would otherwise match.
    candles = _bars([(10, 9)] * 6)
    row = compile_row(parse("count(candle.close < entry, 10) >= 3"), candles, "MINUTE_5", {})
    assert [row.evaluate(i, 100.0, 0) for i in range(6)] == [False] * 6


def test_count_literal_window_per_bar_fires_when_window_fits():
    # Same bars, a window (3) that DOES fit within 6 bars -> fires once the
    # window has 3 bars behind it (i>=2), every bar closing below entry.
    candles = _bars([(10, 9)] * 6)
    row = compile_row(parse("count(candle.close < entry, 3) >= 3"), candles, "MINUTE_5", {})
    assert [row.evaluate(i, 100.0, 0) for i in range(6)] == [
        False, False, True, True, True, True,
    ]


def test_count_dynamic_window_since_entry():
    # bars: green, entry@1, red, red, green, red -> reds since entry at bars 2,3,5
    candles = _bars([(10, 11), (11, 12), (12, 11), (11, 10), (10, 11), (11, 10)])
    row = compile_row(parse("count(bearish(candle), barsSinceEntry) >= 3"), candles, "MINUTE_5", {})
    entry_i = 1
    got = [row.evaluate(i, 12.0, entry_i) for i in range(6)]
    # bar5: window = 4 bars (2..5), reds = 3 -> fires; bar4: window 3 (2..4), reds 2 -> no
    assert got == [False, False, False, False, False, True]


def test_count_dynamic_window_entry_price_condition():
    # count closes below entry since entry
    candles = _bars([(10, 11), (11, 12), (12, 9), (9, 8), (8, 13), (13, 7)])
    row = compile_row(parse("count(candle.close < entry, barsSinceEntry) >= 3"), candles, "MINUTE_5", {})
    got = [row.evaluate(i, 12.0, 1) for i in range(6)]
    # closes below 12 since entry: bars 2(9),3(8),5(7) -> 3rd at bar 5
    assert got[5] is True and got[4] is False


def test_strategy_passes_entry_index():
    from auto_trader.strategy.base import Context
    from auto_trader.strategy.expr.strategy import ExprRuleStrategy
    candles = _bars([(10, 11), (11, 12), (12, 11), (11, 10), (10, 9)])
    exit_row = compile_row(parse("count(bearish(candle), barsSinceEntry) >= 3"), candles, "MINUTE_5", {})
    strat = ExprRuleStrategy([], [exit_row], [], [], quantity=1.0)
    ctx = Context()
    ctx.history = list(candles)
    ctx.position_long = 1.0
    ctx.long_entry_price = 12.0
    ctx.long_entry_time = candles[1].time
    signals = strat.on_bar(ctx)
    # bars 2 (12->11), 3 (11->10), 4 (10->9) are all red; entry bar 1, i=4 ->
    # window of barsSinceEntry=3 covers bars 2..4 with 3 reds -> the exit fires.
    assert len(signals) == 1 and signals[0].leg == "long"
