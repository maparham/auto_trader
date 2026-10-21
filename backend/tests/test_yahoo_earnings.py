from __future__ import annotations

import asyncio
import datetime as dt

import pandas as pd

from auto_trader.brokers import yahoo_earnings as ye
from auto_trader.brokers.yahoo_earnings import Earnings, EarningsRegistry, merge_earnings


class FakeTicker:
    def __init__(self, df=None, cal=None, scrape_error=None, income=None, meta=None):
        self._df = df
        self.calendar = cal
        self._scrape_error = scrape_error
        self.quarterly_income_stmt = income
        self._meta = meta

    def get_history_metadata(self):
        if self._meta is None:
            raise RuntimeError("no metadata")
        return self._meta

    def get_earnings_dates(self, limit):
        if self._scrape_error:
            raise self._scrape_error
        return self._df


def _df():
    idx = pd.DatetimeIndex(
        [pd.Timestamp("2026-11-02 15:00", tz="America/New_York"),
         pd.Timestamp("2026-07-30 16:00", tz="America/New_York")],
        name="Earnings Date",
    )
    return pd.DataFrame(
        {"EPS Estimate": [1.98, 1.89], "Reported EPS": [float("nan"), 2.02],
         "Surprise(%)": [float("nan"), 6.74]},
        index=idx,
    )


def _patch(monkeypatch, ticker):
    import yfinance as yf

    monkeypatch.setattr(yf, "Ticker", lambda t: ticker)


def test_scraped_rows_carry_estimate_actual_and_surprise(monkeypatch):
    cal = {"Earnings Date": [dt.date(2026, 11, 2)], "Earnings Average": 1.98}
    _patch(monkeypatch, FakeTicker(_df(), cal))
    rows = ye.fetch_yahoo_earnings("AAPL")
    # The calendar's date is the scraped upcoming row: not doubled.
    assert len(rows) == 2
    up, past = rows
    assert up.eps_actual is None and up.surprise_pct is None and up.eps_estimate == 1.98
    assert past == Earnings(
        ts=int(pd.Timestamp("2026-07-30 16:00", tz="America/New_York").timestamp()),
        eps_estimate=1.89, eps_actual=2.02, surprise_pct=6.74, session="post",
    )
    # 15:00 is Yahoo's DST-skewed 16:00: still after the close.
    assert up.session == "post"


def test_revenue_estimate_and_actuals_attach_to_their_reports(monkeypatch):
    cal = {"Earnings Date": [dt.date(2026, 11, 2)], "Earnings Average": 1.98,
           "Revenue Average": 113.4e9}
    income = pd.DataFrame(
        [[109.4e9, 111.2e9]],
        index=["Total Revenue"],
        columns=[pd.Timestamp("2026-06-30"), pd.Timestamp("2026-03-31")],
    )
    _patch(monkeypatch, FakeTicker(_df(), cal, income=income))
    up, past = ye.fetch_yahoo_earnings("AAPL")
    # The scraped upcoming row borrows the calendar's revenue consensus.
    assert up.revenue_estimate == 113.4e9 and up.revenue_actual is None
    # 30 Jul reports the quarter that ended 30 Jun, not 31 Mar.
    assert past.revenue_actual == 109.4e9 and past.revenue_estimate is None


def test_revenue_only_matches_a_quarter_that_just_ended():
    report = Earnings(ts=1_000 * 86_400, eps_estimate=1.0, eps_actual=1.1, surprise_pct=10.0)
    too_old = [(report.ts - 200 * 86_400, 5.0)]
    after = [(report.ts + 86_400, 5.0)]
    assert merge_earnings([report], [], too_old)[0].revenue_actual is None
    assert merge_earnings([report], [], after)[0].revenue_actual is None


def test_calendar_fills_in_when_the_scrape_fails(monkeypatch):
    cal = {"Earnings Date": [dt.date(2026, 11, 2), dt.date(2026, 11, 6)], "Earnings Average": 1.98,
           "Revenue Average": 113.4e9}
    _patch(monkeypatch, FakeTicker(cal=cal, scrape_error=ImportError("lxml")))
    rows = ye.fetch_yahoo_earnings("AAPL")
    assert rows == [Earnings(
        ts=int(dt.datetime(2026, 11, 2, 12, tzinfo=dt.timezone.utc).timestamp()),
        eps_estimate=1.98, eps_actual=None, surprise_pct=None, revenue_estimate=113.4e9,
    )]


