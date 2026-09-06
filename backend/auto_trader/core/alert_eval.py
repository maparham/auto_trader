"""Pure price-alert evaluation — Python port of frontend/src/lib/alertEval.ts.

The crossing / once / every / re-arm logic with no storage or feed dependency.
The TS file remains the reference; its test suite is ported to
tests/test_alert_eval.py so the two implementations cannot drift while both
exist (the TS one is deleted at the end of this project).
"""
from __future__ import annotations

import math
from dataclasses import dataclass

# 5 bps: how far price must clear the level before an "every" alert re-arms.
RE_ARM_FRACTION = 5e-4


@dataclass(frozen=True)
class EvalResult:
    fired: bool
    next_armed: bool
    remove: bool


def evaluate_alert(
    prev: float | None,
    price: float,
    level: float,
    condition: str,
    trigger: str,
    armed: bool,
) -> EvalResult:
    """Evaluate one alert against a price tick. `prev` is the previous sample
    (None on the very first tick — crossings need two samples)."""
    unchanged = EvalResult(False, armed, False)
    if not (math.isfinite(price) and math.isfinite(level)):
        return unchanged

    # Level checks (greater/less) are satisfied by the current price alone, so
    # they may fire immediately — including when prev is None. Crossings wait.
    is_level_check = condition in ("greater", "less")
    if prev is None and not is_level_check:
        return unchanged

    cross_up = prev is not None and prev <= level < price
    cross_down = prev is not None and prev >= level > price
    if condition == "crossing":
        hit = cross_up or cross_down
    elif condition == "crossing_up":
        hit = cross_up
    elif condition == "crossing_down":
        hit = cross_down
    elif condition == "greater":
        hit = price > level
    elif condition == "less":
        hit = price < level
    else:
        return unchanged

    if hit and armed:
        if trigger == "once":
            return EvalResult(True, False, True)
        return EvalResult(True, False, False)  # disarm until cleared

    # Re-arm an "every" alert once price has cleared the level by the margin
    # (level checks re-arm only when the condition is FALSE again past it).
    if not armed and trigger == "every":
        margin = max(abs(level) * RE_ARM_FRACTION, 1e-10)
        if condition == "greater":
            can_re_arm = price < level - margin
        elif condition == "less":
            can_re_arm = price > level + margin
        else:
            can_re_arm = abs(price - level) > margin
        if can_re_arm:
            return EvalResult(False, True, False)
    return unchanged
