"""Unit tests for MetaApi tradeSessions → (closed, nextOpen) parsing.

The parser is pure (no MetaApi), so these drive it directly with hand-built
weekly schedules and broker-time "now" values. Broker time is wall-clock; the
utc_offset arg only shifts the emitted nextOpen instant into UTC."""

from datetime import datetime, timedelta, timezone

from auto_trader.brokers._mt5_hours import mt5_market_state

# A round-the-clock forex-style schedule: open Mon–Fri all day, plus the Sunday
# evening open (22:00 → end of day). Saturday is closed. Times are broker time.
_FX_SESSIONS = {
    "MONDAY": [{"from": "00:00:00.000", "to": "24:00:00.000"}],
    "TUESDAY": [{"from": "00:00:00.000", "to": "24:00:00.000"}],
    "WEDNESDAY": [{"from": "00:00:00.000", "to": "24:00:00.000"}],
    "THURSDAY": [{"from": "00:00:00.000", "to": "24:00:00.000"}],
    "FRIDAY": [{"from": "00:00:00.000", "to": "22:00:00.000"}],
    "SUNDAY": [{"from": "22:00:00.000", "to": "24:00:00.000"}],
}

_ZERO = timedelta(0)


def test_open_inside_a_window():
    # Wednesday noon broker time — inside Wed's all-day window.
    now = datetime(2026, 7, 8, 12, 0)  # Wed
    closed, next_open = mt5_market_state(_FX_SESSIONS, now, _ZERO)
    assert closed is False
    assert next_open is None


def test_closed_saturday_next_open_is_sunday_evening():
    now = datetime(2026, 7, 11, 12, 0)  # Sat (no sessions)
    closed, next_open = mt5_market_state(_FX_SESSIONS, now, _ZERO)
    assert closed is True
    # Next open is Sunday 22:00; with zero offset, that's 22:00 UTC the next day.
    assert next_open == datetime(2026, 7, 12, 22, 0, tzinfo=timezone.utc).isoformat()


def test_closed_friday_evening_after_close():
    now = datetime(2026, 7, 10, 22, 30)  # Fri, after 22:00 close
    closed, next_open = mt5_market_state(_FX_SESSIONS, now, _ZERO)
    assert closed is True
    assert next_open == datetime(2026, 7, 12, 22, 0, tzinfo=timezone.utc).isoformat()


def test_utc_offset_shifts_next_open():
    # Broker is 3h ahead of UTC (offset = broker − utc = +3h). A Sunday 22:00
    # broker open is therefore 19:00 UTC.
    now = datetime(2026, 7, 11, 12, 0)  # Sat
    closed, next_open = mt5_market_state(_FX_SESSIONS, now, timedelta(hours=3))
    assert closed is True
    assert next_open == datetime(2026, 7, 12, 19, 0, tzinfo=timezone.utc).isoformat()


def test_cross_midnight_window_splits_across_days():
    # A single window that wraps midnight: Friday 22:00 → Saturday 02:00.
    sessions = {"FRIDAY": [{"from": "22:00:00.000", "to": "02:00:00.000"}]}
    # Saturday 01:00 falls in the spilled-over [00:00, 02:00) part → open.
    sat_open = datetime(2026, 7, 11, 1, 0)  # Sat
    assert mt5_market_state(sessions, sat_open, _ZERO)[0] is False
    # Saturday 03:00 is past it → closed.
    assert mt5_market_state(sessions, datetime(2026, 7, 11, 3, 0), _ZERO)[0] is True


def test_boundaries_are_half_open():
    sessions = {"MONDAY": [{"from": "08:00:00.000", "to": "16:00:00.000"}]}
    mon = datetime(2026, 7, 6)  # Mon
    assert mt5_market_state(sessions, mon.replace(hour=8), _ZERO)[0] is False  # start inclusive
    assert mt5_market_state(sessions, mon.replace(hour=16), _ZERO)[0] is True  # end exclusive
    assert mt5_market_state(sessions, mon.replace(hour=7, minute=59), _ZERO)[0] is True


def test_missing_or_unusable_sessions_return_unknown():
    now = datetime(2026, 7, 8, 12, 0)
    assert mt5_market_state(None, now, _ZERO) == (None, None)
    assert mt5_market_state({}, now, _ZERO) == (None, None)
    assert mt5_market_state({"zone": "UTC"}, now, _ZERO) == (None, None)  # no day keys
    assert mt5_market_state("nope", now, _ZERO) == (None, None)


def test_malformed_windows_are_skipped_not_fatal():
    sessions = {
        "WEDNESDAY": [
            {"from": "bad", "to": "16:00:00.000"},  # unparseable start → skipped
            {"from": "09:00:00.000"},  # missing 'to' → skipped
            {"from": "09:00:00.000", "to": "17:00:00.000"},  # the good one
        ]
    }
    now = datetime(2026, 7, 8, 12, 0)  # Wed, inside 09:00–17:00
    assert mt5_market_state(sessions, now, _ZERO)[0] is False
