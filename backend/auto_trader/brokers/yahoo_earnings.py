"""Earnings dates from Yahoo Finance, past and upcoming, for the chart's
earnings markers (/api/market/{epic}/earnings).

Past quarters come from Ticker.get_earnings_dates, which scrapes Yahoo's
earnings calendar page (needs lxml) and also lists the next scheduled report
with its estimate. Ticker.calendar is an API call that names the next date
(date only) with the EPS consensus; it fills in when the scrape has no
upcoming row, and carries the revenue consensus. Revenue actuals come from the
quarterly income statement, which only reaches back about five quarters; Yahoo
keeps no history of past revenue estimates. A reported quarter never changes and the next date moves rarely,
so one lookup per symbol per half day is plenty.

Same failure semantics as yahoo_splits.py: any failure (no lxml, unknown
ticker, Yahoo down) reads as "no earnings" and is cached like a hit. Each
source fails on its own, so a broken scrape still leaves the calendar's date.
"""

from __future__ import annotations

import datetime as dt
import logging
import math
from collections.abc import Sequence
from dataclasses import dataclass, replace
from zoneinfo import ZoneInfo

from auto_trader.brokers.yahoo_splits import YahooTickerCache

log = logging.getLogger(__name__)

PAST_LIMIT = 40  # ten years of quarters
# A calendar date within this of a scraped row is the same report.
_SAME_REPORT_S = 3 * 86_400
# Calendar dates carry no time: pin them to midday UTC so they land inside the
# report day's bar wherever the exchange sits relative to UTC.
_DATE_ONLY_HOUR = 12
# A report lands within this of its fiscal quarter's end (AAPL: ~30 days;
# late filers up to ~90).
_REPORT_LAG_S = 100 * 86_400
# Report session by the exchange-local hour Yahoo stamps, against the
# exchange's regular hours (US hours when Yahoo gives none). Its times are
# hour-rounded and an upcoming report past a DST switch can read an hour early
# (AAPL's 16:00 shows as 15:00), so the hour before the close still counts as
# after it.
_CLOSE_SLACK_MIN = 60


@dataclass(frozen=True)
class ExchangeHours:
    tz: str  # IANA zone, e.g. America/New_York
    open_min: int  # regular session, minutes after local midnight
    close_min: int


_US_HOURS = ExchangeHours("America/New_York", 9 * 60 + 30, 16 * 60)


@dataclass(frozen=True)
class Earnings:
    ts: int  # unix seconds of the report (midday UTC when only the date is known)
    eps_estimate: float | None
    eps_actual: float | None  # None until reported
    surprise_pct: float | None
    revenue_estimate: float | None = None  # upcoming report only
    revenue_actual: float | None = None  # the last ~5 reported quarters only
    session: str | None = None  # "pre" | "intraday" | "post"; None when only the date is known
    # The exchange's own time the session hinges on, on the report's date:
    # "09:30 EDT" (open) before it, "16:00 EST" (close) after, "09:30 to
    # 16:00 EDT" during. None when Yahoo gave no hours or no report time.
    session_time: str | None = None


def _num(v: object) -> float | None:
    try:
        f = float(v)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return None if math.isnan(f) or math.isinf(f) else f


def report_session(local: dt.datetime, hours: ExchangeHours = _US_HOURS) -> str:
    """Before the open, during the session or after the close, from the
    report's exchange-local wall time."""
    m = local.hour * 60 + local.minute
    if m < hours.open_min:
        return "pre"
    return "post" if m >= hours.close_min - _CLOSE_SLACK_MIN else "intraday"


def _hours(t: object) -> ExchangeHours | None:
    """The exchange's regular session, from Yahoo's chart metadata."""
    meta = t.get_history_metadata() or {}  # type: ignore[attr-defined]
    reg = (meta.get("currentTradingPeriod") or {}).get("regular") or {}
    tz = meta.get("exchangeTimezoneName")
    if not tz or "start" not in reg or "end" not in reg:
        return None
    zone = ZoneInfo(tz)
    a = dt.datetime.fromtimestamp(reg["start"], zone)
    b = dt.datetime.fromtimestamp(reg["end"], zone)
    return ExchangeHours(tz, a.hour * 60 + a.minute, b.hour * 60 + b.minute)


