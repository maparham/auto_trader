"""MetaApi trade-session parsing for MT5 open/closed state.

MetaApi exposes a symbol's trading windows on `spec['tradeSessions']` — a
per-weekday map of `[{'from': 'hh.mm.ss.SSS', 'to': 'hh.mm.ss.SSS'}]` windows,
expressed in the BROKER's server timezone (not UTC). This is the MT5 analogue of
Capital's/IG's `openingHours` (parsed in `_market_hours.py`), but a different
shape, so it gets its own parser rather than shoehorning into that one.

Unlike Capital's schedule, MetaApi gives no timezone name — times are broker
wall-clock. The caller supplies `broker_now` (broker wall-clock) for the open-now
check and `utc_offset` (broker_now − utc_now) to convert the next-open instant
back to UTC for the frontend badge tooltip.

Like every weekly schedule, this has no holiday concept: a weekday holiday reads
as open. That's an accepted gap, matching the `openingHours` path.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone

# MetaApi's tradeSessions keys, Monday-first to line up with datetime.weekday().
_SESSION_DAYS = (
    "MONDAY",
    "TUESDAY",
    "WEDNESDAY",
    "THURSDAY",
    "FRIDAY",
    "SATURDAY",
    "SUNDAY",
)


def _minute_of_day(hms: str) -> int | None:
    """"hh.mm.ss.SSS" -> minutes since midnight (seconds/millis truncated), or None
    if malformed. "24:00:00.000" (MetaApi's end-of-day marker) maps to 1440.

    Accepts either separator: the SDK's own model docstring says dots
    ("hh.mm.ss.SSS") while its health monitor formats with colons, so real
    payloads could use either — we split on both rather than bet on one."""
    parts = re.split(r"[.:]", str(hms))
    if len(parts) < 2:
        return None
    try:
        h, m = int(parts[0]), int(parts[1])
    except ValueError:
        return None
    if h == 24 and m == 0:  # end-of-day sentinel
        return 1440
    if not (0 <= h <= 23 and 0 <= m <= 59):
        return None
    return h * 60 + m


def mt5_market_state(
    trade_sessions: dict | None,
    broker_now: datetime,
    utc_offset: timedelta,
) -> tuple[bool | None, str | None]:
    """Derive (closed, next_open_iso) from MetaApi's `tradeSessions`.

    `trade_sessions` is a per-weekday map (`MONDAY`..`SUNDAY`) of
    `[{'from': 'hh.mm.ss.SSS', 'to': 'hh.mm.ss.SSS'}]` windows in broker time.
    `broker_now` is the current broker wall-clock time; `utc_offset` is
    (broker_now − utc_now), used only to express the next-open instant as UTC.

    A window whose end wraps past midnight (from > to) is split across the day
    boundary so every stored window is same-day (start < end). An end of exactly
    24:00 means end-of-day.

    Returns (None, None) when `tradeSessions` is absent/unusable (missing, not a
    dict, or present with no day keys) so the caller leaves `closed` unknown
    rather than badging a symbol permanently closed. `next_open_iso` is the next
    window start as a UTC ISO-8601 string (only when currently closed), searched
    up to a week out."""
    if not isinstance(trade_sessions, dict):
        return None, None
    if not any(day in trade_sessions for day in _SESSION_DAYS):
        return None, None

    # Per-weekday parsed windows as (start_min, end_min), indexed by _SESSION_DAYS
    # position. Cross-midnight windows are split so start < end always holds.
    parsed: list[list[tuple[int, int]]] = [[] for _ in _SESSION_DAYS]
    for di, day_key in enumerate(_SESSION_DAYS):
        for w in trade_sessions.get(day_key, []) or []:
            if not isinstance(w, dict):
                continue
            start = _minute_of_day(w.get("from", ""))
            end = _minute_of_day(w.get("to", ""))
            if start is None or end is None:
                continue
            if start < end:
                parsed[di].append((start, end))
            elif start > end:
                # Cross-midnight: [start, 24:00) today + [0, end) next day.
                parsed[di].append((start, 1440))
                parsed[(di + 1) % 7].append((0, end))

    cur_min = broker_now.hour * 60 + broker_now.minute
    today = broker_now.weekday()
    open_now = any(start <= cur_min < end for start, end in parsed[today])
    if open_now:
        return False, None

    # Closed: find the next window start, scanning today's remaining windows then
    # forward day by day (a full week + 1 to wrap the cycle).
    for offset in range(0, 8):
        day = (today + offset) % 7
        for start, _end in sorted(parsed[day]):
            if offset == 0 and start <= cur_min:
                continue  # already past today
            opens_broker = (broker_now + timedelta(days=offset)).replace(
                hour=start // 60, minute=start % 60, second=0, microsecond=0
            )
            opens_utc = (opens_broker - utc_offset).replace(tzinfo=timezone.utc)
            return True, opens_utc.isoformat()
    return True, None  # closed with no upcoming window found
