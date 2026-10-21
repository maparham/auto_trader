"""Earnings dates from Yahoo Finance, past and upcoming, for the chart's
earnings markers (/api/market/{epic}/earnings).

Past quarters come from Ticker.get_earnings_dates, which scrapes Yahoo's
earnings calendar page (needs lxml) and also lists the next scheduled report
with its estimate. Ticker.calendar is an API call that names the next date
(date only) with the EPS consensus; it fills in when the scrape has no
upcoming row. A reported quarter never changes and the next date moves rarely,
so one lookup per symbol per half day is plenty.

Same failure semantics as yahoo_splits.py: any failure (no lxml, unknown
ticker, Yahoo down) reads as "no earnings" and is cached like a hit. Each
source fails on its own, so a broken scrape still leaves the calendar's date.
"""

from __future__ import annotations

import datetime as dt
import logging
import math
from dataclasses import dataclass

from auto_trader.brokers.yahoo_splits import YahooTickerCache

log = logging.getLogger(__name__)

PAST_LIMIT = 40  # ten years of quarters
# A calendar date within this of a scraped row is the same report.
_SAME_REPORT_S = 3 * 86_400
# Calendar dates carry no time: pin them to midday UTC so they land inside the
# report day's bar wherever the exchange sits relative to UTC.
_DATE_ONLY_HOUR = 12


@dataclass(frozen=True)
class Earnings:
    ts: int  # unix seconds of the report (midday UTC when only the date is known)
    eps_estimate: float | None
    eps_actual: float | None  # None until reported
    surprise_pct: float | None


def _num(v: object) -> float | None:
    try:
        f = float(v)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return None if math.isnan(f) or math.isinf(f) else f


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
    return [Earnings(ts=ts, eps_estimate=_num(cal.get("Earnings Average")), eps_actual=None, surprise_pct=None)]


def merge_earnings(scraped: list[Earnings], calendar: list[Earnings]) -> list[Earnings]:
    """Scraped rows, plus each calendar date no scraped row already covers."""
    out = list(scraped)
    for c in calendar:
        if all(abs(c.ts - s.ts) > _SAME_REPORT_S for s in scraped):
            out.append(c)
    return out


def fetch_yahoo_earnings(ticker: str) -> list[Earnings]:
    """Blocking yfinance calls; run it in a thread."""
    import yfinance as yf

    t = yf.Ticker(ticker)
    parts: list[list[Earnings]] = []
    for name, read in (("scrape", _scraped), ("calendar", _calendar)):
        try:
            parts.append(read(t))
        except Exception as e:  # noqa: BLE001 - one source failing leaves the other
            log.info("earnings %s for %s failed: %s", name, ticker, e)
            parts.append([])
    return merge_earnings(parts[0], parts[1])


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
