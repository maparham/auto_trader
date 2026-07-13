"""Entry-context features computed at the SIGNAL bar (the bar before the fill):
trend from EMA(50) slope, vol regime from ATR(14) percentile, FX session from
UTC hour, swing distance in ATRs, candlestick pattern classification."""

from datetime import datetime, timedelta, timezone

from auto_trader.core.models import Candle, Side, Trade
from auto_trader.engine.context_features import classify_candle, enrich_trades, session_tag


def _c(o, h, lo, c, t=None):
    return Candle(
        time=t or datetime(2026, 1, 5, tzinfo=timezone.utc),
        open=o, high=h, low=lo, close=c, volume=0.0,
    )


# --- candle patterns ---------------------------------------------------------

def test_bull_engulfing():
    prev = _c(102, 103, 99, 100)   # down body 102->100
    bar = _c(99.5, 104, 99, 103)   # up body 99.5->103 engulfs [100, 102]
    assert classify_candle(prev, bar) == "bull_engulfing"


def test_bear_engulfing():
    prev = _c(100, 103, 99, 102)
    bar = _c(102.5, 103, 98, 99.5)
    assert classify_candle(prev, bar) == "bear_engulfing"


def test_pin_bottom():
    # Long lower wick >= 2x body, body in the top third of the range.
    prev = _c(100, 101, 99, 100)
    bar = _c(99.8, 100.2, 96, 100.0)  # range 4.2, body 0.2, lower wick 3.8
    assert classify_candle(prev, bar) == "pin_bottom"


def test_pin_top():
    prev = _c(100, 101, 99, 100)
    bar = _c(100.0, 104.0, 99.8, 99.9)
    assert classify_candle(prev, bar) == "pin_top"


def test_inside_and_outside():
    prev = _c(100, 105, 95, 102)
    assert classify_candle(prev, _c(101, 103, 97, 99)) == "inside"
    assert classify_candle(prev, _c(99, 106, 94, 103)) == "outside"


def test_doji():
    # prev range chosen so the bar is neither inside (bar.low == prev.low, not
    # strictly inside) nor outside (bar.high < prev.high) — falls through to doji.
    prev = _c(100, 103, 98, 100.8)
    bar = _c(100.0, 102, 98, 100.1)  # body 0.1 <= 10% of range 4
    assert classify_candle(prev, bar) == "doji"


def test_none():
    prev = _c(100, 101, 99, 100.5)
    assert classify_candle(prev, _c(100.4, 102, 99.5, 101.2)) == "none"
    assert classify_candle(None, _c(100, 101, 99, 100.5)) == "none"


# --- sessions ----------------------------------------------------------------

def test_session_tags():
    assert session_tag(3) == "asia"
    assert session_tag(9) == "london"
    assert session_tag(13) == "overlap"
    assert session_tag(18) == "newyork"
    assert session_tag(21) == "off"
    assert session_tag(23) == "asia"


# --- enrichment --------------------------------------------------------------

def test_enrich_sets_context_at_signal_bar():
    # 80 flat bars, then a strong up-leg so EMA(50) slope at the signal bar is
    # clearly "up"; trade fills at bar 80 -> signal bar is 79.
    t0 = datetime(2026, 1, 5, tzinfo=timezone.utc)
    candles = []
    px = 100.0
    for i in range(81):
        if i >= 60:
            px += 1.0
        candles.append(Candle(
            time=t0 + timedelta(hours=i),
            open=px, high=px + 0.5, low=px - 0.5, close=px, volume=0.0,
        ))
    trade = Trade(
        side=Side.BUY, quantity=1.0,
        entry_time=candles[80].time, entry_price=candles[80].open,
        exit_time=candles[80].time, exit_price=candles[80].close, pnl=0.0,
    )
    enrich_trades([trade], candles)

    ctx = trade.context
    assert ctx is not None
    assert ctx["trend"] == "up"
    assert ctx["vol_regime"] in ("low", "mid", "high")
    assert ctx["session"] == session_tag(candles[79].time.hour)
    assert ctx["hour_utc"] == candles[79].time.hour
    assert ctx["day_of_week"] == candles[79].time.weekday()
    # Note: can be negative — the close sits ABOVE the prior 20-bar swing high
    # in this rising fixture; sign is meaningful, only None-ness is warm-up.
    assert ctx["dist_swing_high"] is not None and ctx["dist_swing_low"] is not None
    assert ctx["candle_pattern"] in (
        "bull_engulfing", "bear_engulfing", "pin_top", "pin_bottom",
        "inside", "outside", "doji", "none",
    )


def test_enrich_warmup_gives_nulls_not_fabrications():
    # Fill at bar 5: EMA(50)/ATR(14)/swing(20) can't warm up -> those are None,
    # but session/hour/day/pattern (no lookback) are still set.
    t0 = datetime(2026, 1, 5, tzinfo=timezone.utc)
    candles = [
        Candle(time=t0 + timedelta(hours=i), open=100, high=101, low=99, close=100, volume=0.0)
        for i in range(6)
    ]
    trade = Trade(
        side=Side.BUY, quantity=1.0,
        entry_time=candles[5].time, entry_price=100.0,
        exit_time=candles[5].time, exit_price=100.0, pnl=0.0,
    )
    enrich_trades([trade], candles)

    ctx = trade.context
    assert ctx["trend"] is None
    assert ctx["vol_regime"] is None
    assert ctx["dist_swing_high"] is None and ctx["dist_swing_low"] is None
    assert ctx["session"] == session_tag(candles[4].time.hour)
    assert ctx["candle_pattern"] is not None


def test_enrich_unknown_entry_time_leaves_context_none():
    t0 = datetime(2026, 1, 5, tzinfo=timezone.utc)
    candles = [
        Candle(time=t0 + timedelta(hours=i), open=100, high=101, low=99, close=100, volume=0.0)
        for i in range(3)
    ]
    trade = Trade(
        side=Side.BUY, quantity=1.0,
        entry_time=t0 + timedelta(days=30), entry_price=100.0,
        exit_time=t0 + timedelta(days=30), exit_price=100.0, pnl=0.0,
    )
    enrich_trades([trade], candles)
    assert trade.context is None
