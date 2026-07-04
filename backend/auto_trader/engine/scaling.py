"""Scaling config for the backtest: how many independent positions a side may
hold and how far apart their opens must be. Pure spacing math lives here; the
engine owns the cap and calls this per candidate open."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class SpacingSpec:
    kind: str            # "pct" | "atr"
    value: float | None = None   # pct: percent of last open
    mult: float | None = None    # atr: multiple
    length: int | None = None    # atr: series length (ATR_{length})


@dataclass(frozen=True, slots=True)
class ScalingConfig:
    max_concurrent: int = 1
    spacing: SpacingSpec | None = None


def spacing_ok(
    spec: SpacingSpec | None, last_open: float | None, fill_price: float,
    side: str, atr: float | None,
) -> bool:
    """True if `fill_price` is far enough in the FAVORABLE direction from the
    side's last open to permit another open. No spec or no prior open => True.
    A required-but-cold ATR => False (don't open on missing data)."""
    if spec is None or last_open is None:
        return True
    if spec.kind == "pct":
        dist = last_open * (spec.value / 100.0)
    elif spec.kind == "atr":
        if atr is None:
            return False
        dist = spec.mult * atr
    else:
        return True
    if side == "long":
        return fill_price >= last_open + dist
    return fill_price <= last_open - dist
