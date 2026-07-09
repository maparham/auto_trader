"""MTF alignment + slope, ported from the frontend (mtf.ts alignHtfToChart with
waitClose=true, backtestSeries.ts slopeOf). The closed-bar rule is the whole
point: a base bar must never see an HTF bar that closes in its future, or the
strategy gains hindsight."""

from __future__ import annotations

from collections.abc import Sequence

from auto_trader.core.models import Candle


def align_htf_to_base(
    base_times_ms: Sequence[int],
    htf_candles: Sequence[Candle],
    htf_values: Sequence[float | None],
    htf_ms: int,
) -> list[float | None]:
    """Each base bar at time t takes the value of the most recent HTF bar whose
    CLOSE (open timestamp + htf_ms) is at or before t. Inputs sorted ascending;
    htf_values[i] corresponds to htf_candles[i]."""
    out: list[float | None] = [None] * len(base_times_ms)
    j = -1
    for i, t in enumerate(base_times_ms):
        while j + 1 < len(htf_candles):
            usable_at = int(htf_candles[j + 1].time.timestamp() * 1000) + htf_ms
            if usable_at <= t:
                j += 1
            else:
                break
        if j >= 0:
            out[i] = htf_values[j]
    return out


def slope_of(
    raw: Sequence[float | None], n: int, bar_hours: float
) -> list[float | None]:
    """Tangent rate of change in percent per HOUR over n bars (time-normalized so
    slopes on different timeframes compare directly):
        (v[i] − v[i−n]) / |v[i−n]| / (n × bar_hours) × 100
    None for the first n bars, wherever raw is None, or a zero denominator."""
    out: list[float | None] = [None] * len(raw)
    for i, v in enumerate(raw):
        if i < n or v is None:
            continue
        prev = raw[i - n]
        if prev is None or prev == 0:
            continue
        out[i] = (v - prev) / abs(prev) / (n * bar_hours) * 100
    return out
