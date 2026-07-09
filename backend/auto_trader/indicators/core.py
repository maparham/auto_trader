"""Base-timeframe indicator math, ported operation-for-operation from the
frontend TS so `ctx.ema(9)` in a coded strategy equals the EMA drawn on the
chart. Sources of truth:

  ema/sma  -> frontend/src/lib/mtf.ts (ema, sma)
  rsi      -> frontend/src/lib/indicators/rsi.ts (computeRsi, Wilder, SMA seed)
  atr      -> frontend/src/lib/atr.ts (Wilder's ATR)
  avwap    -> frontend/src/lib/indicators/vwap.ts (vwapFrom, hlc3 source) with
              the anchor rule of backtestSeries.ts computeRaw (first bar at/after
              the epoch-ms anchor; anchor <= 0 or past the last bar => blank)

Do NOT "improve" the arithmetic (e.g. replace the SMA's running accumulator with
sum(window)/n): both runtimes are IEEE-754 float64, and identical operation
order is what makes the parity suite exact. Every function returns a list the
same length as its input, None where the TS emits undefined. Values at index i
depend only on inputs [0..i] — no lookahead by construction."""

from __future__ import annotations

from collections.abc import Sequence

from auto_trader.core.models import Candle


def hlc3(c: Candle) -> float:
    """The chart AVWAP's default price source (priceOf(k, "hlc3"))."""
    return (c.high + c.low + c.close) / 3


def ema_series(values: Sequence[float], length: int) -> list[float | None]:
    """mtf.ts `ema`: first value seeds, k = 2/(length+1). Defined from bar 0."""
    out: list[float | None] = [None] * len(values)
    if length < 1:
        return out
    k = 2 / (length + 1)
    prev: float | None = None
    for i, v in enumerate(values):
        prev = v if prev is None else v * k + prev * (1 - k)
        out[i] = prev
    return out


def sma_series(values: Sequence[float], length: int) -> list[float | None]:
    """mtf.ts `sma`: running add/subtract accumulator (kept for FP parity)."""
    out: list[float | None] = [None] * len(values)
    if length < 1:
        return out
    s = 0.0
    for i, v in enumerate(values):
        s += v
        if i >= length:
            s -= values[i - length]
        if i >= length - 1:
            out[i] = s / length
    return out


def rsi_series(values: Sequence[float], length: int) -> list[float | None]:
    """rsi.ts `computeRsi` value line: Wilder's RMA of gains/losses, seeded with
    the SMA of the first `period` changes (TradingView ta.rsi). None until bar
    index `period`; avg_loss == 0 -> 100."""
    n = len(values)
    out: list[float | None] = [None] * n
    period = max(1, int(length) or 14)
    if n <= period:
        return out
    avg_gain = 0.0
    avg_loss = 0.0
    for i in range(1, n):
        change = values[i] - values[i - 1]
        gain = change if change > 0 else 0.0
        loss = -change if change < 0 else 0.0
        if i <= period:
            avg_gain += gain
            avg_loss += loss
            if i == period:
                avg_gain /= period
                avg_loss /= period
                out[i] = 100.0 if avg_loss == 0 else 100 - 100 / (1 + avg_gain / avg_loss)
        else:
            avg_gain = (avg_gain * (period - 1) + gain) / period
            avg_loss = (avg_loss * (period - 1) + loss) / period
            out[i] = 100.0 if avg_loss == 0 else 100 - 100 / (1 + avg_gain / avg_loss)
    return out


def atr_series(candles: Sequence[Candle], length: int) -> list[float | None]:
    """atr.ts: TR[0] = high-low; first ATR = mean of first `length` TRs at index
    length-1; then Wilder-smoothed."""
    n = len(candles)
    out: list[float | None] = [None] * n
    if length < 1 or n == 0:
        return out
    tr = [0.0] * n
    for i, k in enumerate(candles):
        hl = k.high - k.low
        if i == 0:
            tr[i] = hl
        else:
            pc = candles[i - 1].close
            tr[i] = max(hl, abs(k.high - pc), abs(k.low - pc))
    if n < length:
        return out
    s = 0.0
    for i in range(length):
        s += tr[i]
    atr = s / length
    out[length - 1] = atr
    for i in range(length, n):
        atr = (atr * (length - 1) + tr[i]) / length
        out[i] = atr
    return out


def avwap_series(candles: Sequence[Candle], anchor_ms: int) -> list[float | None]:
    """vwap.ts `vwapFrom` main line (hlc3 source), anchored per backtestSeries's
    computeRaw: accumulate from the first bar whose open time (epoch-ms) is at or
    after `anchor_ms`; anchor <= 0 means unplaced (all None); zero cumulative
    volume emits None (many CFD/forex epics report volume 0)."""
    n = len(candles)
    out: list[float | None] = [None] * n
    if anchor_ms <= 0:
        return out
    start = n
    for i, c in enumerate(candles):
        if int(c.time.timestamp() * 1000) >= anchor_ms:
            start = i
            break
    cum_pv = 0.0
    cum_v = 0.0
    for i in range(start, n):
        c = candles[i]
        price = hlc3(c)
        vol = c.volume
        cum_pv += price * vol
        cum_v += vol
        if cum_v <= 0:
            continue
        out[i] = cum_pv / cum_v
    return out
