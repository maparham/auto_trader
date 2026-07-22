from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

from auto_trader.core.models import Candle
from auto_trader.indicators.core import atr_series
from auto_trader.strategy.expr import nodes as N
from auto_trader.strategy.expr.evaluate import series_of


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
) -> list[float | None]:
    """Gap oriented toward firing per bar. Comparison: signed_gap(op,l,r).
    Cross: symmetric line distance abs(a - b) (proximity to touching)."""
    n = len(candles)
    if isinstance(node, N.Compare):
        left = series_of(node.left, candles, resolution, htf)
        right = series_of(node.right, candles, resolution, htf)
        return [signed_gap(node.op, left[i], right[i]) for i in range(n)]
    a = series_of(node.a, candles, resolution, htf)
    b = series_of(node.b, candles, resolution, htf)
    out: list[float | None] = []
    for i in range(n):
        if _defined(a[i]) and _defined(b[i]):
            # symmetric: distance to the cross, oriented as "short" so ramp warms
            # toward 1 as they converge. Represent as a non-positive gap.
            out.append(-abs(a[i] - b[i]))
        else:
            out.append(None)
    return out


def row_closeness(
    node: N.Compare | N.Cross,
    candles: Sequence[Candle],
    resolution: str,
    htf: dict[str, list[Candle]],
    norm: Norm,
) -> list[float | None]:
    gaps = row_gap_series(node, candles, resolution, htf)
    atr = atr_series(candles, norm.atr_length) if norm.basis == "atr" else None
    scale = scale_series(gaps, norm.basis, norm.width, norm.window, atr)
    return [ramp(gaps[i], scale[i]) for i in range(len(gaps))]
