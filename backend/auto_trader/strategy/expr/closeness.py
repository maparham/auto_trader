from __future__ import annotations

import math
from collections.abc import Sequence


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
