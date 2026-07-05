from datetime import datetime, timezone

from auto_trader.engine.schedule import RecurrenceMask, is_active


def _utc(y, mo, d, h=0, mi=0):
    return datetime(y, mo, d, h, mi, tzinfo=timezone.utc)


def test_no_mask_is_always_active():
    assert is_active(None, _utc(2024, 1, 1)) is True


def test_disabled_mask_is_always_active():
    m = RecurrenceMask(enabled=False, days_of_week=(1,))  # Monday only, but disabled
    assert is_active(m, _utc(2024, 1, 6)) is True  # a Saturday


def test_days_of_week_js_convention():
    # 2024-01-01 is a Monday. JS getDay Monday == 1.
    mon = RecurrenceMask(enabled=True, days_of_week=(1,))
    assert is_active(mon, _utc(2024, 1, 1)) is True   # Monday
    assert is_active(mon, _utc(2024, 1, 2)) is False  # Tuesday


def test_days_of_week_uses_tz():
    # 2024-01-01 23:00 UTC is Tuesday 08:00 in Tokyo. JS getDay Tue == 2.
    tue_tokyo = RecurrenceMask(enabled=True, days_of_week=(2,), tz="Asia/Tokyo")
    assert is_active(tue_tokyo, _utc(2024, 1, 1, 23, 0)) is True


def test_months_and_days_of_month():
    m = RecurrenceMask(enabled=True, months_of_year=(1,), days_of_month=(1, 15))
    assert is_active(m, _utc(2024, 1, 15)) is True
    assert is_active(m, _utc(2024, 1, 16)) is False
    assert is_active(m, _utc(2024, 2, 1)) is False  # wrong month


def test_time_of_day_half_open_window():
    m = RecurrenceMask(enabled=True, time_start_min=9 * 60 + 30, time_end_min=11 * 60)
    assert is_active(m, _utc(2024, 1, 1, 9, 30)) is True   # inclusive start
    assert is_active(m, _utc(2024, 1, 1, 10, 59)) is True
    assert is_active(m, _utc(2024, 1, 1, 11, 0)) is False  # exclusive end
    assert is_active(m, _utc(2024, 1, 1, 9, 29)) is False


def test_time_of_day_wraps_overnight():
    # Overnight window 22:00 -> 02:00 (evaluated in UTC here).
    m = RecurrenceMask(enabled=True, time_start_min=22 * 60, time_end_min=2 * 60)
    assert is_active(m, _utc(2024, 1, 1, 23, 0)) is True
    assert is_active(m, _utc(2024, 1, 1, 1, 0)) is True
    assert is_active(m, _utc(2024, 1, 1, 12, 0)) is False


def test_filters_are_anded():
    m = RecurrenceMask(enabled=True, days_of_week=(1,), time_start_min=9 * 60, time_end_min=17 * 60)
    assert is_active(m, _utc(2024, 1, 1, 10, 0)) is True    # Monday, in window
    assert is_active(m, _utc(2024, 1, 1, 18, 0)) is False   # Monday, out of window
    assert is_active(m, _utc(2024, 1, 2, 10, 0)) is False   # Tuesday, in window
