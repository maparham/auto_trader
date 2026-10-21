from __future__ import annotations

import asyncio
import datetime as dt

import pandas as pd

from auto_trader.brokers import yahoo_earnings as ye
from auto_trader.brokers.yahoo_earnings import Earnings, EarningsRegistry, merge_earnings


class FakeTicker:
    def __init__(self, df=None, cal=None, scrape_error=None, income=None):
        self._df = df
        self.calendar = cal
        self._scrape_error = scrape_error
        self.quarterly_income_stmt = income

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
        eps_estimate=1.89, eps_actual=2.02, surprise_pct=6.74,
    )


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
