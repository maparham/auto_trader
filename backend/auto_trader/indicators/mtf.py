"""MTF alignment + slope, ported from the frontend (mtf.ts alignHtfToChart with
waitClose=true, backtestSeries.ts slopeOf). The closed-bar rule is the whole
point: a base bar must never see an HTF bar that closes in its future, or the
strategy gains hindsight."""

from __future__ import annotations

from collections.abc import Sequence

from auto_trader.core.candle_aggregate import resolution_seconds
from auto_trader.core.models import Candle


def base_interval_ms_of(resolution: str | None) -> int | None:
    """`base_interval_ms` for align_htf_to_base from a resolution string, or
    None (gap-inference fallback) when the resolution is absent or unknown —
    an alias this can't parse must degrade to the old behaviour, not crash."""
    if not resolution:
        return None
    try:
        return resolution_seconds(resolution) * 1000
    except ValueError:
        return None


def align_htf_to_base(
    base_times_ms: Sequence[int],
    htf_candles: Sequence[Candle],
    htf_values: Sequence[float | None],
    htf_ms: int,
    *,
    base_interval_ms: int | None = None,
) -> list[float | None]:
    """Each base bar at time t takes the value of the most recent HTF bar whose
    CLOSE (open timestamp + htf_ms) is at or before t. Inputs sorted ascending;
    htf_values[i] corresponds to htf_candles[i].

    Same-timeframe pin: when the base bars' own interval equals htf_ms, the
    closed-bar gate would delay every value one bar for nothing — the value
    belongs to the bar that produced it, exactly as an unpinned operand reads
    it. `base_interval_ms` is the base resolution's nominal bar width; every
    rule-engine caller knows it and passes it, so the decision cannot be
    flipped by one anomalous sub-interval bar (session-open partial, DST) in
    whatever window this call happens to cover. Without it (older callers) the
    interval is inferred as the SMALLEST positive base-bar gap — the true
    interval across session/weekend holes, but wrong in exactly that
    anomalous-bar case."""
    interval = base_interval_ms if base_interval_ms is not None else _min_positive_gap(base_times_ms)
    same_tf = interval == htf_ms
    out: list[float | None] = [None] * len(base_times_ms)
    j = -1
    for i, t in enumerate(base_times_ms):
        while j + 1 < len(htf_candles):
            open_ms = int(htf_candles[j + 1].time.timestamp() * 1000)
            usable_at = open_ms if same_tf else open_ms + htf_ms
            if usable_at <= t:
                j += 1
            else:
                break
        if j >= 0:
            out[i] = htf_values[j]
    return out


def _min_positive_gap(times_ms: Sequence[int]) -> int | None:
    """Smallest positive gap between consecutive timestamps — the true bar
    interval even when session/weekend holes inflate individual gaps (the same
    discipline as the frontend's minPositiveGap in barInterval.ts)."""
    best: int | None = None
    for a, b in zip(times_ms, times_ms[1:]):
        d = b - a
        if d > 0 and (best is None or d < best):
            best = d
    return best


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
