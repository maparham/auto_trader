"""IG maps expires_at to timeInForce=GOOD_TILL_DATE + goodTillDate (UTC,
yyyy/MM/dd HH:mm:ss). None keeps GOOD_TILL_CANCELLED."""

from __future__ import annotations

from datetime import datetime, timezone

from auto_trader.brokers.ig import _ig_gtd, _ig_parse_gtd


def test_ig_gtd_format_utc() -> None:
    when = datetime(2026, 7, 11, 16, 30, 0, tzinfo=timezone.utc)
    assert _ig_gtd(when) == "2026/07/11 16:30:00"


def test_ig_gtd_normalizes_to_utc() -> None:
    # A tz-aware non-UTC instant is converted to UTC before formatting.
    from datetime import timedelta
    est = timezone(timedelta(hours=-5))
    when = datetime(2026, 7, 11, 11, 30, 0, tzinfo=est)  # 16:30 UTC
    assert _ig_gtd(when) == "2026/07/11 16:30:00"


def _tif(order_expires):
    """Reproduce the create-body time-in-force fields the LIMIT branch builds."""
    tif = "GOOD_TILL_DATE" if order_expires is not None else "GOOD_TILL_CANCELLED"
    body = {"timeInForce": tif}
    if order_expires is not None:
        body["goodTillDate"] = _ig_gtd(order_expires)
    return body


def test_create_body_gtc_when_no_expiry() -> None:
    b = _tif(None)
    assert b == {"timeInForce": "GOOD_TILL_CANCELLED"}


def test_create_body_gtd_when_expiry_set() -> None:
    when = datetime(2026, 7, 11, 16, 30, tzinfo=timezone.utc)
    b = _tif(when)
    assert b["timeInForce"] == "GOOD_TILL_DATE"
    assert b["goodTillDate"] == "2026/07/11 16:30:00"


# --- C1: read-back parser (best-effort — IG dealing untested, format from docs) --

def test_ig_parse_gtd_roundtrips_ig_format() -> None:
    assert _ig_parse_gtd("2026/07/11 16:30:00") == datetime(2026, 7, 11, 16, 30, tzinfo=timezone.utc)


def test_ig_parse_gtd_accepts_unix_ms() -> None:
    when = datetime(2026, 7, 11, 16, 30, tzinfo=timezone.utc)
    ms = when.timestamp() * 1000
    assert _ig_parse_gtd(ms) == when


def test_ig_parse_gtd_none_on_missing_or_garbage() -> None:
    assert _ig_parse_gtd(None) is None
    assert _ig_parse_gtd("") is None
    assert _ig_parse_gtd("not-a-date") is None
