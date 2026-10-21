"""Capital.com account history: parsing, P&L join, paging and the day walk.
Fixtures mirror rows probed from the live account on 2026-10-21, with ids and
amounts replaced."""

from datetime import datetime, timezone

from auto_trader.brokers._capital_history import (
    attach_pnl,
    history_totals,
    parse_activity,
    parse_transactions,
)
from auto_trader.core.models import Side

UTC = timezone.utc


def act(deal, when, source, direction, level, size=1.0, open_price=None, typ="POSITION", epic="TSLA"):
    details = {"direction": direction, "level": level, "size": size, "currency": "USD"}
    if open_price is not None:
        details["openPrice"] = open_price
    return {"dateUTC": when, "epic": epic, "dealId": deal, "source": source,
            "type": typ, "status": "ACCEPTED", "details": details}


def tx(when, kind, size, deal=None, ref=None, epic="TSLA", note=""):
    row = {"dateUtc": when, "instrumentName": epic, "transactionType": kind, "note": note,
           "reference": ref or f"{kind}-{when}", "size": str(size), "currency": "EUR",
           "status": "PROCESSED"}
    if deal:
        row["dealId"] = deal
    return row


def test_open_and_close_pair_into_one_trade():
    rows = [
        act("D1", "2026-10-16T15:53:00.100", "USER", "BUY", 400.0),
        act("D1", "2026-10-21T08:18:41.723", "TP", "SELL", 430.0, open_price=400.0),
    ]
    [t] = parse_activity(rows)
    assert t.deal_id == "D1"
    assert t.side is Side.BUY  # close direction SELL means the position was long
    assert t.entry_price == 400.0 and t.exit_price == 430.0
    assert t.opened_at == datetime(2026, 10, 16, 15, 53, 0, 100000, tzinfo=UTC)
    assert t.closed_at == datetime(2026, 10, 21, 8, 18, 41, 723000, tzinfo=UTC)
    assert t.close_source == "TP"


def test_close_without_open_in_range_has_no_open_time():
    [t] = parse_activity([act("D2", "2026-10-20T23:07:14.695", "SL", "BUY", 510.0, open_price=500.0)])
    assert t.side is Side.SELL
    assert t.opened_at is None


def test_daily_system_rows_are_not_mistaken_for_the_open():
    # NATURALGAS-style rollover rows at 20:59 every day, at a level that is not the fill.
    rows = [
        act("D3", "2026-10-14T20:59:00", "SYSTEM", "BUY", 3.11, epic="NATURALGAS"),
        act("D3", "2026-10-15T09:00:00", "USER", "BUY", 3.05, epic="NATURALGAS"),
        act("D3", "2026-10-15T20:59:00", "SYSTEM", "BUY", 3.12, epic="NATURALGAS"),
        act("D3", "2026-10-16T12:00:00", "USER", "SELL", 3.20, open_price=3.05, epic="NATURALGAS"),
    ]
    [t] = parse_activity(rows)
    assert t.opened_at == datetime(2026, 10, 15, 9, 0, tzinfo=UTC)


def test_partial_closes_are_separate_trades():
    rows = [
        act("D4", "2026-10-15T10:00:00", "USER", "BUY", 100.0, size=2.0),
        act("D4", "2026-10-15T12:00:00", "USER", "SELL", 105.0, size=1.0, open_price=100.0),
        act("D4", "2026-10-15T14:00:00", "TP", "SELL", 110.0, size=1.0, open_price=100.0),
    ]
    trades = parse_activity(rows)
    assert [t.exit_price for t in trades] == [105.0, 110.0]
    assert all(t.opened_at == datetime(2026, 10, 15, 10, 0, tzinfo=UTC) for t in trades)


def test_rejected_close_row_yields_no_closed_trade():
    rows = [
        act("D10", "2026-10-16T15:53:00", "USER", "BUY", 400.0),
        {**act("D10", "2026-10-21T08:18:41.723", "TP", "SELL", 430.0, open_price=400.0), "status": "REJECTED"},
    ]
    assert parse_activity(rows) == []


