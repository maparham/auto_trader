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
    zone_name = opening_hours.get("zone") or "UTC"
    try:
        zone = ZoneInfo(zone_name)
    except (ZoneInfoNotFoundError, ValueError):
        zone = timezone.utc
    local = now.astimezone(zone)

    # Per-weekday parsed windows, indexed by _OH_DAYS position. A window whose end
    # wraps past midnight ("22:00 - 02:00") is split across the day boundary: the
    # part up to 24:00 stays on its day, the remainder (02:00) is prepended to the
    # next day. This keeps every stored window same-day (start < end) so the
    # open-now check and next-open scan stay simple, while still honouring a real
    # cross-midnight session if Capital ever sends one as a single entry.
    parsed: list[list[tuple[int, int]]] = [[] for _ in _OH_DAYS]

    def _parse_into(parsed_days: list[list[tuple[int, int]]]) -> None:
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
                if start < end:
                    parsed_days[di].append((start, end))
                elif start > end:
                    # Cross-midnight: split into [start, 24:00) today + [0, end) next day.
                    parsed_days[di].append((start, 1440))
                    parsed_days[(di + 1) % 7].append((0, end))

    _parse_into(parsed)

    # Day keys were present but NOTHING parsed out of them: that's a parser gap,
    # not a market that's shut all week, and it's indistinguishable from the
    # latter downstream (empty windows read as permanently closed — exactly how
    # the seconds-in-"HH:MM:SS" bug hid). Degrade to marketStatus instead.
    if any(opening_hours.get(day) for day in _OH_DAYS) and not any(parsed):
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
