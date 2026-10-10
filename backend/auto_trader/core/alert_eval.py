"""Pure alert evaluation: one decision for every alert kind.

Each sample is a `(subject, level)` pair: price vs a fixed level for
price-level alerts, price vs an indicator line, or an indicator line vs a
number. A crossing compares the sign of `subject - level` before and after,
so it holds whichever side moved. `trigger = every` fires at most once per bar
of the alert's timeframe: the caller passes the current bar's open and the bar
the alert last fired in. This module is the single implementation (the old
frontend twin is gone).
"""
from __future__ import annotations

import math
from dataclasses import dataclass

Pair = tuple[float, float]


@dataclass(frozen=True)
class EvalResult:
    fired: bool
    remove: bool


def _finite(p: Pair) -> bool:
    return math.isfinite(p[0]) and math.isfinite(p[1])


def condition_hit(prev: Pair | None, cur: Pair, condition: str) -> bool:
    """`greater`/`less` read the current pair alone (may fire on the first
    sample); crossings need a previous pair. `<=`/`>=` on the BEFORE gap keep
    the touch-then-cross semantics: a gap of 0 then >0 is a cross up, but a
    gap going to exactly 0 is only a touch."""
    if not _finite(cur):
        return False
    now = cur[0] - cur[1]
    if condition == "greater":
        return now > 0
    if condition == "less":
        return now < 0
    if prev is None or not _finite(prev):
        return False
    before = prev[0] - prev[1]
    up = before <= 0 < now
    down = before >= 0 > now
    if condition == "crossing":
        return up or down
    if condition == "crossing_up":
        return up
    if condition == "crossing_down":
        return down
    return False


def evaluate_alert(
    prev: Pair | None,
    cur: Pair,
    condition: str,
    trigger: str,
    bar_open: int,
    last_fired_bar: int | None,
) -> EvalResult:
    if last_fired_bar is not None and bar_open <= last_fired_bar:
        return EvalResult(False, False)
    if not condition_hit(prev, cur, condition):
        return EvalResult(False, False)
    return EvalResult(True, trigger == "once")
