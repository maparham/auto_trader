"""Entry-context features for backtest trades, computed at each trade's SIGNAL
bar (the bar before its entry fill — fills happen at the next bar's open).

Pure post-run enrichment: no engine coupling, no lookahead (every feature only
reads bars <= the signal bar), except vol_regime which is a run-relative
post-hoc analysis label: its tercile bucket is computed from the entire run's
ATR values, not a point-in-time tradable value. Features whose lookback isn't
satisfied are None, never fabricated. All values are JSON-safe scalars (they
ship in TradeDTO and the run store verbatim).

Constants are v1-fixed (not user-tunable): EMA(50) slope for trend with a
0.02 %/bar flat cutoff, ATR(14) with terciles for vol regime, 20-bar swings.
"""

from __future__ import annotations

from bisect import bisect_left

from auto_trader.core.models import Candle, Trade

EMA_LEN = 50
ATR_LEN = 14
SWING_LEN = 20
FLAT_SLOPE_PCT = 0.02  # |EMA slope| below this (%/bar) reads as "flat"


# Pure helper functions (no engine/indicator coupling per spec).
# Note: _atr is SMA of true range — numerically different from the Wilder-smoothed
# atr_series in auto_trader/indicators/core.py; do not consolidate without accepting
# the numeric shift.
def _ema(closes: list[float], length: int) -> list[float | None]:
    """Standard EMA seeded with the SMA of the first `length` closes; None while cold."""
    out: list[float | None] = [None] * len(closes)
    if len(closes) < length:
        return out
    k = 2.0 / (length + 1)
    ema = sum(closes[:length]) / length
    out[length - 1] = ema
    for i in range(length, len(closes)):
        ema = closes[i] * k + ema * (1 - k)
        out[i] = ema
    return out


def _atr(candles: list[Candle], length: int) -> list[float | None]:
    """SMA of true range over `length` bars; None while cold (needs length+1 bars)."""
    out: list[float | None] = [None] * len(candles)
    trs: list[float] = []
    for i in range(1, len(candles)):
        c, p = candles[i], candles[i - 1]
        trs.append(max(c.high - c.low, abs(c.high - p.close), abs(c.low - p.close)))
        if len(trs) >= length:
            out[i] = sum(trs[-length:]) / length
    return out


def session_tag(hour_utc: int) -> str:
    """FX session from the UTC hour. Overlap (London+NY) wins over either alone."""
    if 12 <= hour_utc < 16:
        return "overlap"
    if 7 <= hour_utc < 12:
        return "london"
    if 16 <= hour_utc < 21:
        return "newyork"
    if hour_utc >= 23 or hour_utc < 7:
        return "asia"
    return "off"  # 21-22 UTC


def classify_candle(prev: Candle | None, bar: Candle) -> str:
    """First-match classification. Body = |close-open|, range = high-low."""
    body = abs(bar.close - bar.open)
    rng = bar.high - bar.low
    if prev is not None:
        p_body_hi = max(prev.open, prev.close)
        p_body_lo = min(prev.open, prev.close)
        b_body_hi = max(bar.open, bar.close)
        b_body_lo = min(bar.open, bar.close)
        prev_down = prev.close < prev.open
        prev_up = prev.close > prev.open
        if bar.close > bar.open and prev_down and b_body_lo <= p_body_lo and b_body_hi >= p_body_hi:
            return "bull_engulfing"
        if bar.close < bar.open and prev_up and b_body_lo <= p_body_lo and b_body_hi >= p_body_hi:
            return "bear_engulfing"
        if rng > 0:
            upper_wick = bar.high - max(bar.open, bar.close)
            lower_wick = min(bar.open, bar.close) - bar.low
            if upper_wick >= 2 * body and min(bar.open, bar.close) <= bar.low + rng / 3:
                return "pin_top"
            if lower_wick >= 2 * body and max(bar.open, bar.close) >= bar.high - rng / 3:
                return "pin_bottom"
        if bar.high < prev.high and bar.low > prev.low:
            return "inside"
        if bar.high > prev.high and bar.low < prev.low:
            return "outside"
    if rng > 0 and body <= 0.10 * rng:
        return "doji"
    return "none"


def enrich_trades(trades: list[Trade], candles: list[Candle]) -> None:
    """Attach a context dict to each trade, computed at its signal bar.

    The signal bar is entry-fill bar minus one (the engine fills a bar-t signal
    at bar t+1's open). A trade whose entry_time isn't in `candles`, or that
    fills on bar 0, keeps context=None.
    """
    if not candles or not trades:
        return
    index = {c.time: i for i, c in enumerate(candles)}
    closes = [c.close for c in candles]
    ema = _ema(closes, EMA_LEN)
    atr = _atr(candles, ATR_LEN)
    atr_sorted = sorted(a for a in atr if a is not None)

    for trade in trades:
        fill_i = index.get(trade.entry_time)
        if fill_i is None or fill_i == 0:
            continue
        s = fill_i - 1  # signal bar
        bar = candles[s]
        prev = candles[s - 1] if s > 0 else None

        trend: str | None = None
        if ema[s] is not None and s > 0 and ema[s - 1] is not None and ema[s - 1] != 0:
            slope_pct = (ema[s] - ema[s - 1]) / ema[s - 1] * 100.0
            if abs(slope_pct) < FLAT_SLOPE_PCT:
                trend = "flat"
            else:
                trend = "up" if slope_pct > 0 else "down"

        vol_regime: str | None = None
        a = atr[s]
        if a is not None and len(atr_sorted) >= 3:
            pct = bisect_left(atr_sorted, a) / len(atr_sorted)
            vol_regime = "low" if pct < 1 / 3 else ("high" if pct > 2 / 3 else "mid")

        dist_hi: float | None = None
        dist_lo: float | None = None
        if s >= SWING_LEN and a is not None and a > 0:
            window = candles[s - SWING_LEN:s]  # 20 bars strictly BEFORE the signal bar (signal bar excluded)
            dist_hi = (max(c.high for c in window) - bar.close) / a
            dist_lo = (bar.close - min(c.low for c in window)) / a

        trade.context = {
            "trend": trend,
            "vol_regime": vol_regime,
            "session": session_tag(bar.time.hour),
            "hour_utc": bar.time.hour,
            "day_of_week": bar.time.weekday(),
            "dist_swing_high": round(dist_hi, 3) if dist_hi is not None else None,
            "dist_swing_low": round(dist_lo, 3) if dist_lo is not None else None,
            "candle_pattern": classify_candle(prev, bar),
        }
