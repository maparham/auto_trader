"""Broker pure helpers (no network)."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from unittest.mock import patch

import pytest

from auto_trader.brokers.capital import (
    CapitalComBroker,
    _market_hours_state,
    _mid,
    _price_precision,
)


@pytest.mark.parametrize(
    "tick, expected",
    [
        (1e-05, 5),   # EURUSD
        (0.001, 3),   # USDJPY
        (0.1, 1),     # US100
        (0.05, 2),    # BTCUSD
        (0.01, 2),    # GOLD
        (1e-09, 9),   # BTTUSD
        (1.0, 0),     # whole-number tick
    ],
)
def test_price_precision_from_ticksize(tick, expected):
    assert _price_precision({"tickSize": tick}) == expected


def test_price_precision_prefers_explicit_decimalplaces():
    assert _price_precision({"decimalPlaces": 4, "tickSize": 0.1}) == 4


def test_price_precision_none_when_no_signal():
    assert _price_precision({}) is None


def test_mid_returns_none_for_missing_sides():
    assert _mid(None) is None
    assert _mid({}) is None
    assert _mid({"bid": None, "ask": None}) is None


def test_mid_averages_and_falls_back():
    assert _mid({"bid": 100.0, "ask": 102.0}) == 101.0
    assert _mid({"bid": 100.0, "ask": None}) == 100.0
    assert _mid({"bid": None, "ask": 102.0}) == 102.0


class _FakeResp:
    def __init__(self, payload: dict) -> None:
        self._payload = payload

    def json(self) -> dict:
        return self._payload


def _broker_returning(
    payload: dict, now: datetime | None = None, base_url: str = "http://x"
) -> CapitalComBroker:
    # Construct without touching the network: just stub the single-market GET.
    # `now` (when given) freezes the clock get_market_meta reads for the
    # opening-hours calculation, so window-boundary cases are deterministic.
    # `base_url` defaults to a non-live test host so the marketStatus holiday
    # override stays off unless a test opts into a live host.
    broker = CapitalComBroker(api_key="k", identifier="i", password="p", base_url=base_url)

    async def _fake_get(path: str, params: dict) -> _FakeResp:
        return _FakeResp(payload)

    broker._get = _fake_get  # type: ignore[assignment]
    broker._frozen_now = now  # type: ignore[attr-defined]
    return broker


def _run_meta(broker: CapitalComBroker, epic: str):
    """Run get_market_meta, freezing the module clock to the broker's _frozen_now
    (if set) so opening-hours math is deterministic."""
    now = getattr(broker, "_frozen_now", None)
    if now is None:
        return asyncio.run(broker.get_market_meta(epic))

    class _FrozenDatetime(datetime):
        @classmethod
        def now(cls, tz=None):  # noqa: D102
            return now if tz is None else now.astimezone(tz)

    with patch("auto_trader.brokers.capital.datetime", _FrozenDatetime):
        return asyncio.run(broker.get_market_meta(epic))


# OIL_CRUDE's real openingHours (UTC), used to exercise the window parser.
_OIL_HOURS = {
    "mon": ["00:00 - 21:00", "22:00 - 00:00"],
    "tue": ["00:00 - 21:00", "22:00 - 00:00"],
    "wed": ["00:00 - 21:00", "22:00 - 00:00"],
    "thu": ["00:00 - 21:00", "22:00 - 00:00"],
    "fri": ["00:00 - 21:00"],
    "sat": [],
    "sun": ["22:00 - 00:00"],
    "zone": "UTC",
}


def _at(year, month, day, hour, minute=0):
    return datetime(year, month, day, hour, minute, tzinfo=timezone.utc)


@pytest.mark.parametrize(
    "dt, expected_open",
    [
        (_at(2026, 6, 25, 0, 11), True),   # Thu 00:11 — inside 00:00-21:00 (the live bug)
        (_at(2026, 6, 25, 23, 0), True),   # Thu 23:00 — inside 22:00-00:00 (end-of-day)
        (_at(2026, 6, 25, 21, 30), False), # Thu 21:30 — in the 21:00-22:00 gap
        (_at(2026, 6, 26, 21, 30), False), # Fri 21:30 — after the lone 00:00-21:00 session
        (_at(2026, 6, 27, 12, 0), False),  # Sat — empty schedule
        (_at(2026, 6, 28, 22, 30), True),  # Sun 22:30 — inside 22:00-00:00
        (_at(2026, 6, 28, 12, 0), False),  # Sun 12:00 — before the Sunday session
    ],
)
def test_market_hours_state_open_windows(dt, expected_open):
    closed, _next = _market_hours_state(_OIL_HOURS, dt)
    assert closed is (not expected_open)


def test_market_hours_state_handles_cross_midnight_window():
    # A single cross-midnight entry "22:00 - 02:00" must be honoured, not dropped:
    # the session runs from 22:00 through 02:00 the next day.
    hours = {"mon": ["22:00 - 02:00"], "tue": [], "zone": "UTC"}
    # Mon 23:00 — inside the to-midnight half.
    assert _market_hours_state(hours, _at(2026, 6, 22, 23, 0))[0] is False
    # Tue 01:00 — inside the spilled-over remainder on the next day.
    assert _market_hours_state(hours, _at(2026, 6, 23, 1, 0))[0] is False
    # Tue 03:00 — after the remainder ends; closed.
    assert _market_hours_state(hours, _at(2026, 6, 23, 3, 0))[0] is True
    # Mon 21:00 — before the session opens; closed, next open is 22:00 Monday.
    closed, next_open = _market_hours_state(hours, _at(2026, 6, 22, 21, 0))
    assert closed is True
    assert next_open == "2026-06-22T22:00:00+00:00"


def test_market_hours_state_reports_next_open_when_closed():
    # Saturday is empty; the next session is Sunday 22:00 UTC.
    closed, next_open = _market_hours_state(_OIL_HOURS, _at(2026, 6, 27, 12, 0))
    assert closed is True
    assert next_open == "2026-06-28T22:00:00+00:00"


def test_market_hours_state_unusable_hours_returns_none():
    # Missing / non-dict / dayless openingHours -> (None, None) so the caller can
    # fall back to marketStatus rather than reading it as closed-all-week.
    assert _market_hours_state(None, _at(2026, 6, 27, 12, 0)) == (None, None)
    assert _market_hours_state({}, _at(2026, 6, 27, 12, 0)) == (None, None)
    assert _market_hours_state({"zone": "UTC"}, _at(2026, 6, 27, 12, 0)) == (None, None)


def test_market_hours_state_ignores_out_of_range_window():
    # A malformed "HH" >= 24 must be dropped, not reach datetime.replace and raise
    # (which would 502 the endpoint). The day reads closed; other days still parse.
    hours = {"mon": ["25:00 - 26:00"], "tue": ["00:00 - 21:00"], "zone": "UTC"}
    closed, next_open = _market_hours_state(hours, _at(2026, 6, 22, 12, 0))  # Monday
    assert closed is True
    assert next_open == "2026-06-23T00:00:00+00:00"  # falls through to Tuesday's window


def test_get_market_meta_uses_opening_hours_not_marketstatus():
    # The live bug: marketStatus says CLOSED but the instrument is inside its
    # opening window. openingHours wins, so the market reads OPEN.
    broker = _broker_returning(
        {
            "snapshot": {"decimalPlacesFactor": 3, "marketStatus": "CLOSED"},
            "instrument": {"openingHours": _OIL_HOURS},
        },
        now=_at(2026, 6, 25, 0, 11),
    )
    meta = _run_meta(broker, "OIL_CRUDE")
    assert meta["pricePrecision"] == 3
    assert meta["closed"] is False
    assert meta["nextOpen"] is None
    assert meta["status"] == "CLOSED"  # raw value preserved for reference


def test_get_market_meta_live_marketstatus_overrides_open_for_holiday():
    # LIVE host: openingHours says we're inside the window, but marketStatus is
    # non-TRADEABLE (a weekday holiday the weekly schedule can't see). On live,
    # marketStatus is trusted, so the market reads closed.
    broker = _broker_returning(
        {
            "snapshot": {"decimalPlacesFactor": 3, "marketStatus": "CLOSED"},
            "instrument": {"openingHours": _OIL_HOURS},
        },
        now=_at(2026, 6, 25, 0, 11),  # Thu inside 00:00-21:00
        base_url="https://api-capital.backend-capital.com",
    )
    meta = _run_meta(broker, "OIL_CRUDE")
    assert meta["closed"] is True
    assert meta["nextOpen"] is None


def test_get_market_meta_demo_keeps_opening_hours_over_marketstatus():
    # DEMO host: same open-window + CLOSED marketStatus, but demo's CLOSED is
    # unreliable, so openingHours stays authoritative and the market reads open.
    broker = _broker_returning(
        {
            "snapshot": {"decimalPlacesFactor": 3, "marketStatus": "CLOSED"},
            "instrument": {"openingHours": _OIL_HOURS},
        },
        now=_at(2026, 6, 25, 0, 11),
        base_url="https://demo-api-capital.backend-capital.com",
    )
    meta = _run_meta(broker, "OIL_CRUDE")
    assert meta["closed"] is False


def test_get_market_meta_closed_outside_hours_with_next_open():
    broker = _broker_returning(
        {
            "snapshot": {"decimalPlacesFactor": 3, "marketStatus": "TRADEABLE"},
            "instrument": {"openingHours": _OIL_HOURS},
        },
        now=_at(2026, 6, 27, 12, 0),  # Saturday — closed
    )
    meta = _run_meta(broker, "OIL_CRUDE")
    assert meta["closed"] is True
    assert meta["nextOpen"] == "2026-06-28T22:00:00+00:00"


def test_get_market_meta_falls_back_to_marketstatus_without_hours():
    # No openingHours -> derive closed from marketStatus (non-TRADEABLE = closed).
    broker = _broker_returning(
        {"snapshot": {"decimalPlacesFactor": 5.0, "marketStatus": "TRADEABLE"}}
    )
    meta = _run_meta(broker, "EURUSD")
    assert meta == {"pricePrecision": 5, "closed": False, "nextOpen": None, "status": "TRADEABLE"}

    broker = _broker_returning(
        {"snapshot": {"decimalPlacesFactor": 5.0, "marketStatus": "CLOSED"}}
    )
    meta = _run_meta(broker, "EURUSD")
    assert meta["closed"] is True
    assert meta["nextOpen"] is None


def test_get_market_meta_falls_back_to_tick_for_precision():
    broker = _broker_returning(
        {"dealingRules": {"minStepDistance": {"value": 0.01}}}  # no snapshot
    )
    meta = _run_meta(broker, "GOLD")
    assert meta["pricePrecision"] == 2
    assert meta["closed"] is False  # no status, no hours -> defaults to open
