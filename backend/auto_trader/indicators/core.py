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


def true_range_series(candles: Sequence[Candle]) -> list[float]:
    """atr.ts `trueRangeSeries` (Pine ta.tr(true)): TR[0] = high-low."""
    n = len(candles)
    tr = [0.0] * n
    for i, k in enumerate(candles):
        hl = k.high - k.low
        if i == 0:
            tr[i] = hl
        else:
            pc = candles[i - 1].close
            tr[i] = max(hl, abs(k.high - pc), abs(k.low - pc))
    return tr


def smooth_series(
    values: Sequence[float | None],
    type_: str,
    length: int,
    vol: Sequence[float] | None = None,
) -> list[float | None]:
    """indicators/smoothing.ts `smoothSeries`, op-for-op: TV-style MA over a
    sparse series. ema/rma seed with the first-window SMA; sma/wma/vwma are
    trailing windows walked BACKWARD from i (the walk order matters for FP
    parity). "none"/unknown -> all None."""
    n = len(values)
    out: list[float | None] = [None] * n
    L = max(1, int(length) or 1)
    if type_ not in ("sma", "ema", "rma", "wma", "vwma"):
        return out
    if type_ in ("ema", "rma"):
        alpha = 2 / (L + 1) if type_ == "ema" else 1 / L
        prev: float | None = None
        seed_sum = 0.0
        seed_count = 0
        for i in range(n):
            v = values[i]
            if v is None:
                continue
            if prev is None:
                seed_sum += v
                seed_count += 1
                if seed_count == L:
                    prev = seed_sum / L
                    out[i] = prev
            else:
                prev = alpha * v + (1 - alpha) * prev
                out[i] = prev
        return out
    for i in range(n):
        if values[i] is None:
            continue
        count = 0
        num = 0.0
        den = 0.0
        j = i
        while j >= 0 and count < L:
            v = values[j]
            if v is None:
                break
            if type_ == "wma":
                w: float = float(L - count)
            elif type_ == "vwma":
                w = float(vol[j]) if vol is not None and j < len(vol) else 0.0
            else:
                w = 1.0
            num += v * w
            den += w
            count += 1
            j -= 1
        if count == L and den > 0:
            out[i] = num / den
    return out


def atr_smoothed_series(
    candles: Sequence[Candle], length: int, smoothing: str
) -> list[float | None]:
    """atr.ts `atrSeries(candles, length, smoothing)`: TV's
    ma_function(ta.tr(true), length). "rma"/unknown is the legacy Wilder path
    (bit-identical to atr_series)."""
    if smoothing not in ("sma", "ema", "wma"):
        return atr_series(candles, length)
    n = len(candles)
    if length < 1 or n == 0:
        return [None] * n
    s = smooth_series(true_range_series(candles), smoothing, length)
    return s


def atr_series(candles: Sequence[Candle], length: int) -> list[float | None]:
    """atr.ts: TR[0] = high-low; first ATR = mean of first `length` TRs at index
    length-1; then Wilder-smoothed."""
    n = len(candles)
    out: list[float | None] = [None] * n
    if length < 1 or n == 0:
        return out
    tr = true_range_series(candles)
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


# Price sources, ported from mtf.ts priceOf. Order matters only for the tuple's
# use as a validation/error message list; "close" first because it is the default.
PRICE_SOURCES: tuple[str, ...] = (
    "close", "open", "high", "low", "hl2", "hlc3", "ohlc4", "hlcc4",
)


def price_of(c: Candle, src: str) -> float:
    """mtf.ts `priceOf`. Unknown sources fall back to close, matching the TS
    switch's `default` arm — a stored config with a stale source must not crash."""
    if src == "open":
        return c.open
    if src == "high":
        return c.high
    if src == "low":
        return c.low
    if src == "hl2":
        return (c.high + c.low) / 2
    if src == "hlc3":
        return (c.high + c.low + c.close) / 3
    if src == "ohlc4":
        return (c.open + c.high + c.low + c.close) / 4
    if src == "hlcc4":
        return (c.high + c.low + c.close + c.close) / 4
    return c.close


def vwma_series(
    candles: Sequence[Candle], prices: Sequence[float], length: int
) -> list[float | None]:
    """mtf.ts `vwma`: rolling sum(price*vol)/sum(vol). The subtractive rolling
    sums accumulate float residue, so a separate INTEGER count of
    volume-carrying bars is the emptiness test, not `v == 0` — otherwise a tiny
    residue would divide into garbage."""
    out: list[float | None] = [None] * len(prices)
    if length < 1:
        return out
    pv = 0.0
    v = 0.0
    nz = 0
    for i in range(len(prices)):
        vol = candles[i].volume or 0.0
        pv += prices[i] * vol
        v += vol
        if vol > 0:
            nz += 1
        if i >= length:
            old_vol = candles[i - length].volume or 0.0
            pv -= prices[i - length] * old_vol
            v -= old_vol
            if old_vol > 0:
                nz -= 1
        if i >= length - 1 and nz > 0:
            out[i] = pv / v
    return out


def evwma_series(
    candles: Sequence[Candle], prices: Sequence[float], length: int
) -> list[float | None]:
    """mtf.ts `evwma`: LazyBear's elastic volume-weighted MA. Seeds from the
    source PRICE at the first usable bar (not Pine's nz->0, which draws a
    near-zero ramp). A zero-volume WINDOW is undefined and re-seeds after."""
    out: list[float | None] = [None] * len(prices)
    if length < 1:
        return out
    nbfs = 0.0
    nz = 0
    prev: float | None = None
    for i in range(len(prices)):
        vol = candles[i].volume or 0.0
        nbfs += vol
        if vol > 0:
            nz += 1
        if i >= length:
            old_vol = candles[i - length].volume or 0.0
            nbfs -= old_vol
            if old_vol > 0:
                nz -= 1
        if i < length - 1:
            continue
        if nz <= 0:
            prev = None
            continue
        prev = prices[i] if prev is None else (prev * (nbfs - vol) + vol * prices[i]) / nbfs
        out[i] = prev
    return out