def test_rejected_open_row_is_never_picked_as_the_open():
    rows = [
        # Same level as the real open, earlier, but REJECTED: must be skipped
        # entirely rather than winning as "earliest matching open".
        {**act("D11", "2026-10-15T08:00:00", "USER", "BUY", 100.0), "status": "REJECTED"},
        act("D11", "2026-10-15T10:00:00", "USER", "BUY", 100.0),
        act("D11", "2026-10-16T12:00:00", "USER", "SELL", 105.0, open_price=100.0),
    ]
    [t] = parse_activity(rows)
    assert t.opened_at == datetime(2026, 10, 15, 10, 0, tzinfo=UTC)


def test_malformed_rows_are_skipped_not_raised():
    rows = [
        {"dateUTC": "2026-10-15T12:00:00", "epic": "X", "dealId": "D5", "type": "POSITION"},  # no details
        act("D6", "2026-10-15T12:00:00", "USER", "SELL", "n/a", open_price=1.0),  # bad level
        act("D7", "not-a-date", "USER", "SELL", 2.0, open_price=1.0),  # bad time
        act("D8", "2026-10-15T12:00:00", "USER", "SELL", 2.0, open_price=1.0, typ="EDIT_STOP_AND_LIMIT"),
    ]
    assert parse_activity(rows) == []


def test_transactions_parse_with_cash_rows_having_no_epic():
    rows = [
        tx("2026-10-21T08:18:41.758", "TRADE", "12.50", deal="D1", note="Trade closed"),
        tx("2026-10-20T21:02:48.185", "SWAP", "-0.42", note="Overnight fee"),
        tx("2026-10-01T09:00:00", "DEPOSIT", "1000", epic=""),
    ]
    ledger = parse_transactions(rows)
    assert [e.kind for e in ledger] == ["DEPOSIT", "SWAP", "TRADE"]  # ascending by time
    dep, swap, trade = ledger
    assert dep.epic is None
    assert swap.amount == -0.42 and swap.deal_id is None
    assert trade.deal_id == "D1" and trade.at.tzinfo is UTC


def test_pnl_matches_partials_by_nearest_time():
    rows = [
        act("D4", "2026-10-15T10:00:00", "USER", "BUY", 100.0, size=2.0),
        act("D4", "2026-10-15T12:00:00", "USER", "SELL", 105.0, size=1.0, open_price=100.0),
        act("D4", "2026-10-15T14:00:00", "TP", "SELL", 110.0, size=1.0, open_price=100.0),
    ]
    ledger = parse_transactions([
        tx("2026-10-15T14:00:00.050", "TRADE", "10", deal="D4", ref="r2"),
        tx("2026-10-15T12:00:00.040", "TRADE", "5", deal="D4", ref="r1"),
    ])
    trades = attach_pnl(parse_activity(rows), ledger)
    assert [(t.exit_price, t.pnl) for t in trades] == [(105.0, 5.0), (110.0, 10.0)]
    assert trades[0].currency == "EUR"


def test_close_without_trade_row_keeps_pnl_none():
    trades = parse_activity([act("D9", "2026-10-15T12:00:00", "SL", "SELL", 9.0, open_price=10.0)])
    [t] = attach_pnl(trades, [])
    assert t.pnl is None


def test_totals_sum_by_kind():
    ledger = parse_transactions([
        tx("2026-10-15T12:00:00", "TRADE", "5", deal="D1"),
        tx("2026-10-15T13:00:00", "TRADE", "-2", deal="D2"),
        tx("2026-10-15T21:00:00", "SWAP", "-0.5"),
        tx("2026-10-01T09:00:00", "DEPOSIT", "1000", epic=""),
        tx("2026-10-02T09:00:00", "WITHDRAWAL", "-200", epic=""),
    ])
    assert history_totals(ledger) == {
        "realized": 3.0, "funding": -0.5, "deposits": 1000.0, "withdrawals": -200.0, "currency": "EUR",
    }
    assert history_totals([])["currency"] is None


import asyncio
import logging
from datetime import date, timedelta

import httpx

from auto_trader.brokers._capital_history import (
    TX_MAX_PAGES,
    DayCache,
    fetch_activity,
    fetch_transactions,
)


