"""Broker-agnostic opening-hours parsing, shared by Capital.com and IG.

Both brokers expose the same `openingHours` shape on their market-detail
payload (Capital originated the API IG later forked), so this parsing is
identical for both — see `_market_hours_state`'s docstring for the schema.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

# Capital's/IG's openingHours keys, Monday-first to line up with datetime.weekday().
_OH_DAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")


def _minute_of_day(hhmm: str) -> tuple[int, bool] | None:
    """"HH:MM" or "HH:MM:SS" -> (minutes since midnight, seconds were zero), or
    None if malformed.

    Capital quotes some instruments to the second ("20:59:50" is EUR/USD's
    Friday close), so a strict two-field parse dropped those windows entirely and
    badged the market closed all week. Seconds are truncated (minute resolution
    is all the badge needs); the flag lets the caller tell a literal "00:00" end
    (end-of-day) from an "00:00:30" one."""
    parts = str(hhmm).strip().split(":")
    if len(parts) < 2:
        return None
    try:
        h, m = int(parts[0]), int(parts[1])
        sec = int(parts[2]) if len(parts) > 2 else 0
    except ValueError:
        return None
    # Reject out-of-range values: an "HH" >= 24 would later reach datetime.replace
    # (when building next_open) and raise ValueError -> the endpoint 502s. Capital
    # encodes end-of-day as "00:00" (handled by the caller), never "24:00".
    if not (0 <= h <= 23 and 0 <= m <= 59 and 0 <= sec <= 59):
        return None
    return h * 60 + m, sec == 0


def _parse_days(
    opening_hours: dict, *, round_end_up: bool = False
) -> list[list[tuple[int, int]]] | None:
    """Per-weekday windows in minutes of the day, indexed by _OH_DAYS position,
    in the schedule's own zone. A window whose end wraps past midnight
    ("22:00 - 02:00") is split across the day boundary: the part up to 24:00
    stays on its day, the remainder is added to the next day, so every stored
    window is same-day (start < end).

    None when day keys carry windows but NOTHING parsed out of them: that is a
    parser gap, not a market that is shut all week, and it is indistinguishable
    from the latter downstream (empty windows read as permanently closed, which
    is how the seconds-in-"HH:MM:SS" bug hid). The caller degrades to
    marketStatus instead."""
    parsed: list[list[tuple[int, int]]] = [[] for _ in _OH_DAYS]
    for di, day_key in enumerate(_OH_DAYS):
        for w in opening_hours.get(day_key, []) or []:
            parts = [p.strip() for p in str(w).split("-")]
            if len(parts) != 2:
                continue
            parsed_start = _minute_of_day(parts[0])
            parsed_end = _minute_of_day(parts[1])
            if parsed_start is None or parsed_end is None:
                continue
            start, _ = parsed_start
            end, end_on_the_minute = parsed_end
            if end == 0 and end_on_the_minute:
                # A literal "00:00" as an END means end-of-day (24:00). An
                # "00:00:30" is a real 30-second-past-midnight end, not the
                # sentinel, so it must not be widened to a full day.
                end = 1440
            elif round_end_up and not end_on_the_minute:
                # "21:59:50" still trades in the 21:59 minute: an end with
                # seconds closes at the next minute, not the one before.
                end += 1
            if start < end:
                parsed[di].append((start, end))
            elif start > end:
                # Cross-midnight: split into [start, 24:00) today + [0, end) next day.
                parsed[di].append((start, 1440))
                parsed[(di + 1) % 7].append((0, end))
    if any(opening_hours.get(day) for day in _OH_DAYS) and not any(parsed):
        return None
    return parsed


def _zone_of(opening_hours: dict) -> ZoneInfo | timezone:
    try:
        return ZoneInfo(opening_hours.get("zone") or "UTC")
    except (ZoneInfoNotFoundError, ValueError):
        return timezone.utc


_WEEK_MIN = 7 * 1440


def week_sessions(opening_hours: dict | None, now: datetime) -> list[list[int]] | None:
    """The weekly schedule as sorted, merged `[start, end)` intervals in
    minutes of the UTC week (Monday 00:00 UTC = 0), for the chart's bar
    countdown. The schedule's zone is shifted by its offset at `now`. An
    interval never crosses the week edge: a session over Sunday midnight is
    two intervals, one ending at 10080 and one starting at 0.

    None when the hours are absent or unusable, as in `_market_hours_state`."""
    if not isinstance(opening_hours, dict):
        return None
    if not any(day in opening_hours for day in _OH_DAYS):
        return None
    parsed = _parse_days(opening_hours, round_end_up=True)
    if parsed is None:
        return None
    offset = now.astimezone(_zone_of(opening_hours)).utcoffset() or timedelta(0)
    shift = -int(offset.total_seconds() // 60)
    pieces: list[tuple[int, int]] = []
    for di, wins in enumerate(parsed):
        for start, end in wins:
            s = (di * 1440 + start + shift) % _WEEK_MIN
            e = s + (end - start)
            if e <= _WEEK_MIN:
                pieces.append((s, e))
            else:
                pieces.append((s, _WEEK_MIN))
                pieces.append((0, e - _WEEK_MIN))
    merged: list[list[int]] = []
    for s, e in sorted(pieces):
        if merged and s <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e])
    return merged


def _market_hours_state(
    opening_hours: dict | None, now: datetime
) -> tuple[bool | None, str | None]:
    """Derive (closed, next_open_iso) from Capital's `instrument.openingHours`.

    Why this and not `snapshot.marketStatus`: marketStatus is unreliable on the
    demo environment (it can report CLOSED while a real-time quote is still
    streaming and the instrument is inside its own trading window). openingHours
    is correct on both demo and live, so we treat IT as authoritative.

    The schedule is a per-weekday list of "HH:MM - HH:MM" windows in the zone
    named by `openingHours.zone` (usually UTC). An END of "00:00" means end of
    day (24:00), so "22:00 - 00:00" runs to midnight. Capital normally splits at
    the day boundary so windows don't spill over, but a single cross-midnight
    entry ("22:00 - 02:00", end < start) is still handled: it's split into a
    to-midnight part today plus the remainder on the next day.

    Returns (None, None) when openingHours is absent/unusable (missing, non-dict,
    or present but with no day keys) so the caller can fall back to marketStatus.
    `next_open_iso` is the next window start as a UTC
    ISO-8601 string (only set when currently closed), searched up to 8 days out."""
    if not isinstance(opening_hours, dict):
        return None, None
    # Present but carrying no day keys at all (e.g. {} or {"zone": "UTC"}) is
    # unusable — return (None, None) so the caller falls back to marketStatus,
    # rather than reading the absence of windows as "closed all week" (which would
    # badge a 24/7 instrument permanently closed if upstream ever sent empty hours).
    if not any(day in opening_hours for day in _OH_DAYS):
        return None, None
    zone = _zone_of(opening_hours)
    local = now.astimezone(zone)

    parsed = _parse_days(opening_hours)
    if parsed is None:
        return None, None

    def windows(day_key: str) -> list[tuple[int, int]]:
        return parsed[_OH_DAYS.index(day_key)]

    cur_min = local.hour * 60 + local.minute
    today = _OH_DAYS[local.weekday()]
    open_now = any(start <= cur_min < end for start, end in windows(today))
    if open_now:
        return False, None

    # Closed: find the next window start, scanning today's remaining windows then
    # forward day by day (up to a week + 1 to wrap a full cycle).
    for offset in range(0, 8):
        day = _OH_DAYS[(local.weekday() + offset) % 7]
        for start, _end in sorted(windows(day)):
            if offset == 0 and start <= cur_min:
                continue  # already past today
            opens = (local + timedelta(days=offset)).replace(
                hour=start // 60, minute=start % 60, second=0, microsecond=0
            )
            return True, opens.astimezone(timezone.utc).isoformat()
    return True, None  # closed with no upcoming window found