def test_report_session_by_exchange_local_hour():
    ny = lambda h, m=0: pd.Timestamp(f"2026-10-13 {h:02d}:{m:02d}", tz="America/New_York")  # noqa: E731
    assert ye.report_session(ny(6)) == "pre"
    assert ye.report_session(ny(9, 15)) == "pre"
    assert ye.report_session(ny(12)) == "intraday"
    assert ye.report_session(ny(16)) == "post"
    assert ye.report_session(ny(20)) == "post"


# Yahoo's chart metadata for a US listing: regular session 09:30 to 16:00 EDT.
_US_META = {
    "exchangeTimezoneName": "America/New_York",
    "currentTradingPeriod": {"regular": {"start": 1792589400, "end": 1792612800}},
}


def test_exchange_hours_name_the_time_the_session_hinges_on(monkeypatch):
    cal = {"Earnings Date": [dt.date(2026, 11, 2)], "Earnings Average": 1.98}
    _patch(monkeypatch, FakeTicker(_df(), cal, meta=_US_META))
    up, past = ye.fetch_yahoo_earnings("AAPL")
    # 2 Nov is past the DST switch: the close reads in EST.
    assert (up.session, up.session_time) == ("post", "16:00 EST")
    assert (past.session, past.session_time) == ("post", "16:00 EDT")


def test_hours_follow_the_exchange():
    london = ye.ExchangeHours("Europe/London", 8 * 60, 16 * 60 + 30)
    rows = [
        Earnings(ts=int(pd.Timestamp("2026-07-21 07:00", tz="Europe/London").timestamp()),
                 eps_estimate=None, eps_actual=None, surprise_pct=None, session="pre"),
        # 09:00 is before the US open but inside London's session.
        Earnings(ts=int(pd.Timestamp("2026-07-21 09:00", tz="Europe/London").timestamp()),
                 eps_estimate=None, eps_actual=None, surprise_pct=None, session="pre"),
    ]
    pre, during = ye.apply_hours(rows, london)
    assert (pre.session, pre.session_time) == ("pre", "08:00 BST")
    assert (during.session, during.session_time) == ("intraday", "08:00 to 16:30 BST")


def test_no_hours_keeps_the_us_guess_without_a_time(monkeypatch):
    _patch(monkeypatch, FakeTicker(_df(), {}))
    up, past = ye.fetch_yahoo_earnings("AAPL")
    assert past.session == "post" and past.session_time is None


def test_date_only_rows_stay_untimed():
    row = Earnings(ts=1_793_620_800, eps_estimate=1.0, eps_actual=None, surprise_pct=None)
    assert ye.apply_hours([row], ye._US_HOURS) == [row]


def test_calendar_only_date_has_no_session(monkeypatch):
    cal = {"Earnings Date": [dt.date(2026, 11, 2)]}
    _patch(monkeypatch, FakeTicker(cal=cal, scrape_error=ImportError("lxml")))
    assert ye.fetch_yahoo_earnings("AAPL")[0].session is None


def test_no_earnings_anywhere_is_empty(monkeypatch):
    # SPY: the scrape answers None, the calendar is empty.
    _patch(monkeypatch, FakeTicker(None, {}))
    assert ye.fetch_yahoo_earnings("SPY") == []


def test_merge_keeps_a_calendar_date_far_from_every_scraped_row():
    s = [Earnings(ts=1_000_000, eps_estimate=1.0, eps_actual=1.1, surprise_pct=10.0)]
    near = Earnings(ts=1_000_000 + 86_400, eps_estimate=2.0, eps_actual=None, surprise_pct=None)
    far = Earnings(ts=1_000_000 + 80 * 86_400, eps_estimate=2.0, eps_actual=None, surprise_pct=None)
    assert merge_earnings(s, [near]) == s
    assert merge_earnings(s, [far]) == s + [far]


def test_registry_sorts_and_caches_failures_as_empty():
    calls: list[str] = []

    def fetch(t):
        calls.append(t)
        raise RuntimeError("down")

    reg = EarningsRegistry(fetch)

    async def go():
        return await reg.get("AAPL"), await reg.get("AAPL")

    assert asyncio.run(go()) == ([], [])
    assert calls == ["AAPL"]


def test_registry_refuses_non_equities_without_asking():
    reg = EarningsRegistry(lambda t: (_ for _ in ()).throw(AssertionError("asked")))
    assert asyncio.run(reg.get("US100")) == []