class FakeCapital:
    """Records calls; answers from handler(path, params) -> dict."""

    def __init__(self, handler):
        self.handler = handler
        self.calls: list[tuple[str, dict]] = []
        self.in_flight = 0
        self.max_in_flight = 0

    async def request(self, method, path, *, params=None, json=None):
        self.calls.append((path, dict(params or {})))
        self.in_flight += 1
        self.max_in_flight = max(self.max_in_flight, self.in_flight)
        await asyncio.sleep(0)
        self.in_flight -= 1
        return httpx.Response(200, json=self.handler(path, params or {}))


def T(s):
    return datetime.fromisoformat(s).replace(tzinfo=UTC)


def test_transactions_paging_stops_under_a_full_page():
    pages = [
        [tx(f"2026-10-20T10:00:{i:02d}", "SWAP", "-1", ref=f"a{i}") for i in range(59, -1, -1)]
        + [tx(f"2026-10-20T09:{i:02d}:00", "SWAP", "-1", ref=f"b{i}") for i in range(59, 19, -1)],
        [tx("2026-10-19T09:00:00", "SWAP", "-1", ref="c0")],
    ]
    cap = FakeCapital(lambda p, q: {"transactions": pages[len(cap.calls) - 1]})
    ledger = asyncio.run(fetch_transactions(cap.request, T("2026-10-01T00:00:00"), T("2026-10-21T00:00:00")))
    assert len(ledger) == 101
    assert len(cap.calls) == 2
    # The second page's `to` is the oldest row of page one (whole second, rounded up).
    assert cap.calls[1][1]["to"] == "2026-10-20T09:20:00"


def test_transactions_paging_stops_when_a_page_adds_nothing():
    same_second = [tx("2026-10-20T21:00:00.500", "SWAP", "-1", ref=f"s{i}") for i in range(100)]
    cap = FakeCapital(lambda p, q: {"transactions": same_second})
    ledger = asyncio.run(fetch_transactions(cap.request, T("2026-10-01T00:00:00"), T("2026-10-21T00:00:00")))
    assert len(ledger) == 100
    assert len(cap.calls) == 2


def test_transactions_paging_is_capped():
    def handler(p, q):
        n = len(cap.calls)
        base = T("2026-10-20T00:00:00") - timedelta(hours=n)
        return {"transactions": [
            tx((base - timedelta(seconds=i)).strftime("%Y-%m-%dT%H:%M:%S"), "SWAP", "-1", ref=f"{n}-{i}")
            for i in range(100)
        ]}
    cap = FakeCapital(handler)
    asyncio.run(fetch_transactions(cap.request, T("2026-01-01T00:00:00"), T("2026-10-21T00:00:00")))
    assert len(cap.calls) == TX_MAX_PAGES


def test_transactions_paging_cap_logs_a_warning(caplog):
    def handler(p, q):
        n = len(cap.calls)
        base = T("2026-10-20T00:00:00") - timedelta(hours=n)
        return {"transactions": [
            tx((base - timedelta(seconds=i)).strftime("%Y-%m-%dT%H:%M:%S"), "SWAP", "-1", ref=f"{n}-{i}")
            for i in range(100)
        ]}
    cap = FakeCapital(handler)
    with caplog.at_level(logging.WARNING, logger="auto_trader.brokers._capital_history"):
        asyncio.run(fetch_transactions(cap.request, T("2026-01-01T00:00:00"), T("2026-10-21T00:00:00")))
    assert any("page" in r.message.lower() or "cap" in r.message.lower() for r in caplog.records)


def _activity_handler(rows_by_day):
    def handler(path, params):
        day = params["from"][:10]
        return {"activities": rows_by_day.get(day, [])}
    return handler


def test_activity_walks_whole_utc_days_sequentially_and_dedupes_edges():
    edge = act("D1", "2026-10-16T00:00:00", "TP", "SELL", 11.0, open_price=10.0)
    rows = {
        "2026-10-15": [act("D1", "2026-10-15T09:00:00", "USER", "BUY", 10.0), edge],
        "2026-10-16": [edge],  # midnight row returned by both days
    }
    cap = FakeCapital(_activity_handler(rows))
    now = lambda: T("2026-10-21T12:00:00")  # noqa: E731
    trades = asyncio.run(fetch_activity(cap.request, DayCache(), T("2026-10-15T00:00:00"), T("2026-10-17T00:00:00"), now))
    assert len(trades) == 1 and trades[0].opened_at == T("2026-10-15T09:00:00")
    assert [c[1]["from"] for c in cap.calls] == ["2026-10-15T00:00:00", "2026-10-16T00:00:00", "2026-10-17T00:00:00"]
    assert cap.calls[0][1]["to"] == "2026-10-16T00:00:00"
    assert cap.calls[0][1]["filter"] == "type==POSITION" and cap.calls[0][1]["detailed"] == "true"
    assert cap.max_in_flight == 1