def _hhmm(minutes: int) -> str:
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def apply_hours(rows: list[Earnings], hours: ExchangeHours | None) -> list[Earnings]:
    """Re-judge each timed report's session against the exchange's own hours
    and name the time it hinges on. Date-only rows (session None) stay as is."""
    if hours is None:
        return rows
    zone = ZoneInfo(hours.tz)
    out = []
    for e in rows:
        if e.session is None:
            out.append(e)
            continue
        local = dt.datetime.fromtimestamp(e.ts, zone)
        session = report_session(local, hours)

        def at(minutes: int) -> dt.datetime:
            return dt.datetime.combine(
                local.date(), dt.time(minutes // 60, minutes % 60), tzinfo=zone
            )

        abbr = at(hours.close_min if session == "post" else hours.open_min).tzname() or ""
        if session == "pre":
            label = f"{_hhmm(hours.open_min)} {abbr}"
        elif session == "post":
            label = f"{_hhmm(hours.close_min)} {abbr}"
        else:
            label = f"{_hhmm(hours.open_min)} to {_hhmm(hours.close_min)} {abbr}"
        out.append(replace(e, session=session, session_time=label.strip()))
    return out


def _scraped(t: object) -> list[Earnings]:
    df = t.get_earnings_dates(limit=PAST_LIMIT)  # type: ignore[attr-defined]
    if df is None:
        return []
    return [
        Earnings(
            ts=int(idx.timestamp()),
            eps_estimate=_num(row.get("EPS Estimate")),
            eps_actual=_num(row.get("Reported EPS")),
            surprise_pct=_num(row.get("Surprise(%)")),
            # The index is in the exchange's own timezone.
            session=report_session(idx),
        )
        for idx, row in df.iterrows()
    ]


def _calendar(t: object) -> list[Earnings]:
    cal = t.calendar or {}  # type: ignore[attr-defined]
    dates = cal.get("Earnings Date") or []
    if not dates:
        return []
    # Yahoo sometimes gives a window (two dates) before the date is confirmed:
    # its start is the earliest the report can land.
    d = dates[0]
    ts = int(
        dt.datetime(d.year, d.month, d.day, _DATE_ONLY_HOUR, tzinfo=dt.timezone.utc).timestamp()
    )
    return [
        Earnings(
            ts=ts,
            eps_estimate=_num(cal.get("Earnings Average")),
            eps_actual=None,
            surprise_pct=None,
            revenue_estimate=_num(cal.get("Revenue Average")),
        )
    ]


def _revenue(t: object) -> list[tuple[int, float]]:
    """(fiscal quarter end, total revenue), from the quarterly income statement."""
    q = t.quarterly_income_stmt  # type: ignore[attr-defined]
    if q is None or "Total Revenue" not in q.index:
        return []
    out = []
    for end, v in q.loc["Total Revenue"].items():
        f = _num(v)
        if f is not None:
            out.append((int(end.timestamp()), f))
    return out


def merge_earnings(
    scraped: list[Earnings],
    calendar: list[Earnings],
    revenue: Sequence[tuple[int, float]] = (),
) -> list[Earnings]:
    """Scraped rows, plus each calendar date no scraped row already covers (a
    covered one lends the scraped row its revenue estimate), with each reported
    row's revenue from the latest quarter that ended shortly before it."""
    out = list(scraped)
    for c in calendar:
        same = [i for i, s in enumerate(out) if abs(c.ts - s.ts) <= _SAME_REPORT_S]
        if not same:
            out.append(c)
            continue
        s = out[same[0]]
        out[same[0]] = replace(
            s,
            eps_estimate=s.eps_estimate if s.eps_estimate is not None else c.eps_estimate,
            revenue_estimate=c.revenue_estimate,
        )
    for i, e in enumerate(out):
        if e.eps_actual is None:
            continue
        ends = [(end, v) for end, v in revenue if 0 < e.ts - end <= _REPORT_LAG_S]
        if ends:
            out[i] = replace(e, revenue_actual=max(ends)[1])
    return out


def fetch_yahoo_earnings(ticker: str) -> list[Earnings]:
    """Blocking yfinance calls; run it in a thread."""
    import yfinance as yf

    t = yf.Ticker(ticker)
    parts: list = []
    for name, read in (
        ("scrape", _scraped), ("calendar", _calendar), ("revenue", _revenue), ("hours", _hours),
    ):
        try:
            parts.append(read(t))
        except Exception as e:  # noqa: BLE001 - one source failing leaves the others
            log.info("earnings %s for %s failed: %s", name, ticker, e)
            parts.append(None if name == "hours" else [])
    return apply_hours(merge_earnings(parts[0], parts[1], parts[2]), parts[3])


class EarningsRegistry(YahooTickerCache[Earnings]):
    def __init__(
        self,
        fetch=fetch_yahoo_earnings,  # noqa: ANN001
        *,
        ttl_s: float = 12 * 3600.0,
        timeout_s: float = 8.0,
    ) -> None:
        super().__init__(fetch, ttl_s=ttl_s, timeout_s=timeout_s, what="earnings")


EARNINGS = EarningsRegistry()
