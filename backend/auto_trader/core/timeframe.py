"""Timeframe grammar: parse, canonicalize, size and label any candle resolution.

A resolution is a native Capital name (MINUTE, HOUR_4, DAY, ...), a fixed
seconds key (SECOND_5, live only), YEAR, or UNIT_N with UNIT in
MINUTE|HOUR|DAY|WEEK|MONTH. Labels (7m, 6H, 2D, 3W, 4M, 1Y) and the D/W pin
aliases parse too. Every timeframe has ONE canonical string, and everything
that keys by resolution (cache keys, htfCandles, run records) uses it.

Mirrored by frontend/src/lib/timeframe.ts; both are pinned by
frontend/src/lib/timeframes.corpus.json.
"""

from __future__ import annotations

import re
from dataclasses import dataclass


class TimeframeError(ValueError):
    """An unparsable or out-of-limit timeframe. str(e) is user-facing."""


# Mirror of brokers.capital_stream.SECONDS_INTERVALS (core must not import
# brokers); test_timeframe asserts they agree.
SECONDS_KEYS: dict[str, int] = {
    "SECOND": 1, "SECOND_5": 5, "SECOND_10": 10,
    "SECOND_15": 15, "SECOND_30": 30, "SECOND_45": 45,
}

_UNIT_SECONDS = {"MINUTE": 60, "HOUR": 3600, "DAY": 86400, "WEEK": 604800, "MONTH": 30 * 86400}
_YEAR_SECONDS = 365 * 86400
_LIMITS = {"MINUTE": 1439, "HOUR": 24, "DAY": 365, "WEEK": 52, "MONTH": 12}
_UNIT_WORD = {"MINUTE": "minutes", "HOUR": "hours", "DAY": "days", "WEEK": "weeks", "MONTH": "months"}
_SUFFIX = {"MINUTE": "m", "HOUR": "H", "DAY": "D", "WEEK": "W", "MONTH": "M"}
_SUFFIX_UNIT = {v: k for k, v in _SUFFIX.items()}
_NATIVE = frozenset(
    {"MINUTE", "MINUTE_5", "MINUTE_15", "MINUTE_30", "HOUR", "HOUR_4", "DAY", "WEEK"}
)

_CANON_RE = re.compile(r"^(MINUTE|HOUR|DAY|WEEK|MONTH)(?:_(\d{1,5}))?$")
_LABEL_RE = re.compile(r"^(\d{1,5})([mHDWM])$")


@dataclass(frozen=True, slots=True)
class Timeframe:
    unit: str  # SECOND | MINUTE | HOUR | DAY | WEEK | MONTH | YEAR
    n: int


def _normalize(unit: str, n: int) -> Timeframe:
    if not 1 <= n <= _LIMITS[unit]:
        raise TimeframeError(f"{_UNIT_WORD[unit]} must be between 1 and {_LIMITS[unit]}")
    if unit == "MINUTE" and n % 60 == 0:
        return Timeframe("HOUR", n // 60)
    if unit == "HOUR" and n == 24:
        return Timeframe("DAY", 1)
    if unit == "MONTH" and n == 12:
        return Timeframe("YEAR", 1)
    return Timeframe(unit, n)


def parse(res: str) -> Timeframe:
    if not isinstance(res, str):
        raise TimeframeError("timeframe must be a string")
    if res in SECONDS_KEYS:
        return Timeframe("SECOND", SECONDS_KEYS[res])
    if res in ("YEAR", "1Y"):
        return Timeframe("YEAR", 1)
    if res == "D":
        return Timeframe("DAY", 1)
    if res == "W":
        return Timeframe("WEEK", 1)
    m = _CANON_RE.match(res)
    if m:
        return _normalize(m.group(1), int(m.group(2) or 1))
    m = _LABEL_RE.match(res)
    if m:
        return _normalize(_SUFFIX_UNIT[m.group(2)], int(m.group(1)))
    raise TimeframeError(
        f"unknown timeframe '{res[:40]}'. Use a number and a unit, like 7m, 6H, 2D, 3W or 2M"
    )


def _to_str(t: Timeframe) -> str:
    if t.unit == "YEAR":
        return "YEAR"
    if t.unit == "SECOND":
        return "SECOND" if t.n == 1 else f"SECOND_{t.n}"
    return t.unit if t.n == 1 else f"{t.unit}_{t.n}"


def canonicalize(res: str) -> str:
    return _to_str(parse(res))


def seconds(res: str) -> int:
    t = parse(res)
    if t.unit == "SECOND":
        return t.n
    if t.unit == "YEAR":
        return _YEAR_SECONDS
    return t.n * _UNIT_SECONDS[t.unit]


def label(res: str) -> str:
    t = parse(res)
    if t.unit == "SECOND":
        return f"{t.n}s"
    if t.unit == "YEAR":
        return "1Y"
    return f"{t.n}{_SUFFIX[t.unit]}"


def is_native(res: str) -> bool:
    return canonicalize(res) in _NATIVE
