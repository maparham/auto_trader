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