def test_activity_filters_to_the_requested_range():
    rows = {"2026-10-15": [act("D1", "2026-10-15T08:00:00", "SL", "SELL", 9.0, open_price=10.0),
                           act("D2", "2026-10-15T20:00:00", "SL", "SELL", 9.0, open_price=10.0)]}
    cap = FakeCapital(_activity_handler(rows))
    trades = asyncio.run(fetch_activity(cap.request, DayCache(), T("2026-10-15T12:00:00"), T("2026-10-15T23:00:00"),
                                        lambda: T("2026-10-21T00:00:00")))
    assert [t.deal_id for t in trades] == ["D2"]


def test_day_cache_keeps_past_days_and_refetches_today():
    cap = FakeCapital(_activity_handler({}))
    cache = DayCache()
    now = lambda: T("2026-10-21T12:00:00")  # noqa: E731
    for _ in range(2):
        asyncio.run(fetch_activity(cap.request, cache, T("2026-10-20T00:00:00"), T("2026-10-21T12:00:00"), now))
    days = [c[1]["from"][:10] for c in cap.calls]
    assert days == ["2026-10-20", "2026-10-21", "2026-10-21"]


def test_day_cache_does_not_freeze_a_day_whose_fetch_started_before_it_ended():
    cache = DayCache()
    clock = iter([T("2026-10-20T23:59:59"), T("2026-10-21T00:00:05")])

    async def fetch(d):
        return []

    asyncio.run(cache.day(date(2026, 10, 20), fetch, lambda: next(clock)))
    assert date(2026, 10, 20) not in cache._days
    asyncio.run(cache.day(date(2026, 10, 20), fetch, lambda: next(clock)))
    assert date(2026, 10, 20) in cache._days


def test_day_cache_single_flight():
    calls = []

    async def fetch(d):
        calls.append(d)
        await asyncio.sleep(0.01)
        return [{"x": 1}]

    async def run():
        cache = DayCache()
        now = lambda: T("2026-10-21T12:00:00")  # noqa: E731
        return await asyncio.gather(*(cache.day(date(2026, 10, 15), fetch, now) for _ in range(3)))

    results = asyncio.run(run())
    assert calls == [date(2026, 10, 15)]
    assert results == [[{"x": 1}]] * 3


def test_day_cache_failed_fetch_propagates_and_is_not_cached():
    attempts = []

    async def fetch(d):
        attempts.append(d)
        await asyncio.sleep(0.01)
        if len(attempts) == 1:
            raise RuntimeError("boom")
        return [{"x": 1}]

    async def run():
        cache = DayCache()
        now = lambda: T("2026-10-21T12:00:00")  # noqa: E731
        results = await asyncio.gather(
            *(cache.day(date(2026, 10, 15), fetch, now) for _ in range(3)),
            return_exceptions=True,
        )
        # Every concurrent waiter sees the same failure, not just the fetcher.
        assert all(isinstance(r, RuntimeError) for r in results)
        assert date(2026, 10, 15) not in cache._days
        # A retry re-fetches rather than reusing the failed attempt.
        retried = await cache.day(date(2026, 10, 15), fetch, now)
        assert retried == [{"x": 1}]
        assert len(attempts) == 2

    asyncio.run(run())


def test_day_cache_is_bounded():
    cache = DayCache(max_days=2)

    async def fetch(d):
        return []

    now = lambda: T("2026-10-21T12:00:00")  # noqa: E731
    for day in (1, 2, 3):
        asyncio.run(cache.day(date(2026, 10, day), fetch, now))
    assert list(cache._days) == [date(2026, 10, 2), date(2026, 10, 3)]
