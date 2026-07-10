from datetime import datetime, timezone
from auto_trader.core.models import Candle
from auto_trader.indicators.core import ema_series, sma_series, avwap_series
from auto_trader.indicators.mtf import align_htf_to_base
from auto_trader.strategy.rule import Operand
from auto_trader.strategy.rule_series import build_rule_series, htf_timeframes


def _candles(closes, vols=None):
    vols = vols or [1.0] * len(closes)
    return [
        Candle(time=datetime.fromtimestamp(i * 3600, tz=timezone.utc),
               open=c, high=c + 1, low=c - 1, close=c, volume=v)
        for i, (c, v) in enumerate(zip(closes, vols))
    ]


def test_base_indicators_match_leaves():
    cs = _candles([10, 11, 12, 13, 14, 15, 16, 17])
    ops = [
        Operand(kind="indicator", indicator="EMA", length=3),
        Operand(kind="indicator", indicator="SMA", length=2),
        Operand(kind="indicator", indicator="VOL"),
        Operand(kind="indicator", indicator="VOLMA", length=2),
    ]
    out = build_rule_series(ops, cs, "HOUR", {})
    closes = [c.close for c in cs]
    assert out["EMA_3"] == ema_series(closes, 3)
    assert out["SMA_2"] == sma_series(closes, 2)
    assert out["VOL"] == [c.volume for c in cs]
    assert out["VOLMA_2"] == sma_series([c.volume for c in cs], 2)


def test_avwap_and_price_slope_and_atr():
    cs = _candles([10, 11, 12, 13, 14], vols=[1, 2, 3, 4, 5])
    anchor_ms = int(cs[1].time.timestamp() * 1000)
    ops = [
        Operand(kind="indicator", indicator="AVWAP", anchor=anchor_ms),
        Operand(kind="price", field="close", slope_len=2),
    ]
    out = build_rule_series(ops, cs, "HOUR", {}, atr_lengths=[3])
    assert out[f"AVWAP_{anchor_ms}"] == avwap_series(cs, anchor_ms)
    assert out["close~2"][0] is None and out["close~2"][2] is not None
    assert "ATR_3" in out and len(out["ATR_3"]) == len(cs)


def test_series_kind_operand_is_skipped():
    cs = _candles([10, 11, 12])
    ops = [Operand(kind="series", series_key="EMA_abc123", label="EMA(9)")]
    out = build_rule_series(ops, cs, "HOUR", {})
    assert "EMA_abc123" not in out  # chart operands are browser-supplied, not recomputed


def test_htf_timeframes_collects_non_base():
    ops = [
        Operand(kind="indicator", indicator="EMA", length=9, timeframe="HOUR_4"),
        Operand(kind="indicator", indicator="EMA", length=9),          # base
        Operand(kind="indicator", indicator="RSI", length=14, timeframe="DAY"),
    ]
    assert htf_timeframes(ops, "HOUR") == {"HOUR_4", "DAY"}


def test_htf_ema_aligned_closed_bar():
    base = _candles([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21])   # 12 hourly bars
    # HOUR_4 candles: one every 4 base bars, closes 10,14,18
    htf = [
        Candle(time=datetime.fromtimestamp(i * 4 * 3600, tz=timezone.utc),
               open=c, high=c, low=c, close=c, volume=1.0)
        for i, c in enumerate([10.0, 14.0, 18.0])
    ]
    op = Operand(kind="indicator", indicator="EMA", length=2, timeframe="HOUR_4")
    out = build_rule_series([op], base, "HOUR", {"HOUR_4": htf})
    base_ms = [int(c.time.timestamp() * 1000) for c in base]
    htf_ms = 4 * 3600 * 1000
    expected = align_htf_to_base(base_ms, htf, ema_series([10.0, 14.0, 18.0], 2), htf_ms)
    assert out["EMA_2@HOUR_4"] == expected
    # closed-bar: the first HOUR_4 bar (opens at t=0) closes at t=4h, so base bars
    # 0..3 see nothing yet.
    assert out["EMA_2@HOUR_4"][0] is None
    assert out["EMA_2@HOUR_4"][4] is not None
