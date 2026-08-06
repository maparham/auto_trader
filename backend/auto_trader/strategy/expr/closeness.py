from __future__ import annotations

import bisect
import math
from collections.abc import Sequence
from dataclasses import dataclass

from auto_trader.core.models import Candle
from auto_trader.indicators.core import atr_series
from auto_trader.strategy.expr import nodes as N
from auto_trader.strategy.expr.evaluate import _cond_matches, series_of

# `instances` is an OPAQUE map {instance id -> resolved indicator instance},
# threaded straight through to series_of/_cond_matches. This package must never
# learn what any concrete indicator is, so it is deliberately untyped here.


def _defined(v: float | None) -> bool:
    return v is not None and not (isinstance(v, float) and math.isnan(v))


def signed_gap(op: str, left: float | None, right: float | None) -> float | None:
    """Gap oriented so >= 0 means the comparison holds."""
    if not (_defined(left) and _defined(right)):
        return None
    if op in (">", ">="):
        return left - right
    if op in ("<", "<="):
        return right - left
    raise ValueError(f"unsupported comparison op: {op}")


def ramp(gap: float | None, scale: float | None) -> float | None:
    """clamp(1 - relu(-gap)/scale, 0, 1). None if either input is undefined or
    scale is not a positive finite number."""
    if not _defined(gap) or not _defined(scale) or scale <= 0:
        return None
    short = max(0.0, -gap)
    return max(0.0, min(1.0, 1.0 - short / scale))


def avg_abs_gap(gaps: Sequence[float | None], window: int) -> list[float | None]:
    """Rolling mean of |gap| over the last `window` bars. A bar is None until it
    has a full window, and any None/NaN inside the window poisons that bar."""
    n = len(gaps)
    out: list[float | None] = [None] * n
    for i in range(n):
        if i + 1 < window:
            continue
        w = gaps[i - window + 1 : i + 1]
        if any(not _defined(v) for v in w):
            continue
        out[i] = sum(abs(float(v)) for v in w) / window  # type: ignore[arg-type]
    return out


def scale_series(
    gaps: Sequence[float | None],
    basis: str,
    width: float,
    window: int,
    atr: Sequence[float | None] | None,
) -> list[float | None]:
    """Per-bar normalization scale. volatility: width * rolling avg |gap|.
    atr: width * ATR (atr must be supplied, same length as gaps)."""
    n = len(gaps)
    if basis == "volatility":
        base = avg_abs_gap(gaps, window)
    elif basis == "atr":
        if atr is None:
            raise ValueError("atr basis requires an atr series")
        base = list(atr)
    else:
        raise ValueError(f"unknown normalization basis: {basis}")
    out: list[float | None] = [None] * n
    for i in range(n):
        b = base[i] if i < len(base) else None
        out[i] = width * b if _defined(b) else None
    return out


@dataclass(frozen=True, slots=True)
class Norm:
    basis: str  # "volatility" | "atr"
    width: float
    window: int  # rolling window for the volatility basis
    atr_length: int  # Wilder length for the ATR basis


def row_gap_series(
    node: N.Compare | N.Cross,
    candles: Sequence[Candle],
    resolution: str,
    htf: dict[str, list[Candle]],
    instances=None,
) -> list[float | None]:
    """Gap oriented toward firing per bar. Comparison: signed_gap(op,l,r).
    Cross: symmetric line distance abs(a - b) (proximity to touching)."""
    n = len(candles)
    if isinstance(node, N.Compare):
        left = series_of(node.left, candles, resolution, htf, instances)
        right = series_of(node.right, candles, resolution, htf, instances)
        return [signed_gap(node.op, left[i], right[i]) for i in range(n)]
    a = series_of(node.a, candles, resolution, htf, instances)
    b = series_of(node.b, candles, resolution, htf, instances)
    out: list[float | None] = []
    for i in range(n):
        if _defined(a[i]) and _defined(b[i]):
            # symmetric: distance to the cross, oriented as "short" so ramp warms
            # toward 1 as they converge. Represent as a non-positive gap.
            out.append(-abs(a[i] - b[i]))
        else:
            out.append(None)
    return out


def _fold(per: list[list[float | None]], combine: str, n: int) -> list[float | None]:
    """Combine per-row closeness by fuzzy logic: AND -> min, OR -> max. Any
    undefined row poisons the bar."""
    reduce = min if combine == "AND" else max
    out: list[float | None] = []
    for i in range(n):
        vals = [p[i] for p in per]
        out.append(None if any(v is None for v in vals) else reduce(vals))
    return out


def row_closeness(
    node: N.Row,
    candles: Sequence[Candle],
    resolution: str,
    htf: dict[str, list[Candle]],
    norm: Norm,
    instances=None,
) -> list[float | None]:
    if isinstance(node, N.Chain):
        per = [row_closeness(p, candles, resolution, htf, norm, instances) for p in node.parts]
        return _fold(per, "AND", len(candles))
    if isinstance(node, N.Predicate):
        # A predicate is binary: closeness is 1 when it holds, else 0. There is
        # no meaningful gradient toward "almost red".
        m = _cond_matches(node, candles, resolution, htf, instances)
        return [1.0 if v else 0.0 for v in m]
    gaps = row_gap_series(node, candles, resolution, htf, instances)
    atr = atr_series(candles, norm.atr_length) if norm.basis == "atr" else None
    scale = scale_series(gaps, norm.basis, norm.width, norm.window, atr)
    return [ramp(gaps[i], scale[i]) for i in range(len(gaps))]


def group_closeness(
    rows: list[N.Row],
    combine: str,
    candles: Sequence[Candle],
    resolution: str,
    htf: dict[str, list[Candle]],
    norm: Norm,
    instances=None,
) -> list[float | None]:
    """Fold per-row closeness by the group operator, strict fuzzy logic:
    AND -> min, OR -> max. Any undefined row poisons the bar. No rows -> all
    None (an empty group never fires)."""
    n = len(candles)
    if not rows:
        return [None] * n
    per = [row_closeness(r, candles, resolution, htf, norm, instances) for r in rows]
    return _fold(per, combine, n)


def aggregate_to_display(
    base_times: Sequence[int],
    base_vals: Sequence[float | None],
    display_opens: Sequence[int],
    agg: str,
) -> tuple[list[int], list[float | None]]:
    """Group base bars into display bars and reduce each. `display_opens` are the
    actual display-bar open timestamps (from the display candles the chart shows),
    so week/month/session-anchored bars align exactly instead of being guessed by
    epoch-modulo. Each base bar is assigned to the latest display open at or before
    it (`bisect_right - 1`); base bars before the first display open are dropped.
    None values are skipped; an all-None bucket yields None. Returns only the
    display bars that received at least one base bar, ascending by open."""
    opens = sorted(set(display_opens))
    buckets: dict[int, list[float]] = {}
    order: list[int] = []
    for t, v in zip(base_times, base_vals):
        i = bisect.bisect_right(opens, t) - 1
        if i < 0:
            continue  # base bar precedes the first display bar; no home for it
        key = opens[i]
        if key not in buckets:
            buckets[key] = []
            order.append(key)
        if _defined(v):
            buckets[key].append(float(v))
    order.sort()
    out_t: list[int] = []
    out_v: list[float | None] = []
    for key in order:
        vals = buckets[key]
        out_t.append(key)
        if not vals:
            out_v.append(None)
        elif agg == "max":
            out_v.append(max(vals))
        elif agg == "avg":
            out_v.append(sum(vals) / len(vals))
        elif agg == "last":
            out_v.append(vals[-1])
        else:
            raise ValueError(f"unknown agg: {agg}")
    return out_t, out_v
