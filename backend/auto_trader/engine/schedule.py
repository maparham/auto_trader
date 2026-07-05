"""Recurrence mask: a per-bar activity predicate for the backtest engine.

The mask NEVER filters candles — indicators compute over the full stream. This
only decides, per bar, whether the strategy may open a position (and, in the
engine, when to force-flat). A bar is active iff it passes EVERY enabled filter.

Wire conventions (shared with the frontend, do not diverge):
- days_of_week uses JS getDay: 0=Sun..6=Sat.
- months_of_year is 1=Jan..12=Dec.
- days_of_month is 1..31 calendar day.
- time_*_min are minutes from midnight in `tz`; window is half-open [start, end)
  and wraps when end < start (overnight sessions).
"""

from dataclasses import dataclass
from datetime import datetime
from zoneinfo import ZoneInfo


@dataclass(frozen=True)
class RecurrenceMask:
    enabled: bool = False
    days_of_week: tuple[int, ...] = ()        # JS getDay: 0=Sun..6=Sat; empty = all
    months_of_year: tuple[int, ...] = ()      # 1=Jan..12=Dec; empty = all
    days_of_month: tuple[int, ...] = ()       # 1..31 calendar day; empty = all
    time_start_min: int | None = None         # minutes from midnight, local to tz
    time_end_min: int | None = None
    tz: str = "UTC"


def _js_weekday(dt: datetime) -> int:
    # Python weekday(): 0=Mon..6=Sun. JS getDay(): 0=Sun..6=Sat.
    return (dt.weekday() + 1) % 7


def _in_window(minute: int, start: int, end: int) -> bool:
    if start == end:
        return True
    if start < end:
        return start <= minute < end
    return minute >= start or minute < end  # wraps past midnight


def is_active(mask: RecurrenceMask | None, dt: datetime) -> bool:
    if mask is None or not mask.enabled:
        return True
    local = dt.astimezone(ZoneInfo(mask.tz))
    if mask.days_of_week and _js_weekday(local) not in mask.days_of_week:
        return False
    if mask.months_of_year and local.month not in mask.months_of_year:
        return False
    if mask.days_of_month and local.day not in mask.days_of_month:
        return False
    if mask.time_start_min is not None and mask.time_end_min is not None:
        minute = local.hour * 60 + local.minute
        if not _in_window(minute, mask.time_start_min, mask.time_end_min):
            return False
    return True
