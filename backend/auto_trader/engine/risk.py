"""Pure stop/target level math for the backtest engine.

The engine owns level computation (only it knows the real fill price) but keeps
the arithmetic here so it is unit-testable in isolation. No indicator math: ATR
values are read from the posted series and passed in as `atr`.
"""

from __future__ import annotations

from dataclasses import dataclass

# stop kinds: none|pct|price|atr|trailPct|trailAtr ; target drops the trail kinds.
_TRAIL_KINDS = {"trailPct", "trailAtr"}


@dataclass(frozen=True, slots=True)
class StopSpec:
    kind: str
    value: float | None = None   # pct percent, or absolute price
    mult: float | None = None    # ATR multiple
    length: int | None = None    # ATR length (series key ATR_{length})


@dataclass(frozen=True, slots=True)
class TargetSpec:
    kind: str
    value: float | None = None
    mult: float | None = None
    length: int | None = None


@dataclass(frozen=True, slots=True)
class RiskConfig:
    stop: StopSpec
    target: TargetSpec


def is_trailing(spec: StopSpec) -> bool:
    return spec.kind in _TRAIL_KINDS


def stop_level(
    spec: StopSpec, entry: float, side: str, atr: float | None, extreme: float
) -> float | None:
    """Absolute stop price, or None if there's no stop or it can't resolve
    (ATR still cold). `extreme` is the favorable high-water/low-water mark since
    entry — used only by the trailing kinds; fixed kinds measure off `entry`."""
    below = side == "long"  # a long's stop sits below its reference price
    k = spec.kind
    if k == "none":
        return None
    if k == "price":
        return spec.value
    if k == "pct":
        dist = entry * (spec.value / 100.0)
        return entry - dist if below else entry + dist
    if k == "atr":
        if atr is None:
            return None
        dist = spec.mult * atr
        return entry - dist if below else entry + dist
    if k == "trailPct":
        dist = extreme * (spec.value / 100.0)
        return extreme - dist if below else extreme + dist
    if k == "trailAtr":
        if atr is None:
            return None
        dist = spec.mult * atr
        return extreme - dist if below else extreme + dist
    raise ValueError(f"unknown stop kind {spec.kind!r}")


def target_level(spec: TargetSpec, entry: float, side: str, atr: float | None) -> float | None:
    """Absolute take-profit price, or None. Targets never trail."""
    above = side == "long"  # a long's target sits above entry
    k = spec.kind
    if k == "none":
        return None
    if k == "price":
        return spec.value
    if k == "pct":
        dist = entry * (spec.value / 100.0)
        return entry + dist if above else entry - dist
    if k == "atr":
        if atr is None:
            return None
        dist = spec.mult * atr
        return entry + dist if above else entry - dist
    raise ValueError(f"unknown target kind {spec.kind!r}")
