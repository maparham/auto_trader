"""Walk-forward fold planning: pure schedule math, no I/O. Folds anchor to the
END of the range and walk backwards so the most recent data is always fully
used; any remainder drops at the oldest end. Chronological order returned."""
from __future__ import annotations

import re
from dataclasses import dataclass

_SPAN = re.compile(r"^(\d+)([dwmb])$")
_UNIT_SECONDS = {"d": 86400, "w": 7 * 86400, "m": 30 * 86400}

MIN_FOLDS = 3


def _days(seconds: float) -> str:
    d = round(seconds / 86400, 1)
    if d >= 1:
        return f"{d:g} day" + ("s" if d != 1 else "")
    h = round(seconds / 3600, 1)
    return f"{h:g} hour" + ("s" if h != 1 else "")


class WfoPlanError(Exception):
    """A schedule that cannot be planned (bad token, infeasible range)."""


def parse_span(token: str, res_seconds: int) -> int:
    m = _SPAN.match(token or "")
    if not m or int(m.group(1)) <= 0:
        raise WfoPlanError(
            f"bad span '{token}': use e.g. 10d, 2w, 3m, or 500b (bars)")
    n, unit = int(m.group(1)), m.group(2)
    return n * res_seconds if unit == "b" else n * _UNIT_SECONDS[unit]


@dataclass(frozen=True)
class Fold:
    train_from: int
    train_to: int
    test_from: int
    test_to: int


def plan(range_from: int, range_to: int, mode: str,
         train_s: int, test_s: int, step_s: int) -> list[Fold]:
    if range_to <= range_from:
        raise WfoPlanError("empty date range")
    folds: list[Fold] = []
    end = range_to
    while True:
        test_from = end - test_s
        train_from = range_from if mode == "anchored" else test_from - train_s
        if test_from <= range_from or train_from < range_from:
            break
        if mode == "anchored" and test_from - range_from < train_s:
            break  # anchored still needs the minimum train span
        folds.append(Fold(train_from=int(train_from), train_to=int(test_from),
                          test_from=int(test_from), test_to=int(end)))
        end -= step_s
    folds.reverse()
    if len(folds) < MIN_FOLDS:
        have = _days(range_to - range_from)
        need = _days(train_s + test_s + (MIN_FOLDS - 1) * step_s)
        raise WfoPlanError(
            f"Date range too short: {MIN_FOLDS} folds of "
            f"{_days(train_s)} train + {_days(test_s)} test need {need}, "
            f"but you have {have}. Widen the range or shorten the windows.")
    return folds
