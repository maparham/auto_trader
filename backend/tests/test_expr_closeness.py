import math
from datetime import datetime, timezone

from auto_trader.core.models import Candle
from auto_trader.strategy.expr.closeness import (
    Norm,
    avg_abs_gap,
    group_closeness,
    ramp,
    row_closeness,
    row_gap_series,
    scale_series,
    signed_gap,
)
from auto_trader.strategy.expr.parser import parse


def test_signed_gap_orientation():
    # ">": fires when left > right, so gap = left - right
    assert signed_gap(">", 101, 100) == 1
    assert signed_gap(">=", 100, 100) == 0
    # "<": fires when left < right, so gap = right - left
    assert signed_gap("<", 99, 100) == 1
    assert signed_gap("<=", 100, 100) == 0
    # any None -> None
    assert signed_gap(">", None, 100) is None
    assert signed_gap(">", 100, None) is None


def test_ramp_shape():
    # firing (gap >= 0) -> 1
    assert ramp(0.0, 5.0) == 1.0
    assert ramp(2.0, 5.0) == 1.0
    # halfway short -> 0.5
    assert ramp(-2.5, 5.0) == 0.5
    # one full scale short -> 0
    assert ramp(-5.0, 5.0) == 0.0
    # beyond a scale -> clamped to 0
    assert ramp(-6.0, 5.0) == 0.0
    # undefined inputs -> None
    assert ramp(None, 5.0) is None
    assert ramp(-1.0, None) is None
    # non-positive or NaN scale -> None (can't normalize)
    assert ramp(-1.0, 0.0) is None
    assert ramp(-1.0, math.nan) is None


def test_avg_abs_gap_rolling_window_full_only():
    gaps = [-2.0, 1.0, -3.0, 2.0]
    # window 2: first bar has no full window -> None; then mean of |last 2|
    out = avg_abs_gap(gaps, 2)
    assert out[0] is None
    assert out[1] == (2.0 + 1.0) / 2
    assert out[2] == (1.0 + 3.0) / 2
    assert out[3] == (3.0 + 2.0) / 2


def test_avg_abs_gap_none_in_window_poisons():
    gaps = [1.0, None, 2.0, 3.0]
    out = avg_abs_gap(gaps, 2)
    assert out[1] is None  # window [1.0, None]
    assert out[2] is None  # window [None, 2.0]
    assert out[3] == (2.0 + 3.0) / 2


def test_scale_series_volatility_applies_width():
    gaps = [-2.0, 1.0, -3.0, 2.0]
    out = scale_series(gaps, "volatility", width=2.0, window=2, atr=None)
    assert out[0] is None
    assert out[1] == 2.0 * 1.5  # width * avgAbsGap


def test_scale_series_atr_applies_width():
    gaps = [0.0, 0.0, 0.0]
    atr = [None, 4.0, 5.0]
    out = scale_series(gaps, "atr", width=2.0, window=50, atr=atr)
    assert out[0] is None
    assert out[1] == 8.0
    assert out[2] == 10.0


def _c(close: float, i: int) -> Candle:
    t = datetime(2024, 1, 1, tzinfo=timezone.utc).timestamp() + i * 60
    return Candle(
        time=datetime.fromtimestamp(t, tz=timezone.utc),
        open=close,
        high=close + 1,
        low=close - 1,
        close=close,
        volume=100,
    )


def test_row_gap_series_comparison_orientation():
    candles = [_c(c, i) for i, c in enumerate([98, 99, 100, 101])]
    node = parse("close > 100")
    gaps = row_gap_series(node, candles, "MINUTE", {})
    assert gaps == [98 - 100, 99 - 100, 100 - 100, 101 - 100]


def test_row_closeness_hits_one_when_firing():
    candles = [_c(c, i) for i, c in enumerate([90, 95, 100, 105, 110, 100])]
    node = parse("close > 100")
    norm = Norm(basis="volatility", width=1.0, window=2, atr_length=14)
    out = row_closeness(node, candles, "MINUTE", {}, norm)
    # bars where close > 100 fire -> 1.0; early bars undefined until window fills
    assert out[3] == 1.0  # close 105 > 100
    assert out[4] == 1.0  # close 110 > 100
    assert 0.0 <= out[5] <= 1.0  # close 100, not firing, some warmth


def test_row_closeness_cross_is_symmetric_line_proximity():
    # a and b equal on a bar -> proximity 1 regardless of side
    candles = [_c(c, i) for i, c in enumerate([100, 100, 100, 100])]
    node = parse("crossAbove(close, 100)")
    norm = Norm(basis="volatility", width=1.0, window=2, atr_length=14)
    out = row_closeness(node, candles, "MINUTE", {}, norm)
    # gap |close - 100| is 0 everywhere -> scale is 0 -> undefined (no spread);
    # this documents the degenerate all-equal case.
    assert out[-1] is None or out[-1] == 1.0


def test_group_fold_and_takes_min_or_none_poisons():
    candles = [_c(c, i) for i, c in enumerate([100, 100, 100, 100, 100, 99])]
    rows = [parse("close > 100"), parse("close < 200")]
    norm = Norm(basis="volatility", width=5.0, window=2, atr_length=14)
    out = group_closeness(rows, "AND", candles, "MINUTE", {}, norm)
    # both rows must be defined; AND folds to the min of the two
    per = [row_closeness(r, candles, "MINUTE", {}, norm) for r in rows]
    for i in range(len(candles)):
        vals = [p[i] for p in per]
        if any(v is None for v in vals):
            assert out[i] is None
        else:
            assert out[i] == min(vals)


def test_group_fold_or_takes_max():
    candles = [_c(c, i) for i, c in enumerate([90, 95, 100, 105, 110, 100])]
    rows = [parse("close > 108"), parse("close > 100")]
    norm = Norm(basis="volatility", width=5.0, window=2, atr_length=14)
    out = group_closeness(rows, "OR", candles, "MINUTE", {}, norm)
    per = [row_closeness(r, candles, "MINUTE", {}, norm) for r in rows]
    for i in range(len(candles)):
        vals = [p[i] for p in per]
        if any(v is None for v in vals):
            assert out[i] is None
        else:
            assert out[i] == max(vals)


def test_group_empty_rows_all_none():
    candles = [_c(100, i) for i in range(3)]
    norm = Norm(basis="volatility", width=5.0, window=2, atr_length=14)
    assert group_closeness([], "AND", candles, "MINUTE", {}, norm) == [None, None, None]
