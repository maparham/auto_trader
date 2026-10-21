# Capital.com Account History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show Capital.com closed trades, realized P&L and the cash ledger in a History tab, and draw closed trades as entry/exit markers on the chart.

**Architecture:** A new backend module `brokers/_capital_history.py` fetches and parses Capital's `/history/transactions` (paged, 100-row cap) and `/history/activity` (one UTC day per call, day-cached, single-flight), joined into `ClosedTrade` + `LedgerEntry` lists behind an optional `ExecutionBroker.get_history`. `GET /api/history` serves them with epoch-ms times. The frontend adds `lib/accountHistory.ts` (store + refresh timer), a `HistoryPane` component in both position views, and a history source in `lib/tradeMarkers.ts` that replaces journal exits on history-capable accounts.

**Tech Stack:** Python 3.12, FastAPI, httpx, pytest (backend, run with `uv run`); React + TypeScript, vitest + Testing Library (frontend).

**Spec:** `docs/superpowers/specs/2026-10-21-capital-account-history-design.md`

## Global Constraints

- All backend datetimes are tz-aware UTC; Capital's naive strings get `tzinfo=timezone.utc` attached. Every time on the wire is **epoch ms** (int).
- Activity days are fetched **sequentially**, never with `asyncio.gather`; all calls go through `CapitalComBroker._request` (shared 8/s limiter).
- Transactions paging: dedupe on `reference`, stop on <100 rows, on a page with no new reference, or after 20 pages.
- `days` accepted values: 7, 30, 90 (422 otherwise). Markers always use 30.
- Unsupported account: `GET /api/history` answers 200 `{"supported": false}`.
- Paper accounts (`*:paper`) are unsupported. Only `CapitalExecutionBroker` sets `supports_history = True`.
- UI text: no em dashes and no `--` in copy; tooltips via `Tooltip`/`InfoTip`, never `title=`; active chip state is muted gray, not accent blue.
- Times in the History table use `fmtTime` from `frontend/src/lib/positionsTable.tsx`.
- Shared worktree: stage files by explicit path; never `git stash`, `git clean`, `git restore`, `git add -A`.
- Frontend tests: run only the named test files (`npx vitest run <file>`), never the whole suite. `npx tsc -b` and `npx eslint` once at the end (Task 8), after asking the user (high CPU).
- Commit to the current branch (`main`); do not create branches; do not push.
- Deviation from the spec, deliberate: exit markers reuse the journal's `JournalTrade` shape and `journalKey` (unique across partials because each close has its own timestamp) instead of a new `hexit:` key, so the coarse-view pill aggregation works unchanged.

## Review Focus

1. **Account with no history at all** (fresh demo, as probed): History tab shows "No closed trades in this range." and an all-zero totals line, not an error; markers draw nothing. Pinned in Task 5 (empty-state render test).
2. **Account switch mid-fetch** (live to demo while a 90d walk is running): the late response must not land in the new account's view. Pinned in Task 4 (store keyed by account; stale-response test).
3. **Trade closed by TP while the History tab is open:** the closed row appears within one refresh without a reload. Pinned in Task 4 (position-disappears triggers refresh test).
4. **Activity row missing `details` or with non-numeric `level`/`size`** (Capital adds fields, SYSTEM rows vary): parser skips the row instead of raising and failing the whole request. Pinned in Task 1 (malformed row test).
5. **Ledger row with `instrumentName` empty string** (cash rows): epic becomes `null`, Symbol cell shows a dash. Pinned in Task 1 (cash row test).

---

### Task 1: Models and pure parsers

**Files:**
- Modify: `backend/auto_trader/core/models.py` (append after the `WorkingOrder` dataclass)
- Create: `backend/auto_trader/brokers/_capital_history.py`
- Test: `backend/tests/test_capital_history.py`

**Interfaces:**
- Produces (models): `ClosedTrade`, `LedgerEntry`, `AccountHistory` dataclasses (fields below).
- Produces (module): `parse_activity(rows: list[dict]) -> list[ClosedTrade]`, `parse_transactions(rows: list[dict]) -> list[LedgerEntry]`, `attach_pnl(trades: list[ClosedTrade], ledger: list[LedgerEntry]) -> list[ClosedTrade]`, `history_totals(ledger: list[LedgerEntry]) -> dict` (keys `realized`, `funding`, `deposits`, `withdrawals`, `currency`), `utc(s: str | None) -> datetime | None`.

- [ ] **Step 1: Add the models**

Append to `backend/auto_trader/core/models.py`:

```python
@dataclass
class ClosedTrade:
    """One broker-reported close (a partial close is its own row, sharing deal_id)."""

    deal_id: str
    epic: str
    side: Side  # the OPENING side (opposite of the close row's direction)
    size: float
    entry_price: float
    exit_price: float
    opened_at: datetime | None  # None when the open row was not found in range
    closed_at: datetime
    close_source: str  # USER / TP / SL / SYSTEM / CLOSE_OUT / DEALER
    pnl: float | None = None  # realized, account currency
    currency: str | None = None


@dataclass
class LedgerEntry:
    """One cash-ledger row: trade P&L, overnight funding, deposit, withdrawal, ..."""

    at: datetime
    kind: str  # broker transaction type verbatim (TRADE, SWAP, DEPOSIT, ...)
    epic: str | None
    note: str
    amount: float  # signed, account currency
    currency: str
    reference: str
    deal_id: str | None = None


@dataclass
class AccountHistory:
    trades: list[ClosedTrade]
    ledger: list[LedgerEntry]
```

- [ ] **Step 2: Write the failing parser tests**

Create `backend/tests/test_capital_history.py`:

```python
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_capital_history.py -q`
Expected: FAIL, `ModuleNotFoundError: No module named 'auto_trader.brokers._capital_history'`.

- [ ] **Step 4: Write the parsers**

Create `backend/auto_trader/brokers/_capital_history.py`:

```python
"""Capital.com account history: closed trades and the cash ledger.

Two upstream endpoints, both shaped by limits probed on 2026-10-21 (see
docs/superpowers/specs/2026-10-21-capital-account-history-design.md):
  - /history/transactions: any range, but at most 100 rows per call, newest
    first. TRADE rows carry the position's dealId and the realized P&L.
  - /history/activity: at most ONE day per call. A close row carries
    details.openPrice (entry) and details.level (exit); an open row has no
    openPrice.
Parsing is pure; the fetch walkers below take the broker's `_request`.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import replace
from datetime import datetime, timezone

from auto_trader.core.models import ClosedTrade, LedgerEntry, Side

# Both server-side numbers for one deal; equality with float slack.
_PRICE_EPS = 1e-9


def utc(s: str | None) -> datetime | None:
    """Capital's naive UTC timestamp ('2026-10-21T08:18:41.723') -> aware UTC."""
    if not s:
        return None
    try:
        return datetime.fromisoformat(s).replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return None


def _num(v) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _same_price(a: float, b: float) -> bool:
    return abs(a - b) <= _PRICE_EPS * max(abs(a), abs(b), 1.0)


def parse_activity(rows: list[dict]) -> list[ClosedTrade]:
    """POSITION activity rows -> one ClosedTrade per close row, ascending by close.

    The open is the earliest no-openPrice row of the same deal, at or before the
    close, whose level equals the close's openPrice: daily SYSTEM rows (rollover)
    also lack openPrice, so "earliest row" alone would pick the wrong one."""
    by_deal: dict[str, list[tuple[datetime, dict]]] = defaultdict(list)
    for r in rows:
        if r.get("type") != "POSITION" or not isinstance(r.get("details"), dict):
            continue
        at = utc(r.get("dateUTC"))
        deal = r.get("dealId")
        if at is None or not deal:
            continue
        by_deal[deal].append((at, r))

    out: list[ClosedTrade] = []
    for deal, events in by_deal.items():
        events.sort(key=lambda e: e[0])
        opens = [
            (at, lvl)
            for at, r in events
            if r["details"].get("openPrice") is None
            and (lvl := _num(r["details"].get("level"))) is not None
        ]
        for at, r in events:
            d = r["details"]
            entry = _num(d.get("openPrice"))
            exit_ = _num(d.get("level"))
            size = _num(d.get("size"))
            if entry is None or exit_ is None or size is None:
                continue
            closing = str(d.get("direction", "")).upper()
            opened_at = next(
                (oat for oat, lvl in opens if oat <= at and _same_price(lvl, entry)), None
            )
            out.append(ClosedTrade(
                deal_id=deal,
                epic=str(r.get("epic") or ""),
                side=Side.BUY if closing == "SELL" else Side.SELL,
                size=size,
                entry_price=entry,
                exit_price=exit_,
                opened_at=opened_at,
                closed_at=at,
                close_source=str(r.get("source") or ""),
            ))
    out.sort(key=lambda t: t.closed_at)
    return out


def parse_transactions(rows: list[dict]) -> list[LedgerEntry]:
    """Transaction rows -> LedgerEntry list, ascending by time. Unparseable rows
    (no time, non-numeric size) are skipped."""
    out: list[LedgerEntry] = []
    for r in rows:
        at = utc(r.get("dateUtc"))
        amount = _num(r.get("size"))
        if at is None or amount is None:
            continue
        out.append(LedgerEntry(
            at=at,
            kind=str(r.get("transactionType") or ""),
            epic=r.get("instrumentName") or None,
            note=str(r.get("note") or ""),
            amount=amount,
            currency=str(r.get("currency") or ""),
            reference=str(r.get("reference") or ""),
            deal_id=r.get("dealId") or None,
        ))
    out.sort(key=lambda e: e.at)
    return out


def attach_pnl(trades: list[ClosedTrade], ledger: list[LedgerEntry]) -> list[ClosedTrade]:
    """Give each close the TRADE ledger row of the same deal nearest in time, each
    row used once. Partial closes share a dealId, so dealId alone is not enough."""
    pool: dict[str, list[LedgerEntry]] = defaultdict(list)
    for e in ledger:
        if e.kind == "TRADE" and e.deal_id:
            pool[e.deal_id].append(e)
    out: list[ClosedTrade] = []
    for t in sorted(trades, key=lambda t: t.closed_at):
        cands = pool.get(t.deal_id)
        if not cands:
            out.append(t)
            continue
        best = min(cands, key=lambda e: abs((e.at - t.closed_at).total_seconds()))
        cands.remove(best)
        out.append(replace(t, pnl=best.amount, currency=best.currency))
    return out


def history_totals(ledger: list[LedgerEntry]) -> dict:
    def total(kind: str) -> float:
        return round(sum(e.amount for e in ledger if e.kind == kind), 10)

    return {
        "realized": total("TRADE"),
        "funding": total("SWAP"),
        "deposits": total("DEPOSIT"),
        "withdrawals": total("WITHDRAWAL"),
        "currency": next((e.currency for e in ledger if e.currency), None),
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_capital_history.py -q`
Expected: 9 passed.

- [ ] **Step 6: Commit**

```bash
git add backend/auto_trader/core/models.py backend/auto_trader/brokers/_capital_history.py backend/tests/test_capital_history.py
git commit -m "feat(history): parse Capital closed trades and the cash ledger"
```

---

### Task 2: Fetch walkers and the day cache

**Files:**
- Modify: `backend/auto_trader/brokers/_capital_history.py`
- Test: `backend/tests/test_capital_history.py`

**Interfaces:**
- Consumes: Task 1 parsers.
- Produces: `RequestFn = Callable[..., Awaitable[httpx.Response]]` (same signature as `CapitalComBroker._request(method, path, *, params=None, json=None)`), `async fetch_transactions(request: RequestFn, since: datetime, until: datetime) -> list[LedgerEntry]`, `class DayCache` with `async day(d: date, fetch: Callable[[date], Awaitable[list[dict]]], now: Callable[[], datetime]) -> list[dict]`, `async fetch_activity(request: RequestFn, cache: DayCache, since: datetime, until: datetime, now: Callable[[], datetime] = ...) -> list[ClosedTrade]`. Constants `TX_PAGE = 100`, `TX_MAX_PAGES = 20`, `DAY_CACHE_MAX = 120`.

- [ ] **Step 1: Write the failing walker tests**

Append to `backend/tests/test_capital_history.py`:

```python
import asyncio
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
    now = lambda: T("2026-10-21T12:00:00")
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
    now = lambda: T("2026-10-21T12:00:00")
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
        now = lambda: T("2026-10-21T12:00:00")
        return await asyncio.gather(*(cache.day(date(2026, 10, 15), fetch, now) for _ in range(3)))

    results = asyncio.run(run())
    assert calls == [date(2026, 10, 15)]
    assert results == [[{"x": 1}]] * 3


def test_day_cache_is_bounded():
    cache = DayCache(max_days=2)

    async def fetch(d):
        return []

    now = lambda: T("2026-10-21T12:00:00")
    for day in (1, 2, 3):
        asyncio.run(cache.day(date(2026, 10, day), fetch, now))
    assert list(cache._days) == [date(2026, 10, 2), date(2026, 10, 3)]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_capital_history.py -q`
Expected: FAIL, `ImportError: cannot import name 'TX_MAX_PAGES'`.

- [ ] **Step 3: Write the walkers**

In `backend/auto_trader/brokers/_capital_history.py`, extend the imports to:

```python
import asyncio
from collections import OrderedDict, defaultdict
from collections.abc import Awaitable, Callable
from dataclasses import replace
from datetime import date, datetime, time, timedelta, timezone

import httpx
```

Append:

```python
RequestFn = Callable[..., Awaitable[httpx.Response]]

# Capital expects naive UTC, whole seconds.
_TS_FMT = "%Y-%m-%dT%H:%M:%S"
TX_PAGE = 100  # transactions rows per call (server cap)
TX_MAX_PAGES = 20
DAY_CACHE_MAX = 120


def _fmt(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime(_TS_FMT)


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def fetch_transactions(request: RequestFn, since: datetime, until: datetime) -> list[LedgerEntry]:
    """Page the 100-row-capped ledger newest to oldest. The next page ends at the
    oldest row seen, rounded UP to a whole second (Capital takes whole seconds and
    rows carry milliseconds), so rows sharing that second come back and are deduped
    on `reference`. Stops on a short page, a page with nothing new (100+ rows in
    one second), or the page cap."""
    seen: dict[str, dict] = {}
    to = until
    for _ in range(TX_MAX_PAGES):
        resp = await request(
            "GET", "/api/v1/history/transactions",
            params={"from": _fmt(since), "to": _fmt(to)},
        )
        rows = resp.json().get("transactions") or []
        fresh = [r for r in rows if str(r.get("reference")) not in seen]
        for r in fresh:
            seen[str(r.get("reference"))] = r
        if len(rows) < TX_PAGE or not fresh:
            break
        times = [t for r in rows if (t := utc(r.get("dateUtc"))) is not None]
        if not times:
            break
        oldest = min(times)
        to = oldest.replace(microsecond=0) + (timedelta(seconds=1) if oldest.microsecond else timedelta(0))
    return parse_transactions(list(seen.values()))


class DayCache:
    """Raw activity rows per UTC day for one broker instance. A day is kept only
    if it had ended before its fetch STARTED (so a fetch crossing midnight never
    freezes a partial day); today is therefore always refetched. Concurrent asks
    for one day share one upstream call."""

    def __init__(self, max_days: int = DAY_CACHE_MAX) -> None:
        self._max = max_days
        self._days: OrderedDict[date, list[dict]] = OrderedDict()
        self._inflight: dict[date, asyncio.Future] = {}

    async def day(
        self,
        d: date,
        fetch: Callable[[date], Awaitable[list[dict]]],
        now: Callable[[], datetime],
    ) -> list[dict]:
        if d in self._days:
            self._days.move_to_end(d)
            return self._days[d]
        pending = self._inflight.get(d)
        if pending is not None:
            return await asyncio.shield(pending)
        started = now()
        task = asyncio.ensure_future(fetch(d))
        self._inflight[d] = task
        try:
            rows = await asyncio.shield(task)
        finally:
            self._inflight.pop(d, None)
        day_end = datetime.combine(d + timedelta(days=1), time(0), tzinfo=timezone.utc)
        if day_end <= started:
            self._days[d] = rows
            while len(self._days) > self._max:
                self._days.popitem(last=False)
        return rows


async def fetch_activity(
    request: RequestFn,
    cache: DayCache,
    since: datetime,
    until: datetime,
    now: Callable[[], datetime] = _now,
) -> list[ClosedTrade]:
    """Closed trades in [since, until], walking whole UTC days ONE AT A TIME: the
    rate limiter is shared with dealing, so a gathered burst would queue ahead of
    an order. Rows a midnight edge returns twice are deduped."""

    async def one_day(d: date) -> list[dict]:
        start = datetime.combine(d, time(0), tzinfo=timezone.utc)
        resp = await request(
            "GET", "/api/v1/history/activity",
            params={
                "from": _fmt(start),
                "to": _fmt(start + timedelta(days=1)),
                "detailed": "true",
                "filter": "type==POSITION",
            },
        )
        return resp.json().get("activities") or []

    rows: list[dict] = []
    seen: set[tuple] = set()
    d = since.astimezone(timezone.utc).date()
    last = until.astimezone(timezone.utc).date()
    while d <= last:
        for r in await cache.day(d, one_day, now):
            key = (r.get("dealId"), r.get("dateUTC"), r.get("source"))
            if key not in seen:
                seen.add(key)
                rows.append(r)
        d += timedelta(days=1)
    return [t for t in parse_activity(rows) if since <= t.closed_at <= until]
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_capital_history.py -q`
Expected: 18 passed.

- [ ] **Step 5: Confirm the day window against the real API (read-only)**

The spec leaves open whether `to` = next day 00:00:00 counts as "at most 1 day". Check against the live account with one GET (no dealing):

```bash
cd backend && uv run python - <<'EOF'
import asyncio
from auto_trader.config import settings
from auto_trader.brokers.capital import CapitalComBroker
async def main():
    k, i, p = settings.live_creds()
    async with CapitalComBroker(k, i, p, settings.live_base_url) as b:
        r = await b._request("GET", "/api/v1/history/activity", params={
            "from": "2026-10-20T00:00:00", "to": "2026-10-21T00:00:00",
            "detailed": "true", "filter": "type==POSITION"})
        print(r.status_code, len(r.json().get("activities", [])))
asyncio.run(main())
EOF
```

Expected: `200 <n>`. If it answers 400, change `one_day`'s `to` to `start + timedelta(days=1, seconds=-1)` and the test's expected `to` to `"2026-10-15T23:59:59"`, then rerun Step 4.

- [ ] **Step 6: Commit**

```bash
git add backend/auto_trader/brokers/_capital_history.py backend/tests/test_capital_history.py
git commit -m "feat(history): page Capital transactions and walk activity by day"
```

---

### Task 3: Broker method, registry flag and the route

**Files:**
- Modify: `backend/auto_trader/brokers/base.py` (`ExecutionBroker`, after `cancel_working_order`)
- Modify: `backend/auto_trader/brokers/capital.py` (`CapitalExecutionBroker.__init__` and a new method after `get_account_summary`)
- Modify: `backend/auto_trader/brokers/registry.py:86-92` (`describe()` exec_items)
- Modify: `backend/auto_trader/api/schemas.py` (after `WorkingOrderDTO`)
- Modify: `backend/auto_trader/api/routers/trading.py` (new route after `working_orders`)
- Test: `backend/tests/test_history_route.py`

**Interfaces:**
- Consumes: `fetch_transactions`, `fetch_activity`, `DayCache`, `attach_pnl`, `history_totals` (Tasks 1-2); `AccountHistory`.
- Produces: `ExecutionBroker.supports_history: bool`, `ExecutionBroker.get_history(since: datetime, until: datetime) -> AccountHistory`; `describe()` exec items gain `"history": bool`; `GET /api/history?account=&days=` returning `AccountHistoryDTO` JSON:
  `{supported, since, until, trades: [{deal_id, epic, side, size, entry_price, exit_price, opened_at, closed_at, close_source, pnl, currency}], ledger: [{at, kind, epic, note, amount, currency, reference, deal_id}], totals: {realized, funding, deposits, withdrawals, currency}}`, all times epoch ms.

- [ ] **Step 1: Write the failing route tests**

Create `backend/tests/test_history_route.py`:

```python
"""GET /api/history: unsupported accounts answer supported:false, bad ranges
422, broker failures map like the positions route, times go out as epoch ms."""

import asyncio
from datetime import datetime, timezone

import pytest
from fastapi import HTTPException

from auto_trader.api import deps
from auto_trader.api.routers import trading
from auto_trader.brokers.base import ExecutionBroker
from auto_trader.brokers.registry import BrokerRegistry
from auto_trader.core.broker_health import BrokerReconnecting
from auto_trader.core.models import AccountHistory, ClosedTrade, LedgerEntry, Side

UTC = timezone.utc


class _Broker(ExecutionBroker):
    def __init__(self, history=None, error=None, supported=True):
        self.supports_history = supported
        self._history = history
        self._error = error
        self.asked = None

    async def get_history(self, since, until):
        self.asked = (since, until)
        if self._error:
            raise self._error
        return self._history

    @property
    def env(self):
        return "demo"

    @property
    def is_real_money(self):
        return False

    async def place_order(self, order):
        raise NotImplementedError

    async def get_positions(self, epic=None):
        return []

    async def close_position(self, deal_id, quantity=None):
        raise NotImplementedError

    async def modify_position(self, deal_id, **kwargs):
        raise NotImplementedError

    async def get_working_orders(self, epic=None):
        return []

    async def modify_working_order(self, order_id, **kwargs):
        raise NotImplementedError

    async def cancel_working_order(self, order_id):
        raise NotImplementedError


def _install(monkeypatch, broker, key="capital:demo"):
    reg = BrokerRegistry()
    reg.add_exec(key, broker)
    monkeypatch.setattr(deps, "_registry", reg)
    return reg


def test_unsupported_account_answers_supported_false(monkeypatch):
    _install(monkeypatch, _Broker(supported=False), "capital:paper")
    out = asyncio.run(trading.account_history(account="capital:paper", days=30))
    assert out.supported is False and out.trades == []


def test_bad_days_is_422(monkeypatch):
    _install(monkeypatch, _Broker(history=AccountHistory([], [])))
    with pytest.raises(HTTPException) as e:
        asyncio.run(trading.account_history(account="capital:demo", days=14))
    assert e.value.status_code == 422


def test_reconnecting_is_503(monkeypatch):
    _install(monkeypatch, _Broker(error=BrokerReconnecting("capital")))
    with pytest.raises(HTTPException) as e:
        asyncio.run(trading.account_history(account="capital:demo", days=7))
    assert e.value.status_code == 503


def test_other_failures_are_502(monkeypatch):
    _install(monkeypatch, _Broker(error=RuntimeError("boom")))
    with pytest.raises(HTTPException) as e:
        asyncio.run(trading.account_history(account="capital:demo", days=7))
    assert e.value.status_code == 502


def test_payload_uses_epoch_ms_and_totals(monkeypatch):
    closed = datetime(2026, 10, 21, 8, 18, 41, 723000, tzinfo=UTC)
    trade = ClosedTrade("D1", "TSLA", Side.BUY, 1.0, 400.0, 430.0, None, closed, "TP", 12.5, "EUR")
    entry = LedgerEntry(closed, "TRADE", "TSLA", "Trade closed", 12.5, "EUR", "r1", "D1")
    broker = _Broker(history=AccountHistory([trade], [entry]))
    _install(monkeypatch, broker)
    out = asyncio.run(trading.account_history(account="capital:demo", days=30))
    assert out.supported is True
    assert out.trades[0].closed_at == 1792570721723
    assert out.trades[0].opened_at is None and out.trades[0].side == "buy"
    assert out.ledger[0].at == 1792570721723
    assert out.totals.realized == 12.5 and out.totals.currency == "EUR"
    since, until = broker.asked
    assert (until - since).days == 30 and until.tzinfo is not None


def test_describe_flags_history_accounts():
    reg = BrokerRegistry()
    reg.add_exec("capital:demo", _Broker())
    reg.add_exec("capital:paper", _Broker(supported=False))
    items = {i["key"]: i for i in reg.describe()["exec"]}
    assert items["capital:demo"]["history"] is True
    assert items["capital:paper"]["history"] is False
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_history_route.py -q`
Expected: FAIL, `AttributeError: module 'auto_trader.api.routers.trading' has no attribute 'account_history'` (and the describe test failing on `KeyError: 'history'`).

- [ ] **Step 3: Add the base method**

In `backend/auto_trader/brokers/base.py`, change the models import to include `AccountHistory`:

```python
from auto_trader.core.models import (
    AccountHistory,
    Candle,
    Order,
    OrderResult,
    Position,
    Resolution,
    WorkingOrder,
)
```

and append inside `ExecutionBroker`, after `cancel_working_order`:

```python
    # Closed trades + cash ledger. Optional: a broker that reports its own history
    # sets supports_history and overrides get_history; everything else (the paper
    # sim included) inherits the defaults and the route answers supported:false.
    supports_history: bool = False

    async def get_history(self, since: datetime, until: datetime) -> AccountHistory:
        raise NotImplementedError
```

- [ ] **Step 4: Implement it on Capital**

In `backend/auto_trader/brokers/capital.py`, add the import near the other broker imports:

```python
from auto_trader.brokers._capital_history import (
    DayCache,
    attach_pnl,
    fetch_activity,
    fetch_transactions,
)
```

and `AccountHistory` to the existing `auto_trader.core.models` import. In `CapitalExecutionBroker`, add the class attribute and the cache:

```python
    supports_history = True
```

(just under the docstring), and at the end of `__init__`:

```python
        # Past UTC days of activity never change; see _capital_history.DayCache.
        self._history_days = DayCache()
```

After `get_account_summary` add:

```python
    async def get_history(self, since: datetime, until: datetime) -> AccountHistory:
        """Closed trades (with realized P&L) and the cash ledger in [since, until].
        Sequential on purpose: these calls share the dealing session's limiter."""
        request = self._broker._request
        ledger = await fetch_transactions(request, since, until)
        trades = await fetch_activity(request, self._history_days, since, until)
        return AccountHistory(trades=attach_pnl(trades, ledger), ledger=ledger)
```

- [ ] **Step 5: Flag history accounts in describe()**

In `backend/auto_trader/brokers/registry.py`, extend the exec item dict:

```python
            {
                "key": key,
                "broker": key.split(":", 1)[0],
                "env": broker.env,
                "isRealMoney": broker.is_real_money,
                "history": bool(getattr(broker, "supports_history", False)),
            }
```

- [ ] **Step 6: Add the DTOs**

In `backend/auto_trader/api/schemas.py`, after `WorkingOrderDTO`:

```python
class ClosedTradeDTO(BaseModel):
    deal_id: str
    epic: str
    side: str
    size: float
    entry_price: float
    exit_price: float
    opened_at: int | None = None  # epoch ms
    closed_at: int  # epoch ms
    close_source: str
    pnl: float | None = None
    currency: str | None = None


class LedgerEntryDTO(BaseModel):
    at: int  # epoch ms
    kind: str
    epic: str | None = None
    note: str
    amount: float
    currency: str
    reference: str
    deal_id: str | None = None


class HistoryTotalsDTO(BaseModel):
    realized: float
    funding: float
    deposits: float
    withdrawals: float
    currency: str | None = None


class AccountHistoryDTO(BaseModel):
    supported: bool
    since: int | None = None
    until: int | None = None
    trades: list[ClosedTradeDTO] = []
    ledger: list[LedgerEntryDTO] = []
    totals: HistoryTotalsDTO | None = None
```

- [ ] **Step 7: Add the route**

In `backend/auto_trader/api/routers/trading.py`, add to the imports:

```python
from datetime import datetime, timedelta, timezone

from auto_trader.brokers._capital_history import history_totals
```

add `AccountHistoryDTO, ClosedTradeDTO, HistoryTotalsDTO, LedgerEntryDTO` to the `..schemas` import, and after the `working_orders` route:

```python
_HISTORY_DAYS = (7, 30, 90)


def _ms(dt: datetime | None) -> int | None:
    return None if dt is None else int(dt.timestamp() * 1000)


@router.get("/api/history", response_model=AccountHistoryDTO)
async def account_history(
    account: str = Query("capital:paper"), days: int = Query(30)
) -> AccountHistoryDTO:
    """Closed trades + cash ledger for the last `days`. An account without broker
    history (paper sim, other brokers) answers supported:false, not an error."""
    if days not in _HISTORY_DAYS:
        raise HTTPException(status_code=422, detail=f"days must be one of {_HISTORY_DAYS}")
    broker = get_exec(account)
    if not getattr(broker, "supports_history", False):
        return AccountHistoryDTO(supported=False)
    until = datetime.now(timezone.utc)
    since = until - timedelta(days=days)
    try:
        hist = await broker.get_history(since, until)
    except BrokerReconnecting as e:
        raise HTTPException(503, f"{account}: broker reconnecting, retry shortly") from e
    except BrokerBlocked as e:
        raise broker_blocked_http("history failed", e) from e
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"history failed: {e}") from e
    return AccountHistoryDTO(
        supported=True,
        since=_ms(since),
        until=_ms(until),
        trades=[
            ClosedTradeDTO(
                deal_id=t.deal_id, epic=t.epic, side=t.side.value, size=t.size,
                entry_price=t.entry_price, exit_price=t.exit_price,
                opened_at=_ms(t.opened_at), closed_at=_ms(t.closed_at),
                close_source=t.close_source, pnl=t.pnl, currency=t.currency,
            )
            for t in hist.trades
        ],
        ledger=[
            LedgerEntryDTO(
                at=_ms(e.at), kind=e.kind, epic=e.epic, note=e.note, amount=e.amount,
                currency=e.currency, reference=e.reference, deal_id=e.deal_id,
            )
            for e in hist.ledger
        ],
        totals=HistoryTotalsDTO(**history_totals(hist.ledger)),
    )
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_history_route.py tests/test_capital_history.py tests/test_trading_reconnect.py tests/test_capital_exec.py -q`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add backend/auto_trader/brokers/base.py backend/auto_trader/brokers/capital.py backend/auto_trader/brokers/registry.py backend/auto_trader/api/schemas.py backend/auto_trader/api/routers/trading.py backend/tests/test_history_route.py
git commit -m "feat(history): GET /api/history for Capital dealing accounts"
```

---

### Task 4: Frontend history store

**Files:**
- Modify: `frontend/src/lib/trading.ts` (`BrokerAccount`, the broker-notes block near `noteDataOnlyBrokers`, both `noteDataOnlyBrokers(info.exec)` call sites at ~264 and ~292, `setTradesAccount`)
- Create: `frontend/src/lib/accountHistory.ts`
- Test: `frontend/src/lib/accountHistory.test.ts`

**Interfaces:**
- Produces in `trading.ts`: `BrokerAccount.history?: boolean`; `historyAccountsSignal: Signal<string[]>`; `noteHistoryAccounts(exec: BrokerAccount[] | undefined): void`; `accountSupportsHistory(account: TradeAccount): boolean`; `tradesAccountSignal: Signal<TradeAccount>` (set by `setTradesAccount`).
- Produces in `accountHistory.ts`:
  ```ts
  export type HistoryDays = 7 | 30 | 90;
  export interface ClosedTradeView { dealId: string; epic: string; side: OrderSide; size: number; entry: number; exit: number; openedAt: number | null; closedAt: number; closeSource: string; pnl: number | null; currency: string | null }
  export interface LedgerRow { at: number; kind: string; epic: string | null; note: string; amount: number; currency: string; reference: string; dealId: string | null }
  export interface HistoryTotals { realized: number; funding: number; deposits: number; withdrawals: number; currency: string | null }
  export interface AccountHistoryData { trades: ClosedTradeView[]; ledger: LedgerRow[]; totals: HistoryTotals }
  export interface HistoryState { loading: boolean; error: string | null; data: AccountHistoryData | null }
  export interface MarkerHistory { active: boolean; trades: ClosedTradeView[] }
  export async function fetchAccountHistory(account: string, days: HistoryDays): Promise<AccountHistoryData | null>
  export function subscribeHistory(account: string, days: HistoryDays, fn: (s: HistoryState) => void): () => void
  export function refreshHistory(account: string): void
  export function subscribeMarkerHistory(fn: (h: MarkerHistory) => void): () => void
  export const HISTORY_POLL_MS = 60_000;
  ```

- [ ] **Step 1: Write the failing store tests**

Create `frontend/src/lib/accountHistory.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fetchMock = vi.fn();
vi.mock("./http", async (orig) => ({
  ...(await orig<typeof import("./http")>()),
  apiFetch: (...a: unknown[]) => fetchMock(...a),
}));

import {
  subscribeHistory,
  subscribeMarkerHistory,
  HISTORY_POLL_MS,
  _resetHistoryForTests,
  type HistoryState,
  type MarkerHistory,
} from "./accountHistory";
import { noteHistoryAccounts, setTradesAccount } from "./trading";
import { tradesSignal } from "./signals";

function payload(dealId = "D1") {
  return {
    supported: true,
    since: 0,
    until: 1,
    trades: [{
      deal_id: dealId, epic: "TSLA", side: "buy", size: 1, entry_price: 400, exit_price: 430,
      opened_at: null, closed_at: 5_000, close_source: "TP", pnl: 12.5, currency: "EUR",
    }],
    ledger: [],
    totals: { realized: 12.5, funding: 0, deposits: 0, withdrawals: 0, currency: "EUR" },
  };
}
const ok = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
// setTradesAccount also refetches positions/orders through apiFetch; count only history calls.
const historyCalls = () => fetchMock.mock.calls.filter((c) => String(c[0]).includes("/api/history"));
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  fetchMock.mockReset();
  _resetHistoryForTests();
  noteHistoryAccounts([
    { key: "capital:demo", broker: "capital", env: "demo", isRealMoney: false, history: true },
    { key: "capital:paper", broker: "capital", env: "paper", isRealMoney: false, history: false },
  ]);
});
afterEach(() => vi.useRealTimers());

describe("subscribeHistory", () => {
  it("loads, maps snake_case to the view shape and ms times", async () => {
    fetchMock.mockReturnValue(ok(payload()));
    const seen: HistoryState[] = [];
    const off = subscribeHistory("capital:demo", 30, (s) => seen.push(s));
    await flush();
    const last = seen.at(-1)!;
    expect(last.loading).toBe(false);
    expect(last.data!.trades[0]).toMatchObject({ dealId: "D1", entry: 400, exit: 430, closedAt: 5_000, openedAt: null });
    expect(String(historyCalls()[0][0])).toContain("/api/history?account=capital%3Ademo&days=30");
    off();
  });

  it("surfaces an error with the server detail", async () => {
    fetchMock.mockReturnValue(Promise.resolve(new Response(JSON.stringify({ detail: "history failed: boom" }), { status: 502 })));
    let last: HistoryState | null = null;
    const off = subscribeHistory("capital:demo", 30, (s) => (last = s));
    await flush();
    expect(last!.error).toContain("boom");
    off();
  });

  it("refetches on the poll timer while subscribed, and stops after", async () => {
    fetchMock.mockImplementation(() => ok(payload()));
    const off = subscribeHistory("capital:demo", 7, () => {});
    await flush();
    vi.advanceTimersByTime(HISTORY_POLL_MS);
    await flush();
    expect(historyCalls()).toHaveLength(2);
    off();
    vi.advanceTimersByTime(HISTORY_POLL_MS * 3);
    expect(historyCalls()).toHaveLength(2);
  });

  it("refetches when a position disappears from the trades book", async () => {
    fetchMock.mockImplementation(() => ok(payload()));
    setTradesAccount("capital:demo");
    const off = subscribeHistory("capital:demo", 30, () => {});
    await flush();
    const pos = { kind: "position", id: "D1", epic: "TSLA", side: "buy", quantity: 1, priceLevel: 400,
      stop: null, takeProfit: null, upnl: null, openedAt: 1, expiresAt: null, leverage: null, margin: null } as const;
    tradesSignal.set([pos]);
    tradesSignal.set([]);
    await flush();
    expect(historyCalls()).toHaveLength(2);
    off();
  });

  it("keys state by account, so a late response never lands on another account", async () => {
    let resolveDemo!: (r: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((r) => (resolveDemo = r)));
    let demoState: HistoryState | null = null;
    const offDemo = subscribeHistory("capital:demo", 30, (s) => (demoState = s));
    offDemo();
    fetchMock.mockReturnValueOnce(ok({ supported: false }));
    let paperState: HistoryState | null = null;
    const offPaper = subscribeHistory("capital:paper", 30, (s) => (paperState = s));
    resolveDemo(new Response(JSON.stringify(payload()), { status: 200 }));
    await flush();
    expect(paperState!.data).toBeNull();
    expect(demoState!.data).toBeNull(); // unsubscribed before it landed: no delivery
    offPaper();
  });
});

describe("subscribeMarkerHistory", () => {
  it("follows the trades account: inactive without history, 30d trades with it", async () => {
    fetchMock.mockImplementation(() => ok(payload()));
    setTradesAccount("capital:paper");
    const seen: MarkerHistory[] = [];
    const off = subscribeMarkerHistory((h) => seen.push(h));
    expect(seen.at(-1)).toEqual({ active: false, trades: [] });
    setTradesAccount("capital:demo");
    await flush();
    expect(seen.at(-1)!.active).toBe(true);
    expect(seen.at(-1)!.trades.map((t) => t.dealId)).toEqual(["D1"]);
    expect(String(historyCalls().at(-1)![0])).toContain("days=30");
    off();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/lib/accountHistory.test.ts`
Expected: FAIL, cannot resolve `./accountHistory`.

- [ ] **Step 3: Extend trading.ts**

In `frontend/src/lib/trading.ts`:

Change the signals import to `import { Signal, tradesSignal } from "./signals";`.

Add to `BrokerAccount` after `dataOnly?`:

```ts
  // True when the broker reports closed trades + a cash ledger (GET /api/history).
  // Absent on accounts without broker history (paper sims, other brokers).
  history?: boolean;
```

After `isDataOnlyBroker`:

```ts
// Accounts with broker-reported history (closed trades, ledger). Fed by
// fetchBrokers / cachedBrokers like dataOnlyBrokers; a Signal because the
// history store re-evaluates the marker source when the list first lands.
export const historyAccountsSignal = new Signal<string[]>([]);
export function noteHistoryAccounts(exec: BrokerAccount[] | undefined): void {
  if (!exec) return;
  historyAccountsSignal.set(exec.filter((a) => a.history).map((a) => a.key));
}
export function accountSupportsHistory(account: TradeAccount): boolean {
  return historyAccountsSignal.value.includes(account);
}
```

At both `noteDataOnlyBrokers(info.exec);` call sites add the line `noteHistoryAccounts(info.exec);` directly below.

Next to `let _account`, add:

```ts
// The trades feed's account as a signal, for consumers that must follow it
// (the chart's broker-history markers, lib/accountHistory).
export const tradesAccountSignal = new Signal<TradeAccount>(DEFAULT_ACCOUNT);
```

and in `setTradesAccount`, right after `_account = account;`:

```ts
  tradesAccountSignal.set(account);
```

- [ ] **Step 4: Write the store**

Create `frontend/src/lib/accountHistory.ts`:

```ts
// Broker-reported account history (spec 2026-10-21-capital-account-history):
// closed trades with realized P&L and the cash ledger, from GET /api/history.
//
// One store entry per (account, days), shared by every subscriber (desktop
// dock, phone view, chart markers). An entry refetches while it has
// subscribers: on a 60 s timer (skipped while the page is hidden), and when a
// position disappears from the trades book (a close just happened). The timer
// is what keeps capital:demo fresh: it has no server push and no trades poll.

import { API_BASE as BASE, apiFetch, errorDetail } from "./http";
import { tradesSignal } from "./signals";
import {
  accountSupportsHistory,
  getTradesAccount,
  historyAccountsSignal,
  tradesAccountSignal,
  type OrderSide,
} from "./trading";

export type HistoryDays = 7 | 30 | 90;
export const HISTORY_POLL_MS = 60_000;
// Chart markers always read this range, whatever the History tab shows.
export const MARKER_DAYS: HistoryDays = 30;

export interface ClosedTradeView {
  dealId: string;
  epic: string;
  side: OrderSide; // opening side
  size: number;
  entry: number;
  exit: number;
  openedAt: number | null; // epoch ms; null = opened before the fetched range
  closedAt: number; // epoch ms
  closeSource: string; // USER / TP / SL / SYSTEM / CLOSE_OUT / DEALER
  pnl: number | null; // account currency
  currency: string | null;
}
export interface LedgerRow {
  at: number;
  kind: string;
  epic: string | null;
  note: string;
  amount: number;
  currency: string;
  reference: string;
  dealId: string | null;
}
export interface HistoryTotals {
  realized: number;
  funding: number;
  deposits: number;
  withdrawals: number;
  currency: string | null;
}
export interface AccountHistoryData {
  trades: ClosedTradeView[];
  ledger: LedgerRow[];
  totals: HistoryTotals;
}
export interface HistoryState {
  loading: boolean;
  error: string | null;
  data: AccountHistoryData | null;
}
export interface MarkerHistory {
  active: boolean;
  trades: ClosedTradeView[];
}

interface ApiTrade {
  deal_id: string; epic: string; side: OrderSide; size: number; entry_price: number;
  exit_price: number; opened_at: number | null; closed_at: number; close_source: string;
  pnl: number | null; currency: string | null;
}
interface ApiLedger {
  at: number; kind: string; epic: string | null; note: string; amount: number;
  currency: string; reference: string; deal_id: string | null;
}

/** null when the account has no broker history (supported:false). */
export async function fetchAccountHistory(
  account: string,
  days: HistoryDays,
): Promise<AccountHistoryData | null> {
  const res = await apiFetch(`${BASE}/api/history?account=${encodeURIComponent(account)}&days=${days}`);
  if (!res.ok) throw new Error(await errorDetail(res, `history failed (${res.status})`));
  const body = await res.json();
  if (!body.supported) return null;
  return {
    trades: (body.trades as ApiTrade[]).map((t) => ({
      dealId: t.deal_id, epic: t.epic, side: t.side, size: t.size, entry: t.entry_price,
      exit: t.exit_price, openedAt: t.opened_at, closedAt: t.closed_at,
      closeSource: t.close_source, pnl: t.pnl, currency: t.currency,
    })),
    ledger: (body.ledger as ApiLedger[]).map((e) => ({
      at: e.at, kind: e.kind, epic: e.epic, note: e.note, amount: e.amount,
      currency: e.currency, reference: e.reference, dealId: e.deal_id,
    })),
    totals: body.totals,
  };
}

interface Entry {
  account: string;
  days: HistoryDays;
  state: HistoryState;
  listeners: Set<(s: HistoryState) => void>;
  timer: ReturnType<typeof setInterval> | null;
  seq: number; // newest request id; an older response is dropped
}
const entries = new Map<string, Entry>();
const keyOf = (account: string, days: HistoryDays) => `${account}|${days}`;

function publish(e: Entry, next: HistoryState): void {
  e.state = next;
  e.listeners.forEach((l) => l(next));
}

async function load(e: Entry): Promise<void> {
  const seq = ++e.seq;
  publish(e, { ...e.state, loading: true, error: null });
  try {
    const data = await fetchAccountHistory(e.account, e.days);
    if (seq !== e.seq || entries.get(keyOf(e.account, e.days)) !== e) return;
    publish(e, { loading: false, error: null, data });
  } catch (err) {
    if (seq !== e.seq || entries.get(keyOf(e.account, e.days)) !== e) return;
    publish(e, { ...e.state, loading: false, error: err instanceof Error ? err.message : String(err) });
  }
}

export function subscribeHistory(
  account: string,
  days: HistoryDays,
  fn: (s: HistoryState) => void,
): () => void {
  const key = keyOf(account, days);
  let e = entries.get(key);
  if (!e) {
    e = { account, days, state: { loading: false, error: null, data: null }, listeners: new Set(), timer: null, seq: 0 };
    entries.set(key, e);
  }
  const entry = e;
  entry.listeners.add(fn);
  fn(entry.state);
  if (entry.listeners.size === 1) {
    void load(entry);
    entry.timer = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void load(entry);
    }, HISTORY_POLL_MS);
  }
  return () => {
    entry.listeners.delete(fn);
    if (entry.listeners.size === 0) {
      if (entry.timer !== null) clearInterval(entry.timer);
      entries.delete(key); // drops any in-flight response (load checks identity)
    }
  };
}

/** Refetch every subscribed range of `account` now. */
export function refreshHistory(account: string): void {
  for (const e of entries.values()) if (e.account === account) void load(e);
}

// A position leaving the book is a close (TP/SL/manual/stop-out): refetch the
// trades account's history so the new closed row and its markers show.
let lastPositionIds = new Set<string>();
tradesSignal.subscribe((trades) => {
  const ids = new Set(trades.filter((t) => t.kind === "position").map((t) => t.id));
  const gone = [...lastPositionIds].some((id) => !ids.has(id));
  lastPositionIds = ids;
  if (gone) refreshHistory(getTradesAccount());
});

/** The chart's marker source: follows the trades account; active (30d closed
 * trades) only while that account has broker history. */
export function subscribeMarkerHistory(fn: (h: MarkerHistory) => void): () => void {
  let inner: (() => void) | null = null;
  let current: string | null = null;
  const sync = () => {
    const account = tradesAccountSignal.value;
    const active = accountSupportsHistory(account);
    const want = active ? account : null;
    if (want === current) return;
    inner?.();
    inner = null;
    current = want;
    if (want === null) {
      fn({ active: false, trades: [] });
      return;
    }
    inner = subscribeHistory(want, MARKER_DAYS, (s) => fn({ active: true, trades: s.data?.trades ?? [] }));
  };
  sync();
  const offAccount = tradesAccountSignal.subscribe(sync);
  const offList = historyAccountsSignal.subscribe(sync);
  return () => {
    offAccount();
    offList();
    inner?.();
  };
}

/** Test seam: forget every entry and timer. */
export function _resetHistoryForTests(): void {
  for (const e of entries.values()) if (e.timer !== null) clearInterval(e.timer);
  entries.clear();
  lastPositionIds = new Set();
}
```

Check `errorDetail`'s real signature in `frontend/src/lib/http.ts` before relying on it; if it differs from `(res, fallback) => Promise<string>`, adapt the one call in `fetchAccountHistory` to match.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/lib/accountHistory.test.ts`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/trading.ts frontend/src/lib/accountHistory.ts frontend/src/lib/accountHistory.test.ts
git commit -m "feat(history): frontend store for broker account history"
```

---

### Task 5: History table and pane

**Files:**
- Create: `frontend/src/lib/historyTable.ts`
- Create: `frontend/src/HistoryPane.tsx`
- Modify: `frontend/src/App.css` (append history styles next to the `pp-` rules)
- Test: `frontend/src/lib/historyTable.test.ts`, `frontend/src/HistoryPane.test.tsx`

**Interfaces:**
- Consumes: `subscribeHistory`, `HistoryDays`, `ClosedTradeView`, `LedgerRow`, `HistoryTotals` (Task 4); `fmtTime`, `fmtPnl`, `pnlClass`, `cash`, `SortDir` from `lib/positionsTable.tsx`.
- Produces: `closedByLabel(source: string): string`, `ledgerKindLabel(kind: string): string`, `type HistorySortKey`, `type HistorySort = { key: HistorySortKey; dir: SortDir }`, `DEFAULT_HISTORY_SORT`, `sortClosedTrades(rows: ClosedTradeView[], sort: HistorySort): ClosedTradeView[]`; component `HistoryPane({ account, precisionFor, onJumpToEpic, tips }: { account: string; precisionFor?: (epic: string) => number; onJumpToEpic?: (epic: string) => void; tips?: boolean })` (default export).

- [ ] **Step 1: Write the failing pure tests**

Create `frontend/src/lib/historyTable.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { closedByLabel, ledgerKindLabel, sortClosedTrades, DEFAULT_HISTORY_SORT } from "./historyTable";
import type { ClosedTradeView } from "./accountHistory";

const t = (over: Partial<ClosedTradeView>): ClosedTradeView => ({
  dealId: "D", epic: "TSLA", side: "buy", size: 1, entry: 1, exit: 2, openedAt: null,
  closedAt: 0, closeSource: "USER", pnl: null, currency: "EUR", ...over,
});

describe("historyTable", () => {
  it("labels close sources and ledger kinds in plain words", () => {
    expect(["TP", "SL", "USER", "SYSTEM", "CLOSE_OUT", "DEALER", "ODD"].map(closedByLabel))
      .toEqual(["TP", "SL", "Manual", "System", "Stop-out", "Dealer", "ODD"]);
    expect(["SWAP", "TRADE", "DEPOSIT", "WITHDRAWAL", "BONUS"].map(ledgerKindLabel))
      .toEqual(["Funding", "Trade", "Deposit", "Withdrawal", "BONUS"]);
  });

  it("sorts newest close first by default, nulls last on any key", () => {
    const rows = [t({ dealId: "a", closedAt: 1, pnl: 5 }), t({ dealId: "b", closedAt: 3, pnl: null }), t({ dealId: "c", closedAt: 2, pnl: -1 })];
    expect(sortClosedTrades(rows, DEFAULT_HISTORY_SORT).map((r) => r.dealId)).toEqual(["b", "c", "a"]);
    expect(sortClosedTrades(rows, { key: "pnl", dir: "asc" }).map((r) => r.dealId)).toEqual(["c", "a", "b"]);
    expect(sortClosedTrades(rows, { key: "pnl", dir: "desc" }).map((r) => r.dealId)).toEqual(["a", "c", "b"]);
  });
});
```

- [ ] **Step 2: Write the failing component tests**

Create `frontend/src/HistoryPane.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { HistoryState } from "./lib/accountHistory";

let state: HistoryState = { loading: false, error: null, data: null };
const subscribe = vi.fn((_a: string, _d: number, fn: (s: HistoryState) => void) => {
  fn(state);
  return () => {};
});
const refresh = vi.fn();
vi.mock("./lib/accountHistory", async (orig) => ({
  ...(await orig<typeof import("./lib/accountHistory")>()),
  subscribeHistory: (a: string, d: number, fn: (s: HistoryState) => void) => subscribe(a, d, fn),
  refreshHistory: (a: string) => refresh(a),
}));

import HistoryPane from "./HistoryPane";

const totals = { realized: 0, funding: 0, deposits: 0, withdrawals: 0, currency: "EUR" };
afterEach(() => {
  cleanup();
  subscribe.mockClear();
});

describe("HistoryPane", () => {
  it("shows an empty state and zero totals for an account with no history", () => {
    state = { loading: false, error: null, data: { trades: [], ledger: [], totals } };
    render(<HistoryPane account="capital:demo" />);
    expect(screen.getByText("No closed trades in this range.")).toBeTruthy();
    expect(screen.getByText("Realized").parentElement!.textContent).toContain("0");
  });

  it("marks a trade opened before the range and colours P&L", () => {
    state = {
      loading: false, error: null,
      data: {
        trades: [{ dealId: "D1", epic: "TSLA", side: "buy", size: 1, entry: 400, exit: 430, openedAt: null,
          closedAt: 1_792_570_721_723, closeSource: "TP", pnl: 12.5, currency: "EUR" }],
        ledger: [], totals: { ...totals, realized: 12.5 },
      },
    };
    render(<HistoryPane account="capital:demo" />);
    expect(screen.getByText("before range")).toBeTruthy();
    expect(screen.getByText("+12.50").className).toContain("pp-pos");
  });

  it("switches range and subscribes with the new days", () => {
    state = { loading: false, error: null, data: { trades: [], ledger: [], totals } };
    render(<HistoryPane account="capital:demo" />);
    expect(subscribe).toHaveBeenLastCalledWith("capital:demo", 30, expect.any(Function));
    fireEvent.click(screen.getByRole("button", { name: "90d" }));
    expect(subscribe).toHaveBeenLastCalledWith("capital:demo", 90, expect.any(Function));
  });

  it("shows the error with a Retry that refetches", () => {
    state = { loading: false, error: "history failed: boom", data: null };
    render(<HistoryPane account="capital:demo" />);
    expect(screen.getByText(/boom/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refresh).toHaveBeenCalledWith("capital:demo");
  });

  it("lists ledger rows under the Ledger toggle", () => {
    state = {
      loading: false, error: null,
      data: { trades: [], totals, ledger: [{ at: 1, kind: "SWAP", epic: null, note: "Overnight fee",
        amount: -0.42, currency: "EUR", reference: "r", dealId: null }] },
    };
    render(<HistoryPane account="capital:demo" />);
    fireEvent.click(screen.getByRole("button", { name: "Ledger" }));
    expect(screen.getAllByText("Funding")).toHaveLength(2); // totals label + the row's type
    expect(screen.getByText("Overnight fee")).toBeTruthy();
  });
});
```

Before relying on `fmtPnl`'s output, read `frontend/src/lib/positionsTable.tsx:58`; if it does not render `+12.50` for 12.5, change the expected text in the second test to what it renders.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/lib/historyTable.test.ts src/HistoryPane.test.tsx`
Expected: FAIL, cannot resolve `./historyTable` / `./HistoryPane`.

- [ ] **Step 4: Write the pure module**

Create `frontend/src/lib/historyTable.ts`:

```ts
// Pure helpers for the History tab (HistoryPane): plain-word labels and the
// closed-trades sort. Kept apart from lib/positionsTable, whose columns and sort
// keys are tied to OPEN trades.
import type { ClosedTradeView } from "./accountHistory";
import type { SortDir } from "./positionsTable";

const CLOSED_BY: Record<string, string> = {
  TP: "TP",
  SL: "SL",
  USER: "Manual",
  SYSTEM: "System",
  CLOSE_OUT: "Stop-out",
  DEALER: "Dealer",
};
export const closedByLabel = (source: string) => CLOSED_BY[source] ?? source;

const LEDGER_KIND: Record<string, string> = {
  SWAP: "Funding",
  TRADE: "Trade",
  DEPOSIT: "Deposit",
  WITHDRAWAL: "Withdrawal",
};
export const ledgerKindLabel = (kind: string) => LEDGER_KIND[kind] ?? kind;

export type HistorySortKey =
  | "epic" | "side" | "size" | "entry" | "exit" | "openedAt" | "closedAt" | "closeSource" | "pnl";
export type HistorySort = { key: HistorySortKey; dir: SortDir };
export const DEFAULT_HISTORY_SORT: HistorySort = { key: "closedAt", dir: "desc" };

/** Sorted copy; nulls sink to the bottom in both directions. */
export function sortClosedTrades(rows: ClosedTradeView[], sort: HistorySort): ClosedTradeView[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = a[sort.key];
    const y = b[sort.key];
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    if (typeof x === "number" && typeof y === "number") return (x - y) * sign;
    return String(x).localeCompare(String(y)) * sign;
  });
}
```

- [ ] **Step 5: Write the pane**

Create `frontend/src/HistoryPane.tsx`:

```tsx
// History tab body (spec 2026-10-21-capital-account-history): range chips, a
// Trades | Ledger toggle, a totals line, and the table. Shared by the desktop
// dock (PositionsPanel) and the phone view (MobilePositionsView).
import { useEffect, useState } from "react";
import {
  refreshHistory,
  subscribeHistory,
  type HistoryDays,
  type HistoryState,
} from "./lib/accountHistory";
import {
  closedByLabel,
  DEFAULT_HISTORY_SORT,
  ledgerKindLabel,
  sortClosedTrades,
  type HistorySort,
  type HistorySortKey,
} from "./lib/historyTable";
import { cash, fmtPnl, fmtTime, pnlClass } from "./lib/positionsTable";

const RANGES: HistoryDays[] = [7, 30, 90];

interface Props {
  account: string;
  precisionFor?: (epic: string) => number;
  onJumpToEpic?: (epic: string) => void;
  tips?: boolean;
}

const TRADE_COLS: { key: HistorySortKey; label: string; cls: string }[] = [
  { key: "epic", label: "Symbol", cls: "pp-c-sym" },
  { key: "side", label: "Side", cls: "" },
  { key: "size", label: "Qty", cls: "num" },
  { key: "entry", label: "Entry", cls: "num" },
  { key: "exit", label: "Exit", cls: "num" },
  { key: "openedAt", label: "Opened", cls: "" },
  { key: "closedAt", label: "Closed", cls: "" },
  { key: "closeSource", label: "Closed by", cls: "" },
  { key: "pnl", label: "P&L", cls: "num" },
];

export default function HistoryPane({ account, precisionFor, onJumpToEpic }: Props) {
  const [days, setDays] = useState<HistoryDays>(30);
  const [view, setView] = useState<"trades" | "ledger">("trades");
  const [sort, setSort] = useState<HistorySort>(DEFAULT_HISTORY_SORT);
  const [state, setState] = useState<HistoryState>({ loading: false, error: null, data: null });

  useEffect(() => subscribeHistory(account, days, setState), [account, days]);

  const prec = (epic: string) => precisionFor?.(epic) ?? 2;
  const toggleSort = (key: HistorySortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" }));
  const data = state.data;
  const totals = data?.totals;
  const ccy = totals?.currency ?? "";

  return (
    <div className="pp-history">
      <div className="pp-history-bar">
        <div className="pp-history-chips" role="group" aria-label="Range">
          {RANGES.map((d) => (
            <button key={d} className={`pp-chip${d === days ? " on" : ""}`} aria-pressed={d === days} onClick={() => setDays(d)}>
              {d}d
            </button>
          ))}
        </div>
        <div className="pp-history-chips" role="group" aria-label="View">
          <button className={`pp-chip${view === "trades" ? " on" : ""}`} aria-pressed={view === "trades"} onClick={() => setView("trades")}>
            Trades
          </button>
          <button className={`pp-chip${view === "ledger" ? " on" : ""}`} aria-pressed={view === "ledger"} onClick={() => setView("ledger")}>
            Ledger
          </button>
        </div>
        {totals && (
          <div className="pp-history-totals num">
            <span><span className="pp-stat-label">Realized</span> <span className={pnlClass(totals.realized)}>{cash(totals.realized)} {ccy}</span></span>
            <span><span className="pp-stat-label">Funding</span> <span className={pnlClass(totals.funding)}>{cash(totals.funding)} {ccy}</span></span>
            <span><span className="pp-stat-label">Net cash</span> {cash(totals.deposits + totals.withdrawals)} {ccy}</span>
          </div>
        )}
      </div>

      {state.error && (
        <div className="pp-error">
          {state.error}{" "}
          <button className="pp-chip" onClick={() => refreshHistory(account)}>Retry</button>
        </div>
      )}

      {!data && state.loading && <div className="pp-empty">Loading history…</div>}

      {data && view === "trades" && (data.trades.length === 0 ? (
        <div className="pp-empty">No closed trades in this range.</div>
      ) : (
        <div className="pp-table-wrap">
          <table className="pp-table">
            <thead>
              <tr>
                {TRADE_COLS.map((c) => (
                  <th key={c.key} className={`${c.cls} pp-sortable`} onClick={() => toggleSort(c.key)} aria-sort={sort.key === c.key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
                    {c.label}
                    {sort.key === c.key && <span className="pp-sort">{sort.dir === "asc" ? "▲" : "▼"}</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortClosedTrades(data.trades, sort).map((t) => (
                <tr key={`${t.dealId}:${t.closedAt}`} className={`pp-row pp-dir-${t.side === "buy" ? "long" : "short"}`} onClick={() => onJumpToEpic?.(t.epic)}>
                  <td className="pp-c-sym">{t.epic}</td>
                  <td>{t.side === "buy" ? "Long" : "Short"}</td>
                  <td className="num">{t.size}</td>
                  <td className="num">{t.entry.toFixed(prec(t.epic))}</td>
                  <td className="num">{t.exit.toFixed(prec(t.epic))}</td>
                  <td>{t.openedAt == null ? <span className="pp-muted">before range</span> : fmtTime(t.openedAt)}</td>
                  <td>{fmtTime(t.closedAt)}</td>
                  <td>{closedByLabel(t.closeSource)}</td>
                  <td className={`num ${pnlClass(t.pnl)}`}>{fmtPnl(t.pnl)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      {data && view === "ledger" && (data.ledger.length === 0 ? (
        <div className="pp-empty">No ledger entries in this range.</div>
      ) : (
        <div className="pp-table-wrap">
          <table className="pp-table">
            <thead>
              <tr><th>Time</th><th>Type</th><th className="pp-c-sym">Symbol</th><th>Note</th><th className="num">Amount</th></tr>
            </thead>
            <tbody>
              {[...data.ledger].sort((a, b) => b.at - a.at).map((e) => (
                <tr key={e.reference || `${e.at}:${e.kind}`} className="pp-row">
                  <td>{fmtTime(e.at)}</td>
                  <td>{ledgerKindLabel(e.kind)}</td>
                  <td className="pp-c-sym">{e.epic ?? "—"}</td>
                  <td>{e.note}</td>
                  <td className={`num ${pnlClass(e.amount)}`}>{cash(e.amount)} {e.currency}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
```

The `—` in the Symbol cell is the table's existing null-cell glyph (`fmtTime(null)` renders the same), not prose, so it does not break the no-em-dash rule. Before finishing, check `App.css` for existing `pp-sortable`, `pp-sort`, `pp-muted` class names used by `PositionsHead` (`frontend/src/PositionsTable.tsx`) and reuse those exact names; rename in the JSX above if they differ.

- [ ] **Step 6: Add the styles**

Append to `frontend/src/App.css`, next to the other `.pp-` rules:

```css
/* History tab (HistoryPane): range + view chips and the totals line. Active chip
   is muted gray, not accent blue, like the other persistent toggles. */
.pp-history-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  padding: 6px 10px;
}
.pp-history-chips {
  display: flex;
  gap: 4px;
}
.pp-chip {
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-muted);
  font: inherit;
  font-size: 12px;
  padding: 2px 8px;
  cursor: pointer;
}
.pp-chip.on {
  background: var(--bg-hover);
  color: var(--text);
}
.pp-history-totals {
  display: flex;
  gap: 16px;
  margin-left: auto;
  font-size: 12px;
}
```

Use the CSS custom property names that `App.css` already defines for border, muted text, hover background and text (search the `.pp-tab` rule for them) instead of the names above if they differ.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/lib/historyTable.test.ts src/HistoryPane.test.tsx`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/lib/historyTable.ts frontend/src/lib/historyTable.test.ts frontend/src/HistoryPane.tsx frontend/src/HistoryPane.test.tsx frontend/src/App.css
git commit -m "feat(history): History pane with trades, ledger and totals"
```

---

### Task 6: History tab in the dock and the phone view

**Files:**
- Modify: `frontend/src/lib/positionsTable.tsx:14` (`TableTab`)
- Modify: `frontend/src/PositionsPanel.tsx` (tab buttons ~457-459, body ~485-540)
- Modify: `frontend/src/mobile/MobilePositionsView.tsx` (tab nav ~259-268, body ~270)
- Test: `frontend/src/PositionsPanel.history.test.tsx`

**Interfaces:**
- Consumes: `HistoryPane` (Task 5), `accountSupportsHistory` (Task 4).
- Produces: `TableTab = "positions" | "orders" | "history"`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/PositionsPanel.history.test.tsx`:

```tsx
// @vitest-environment jsdom
// The History tab shows only for accounts with broker history, and opens the pane.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

vi.mock("./Mt5DeployButton", () => ({ default: () => null }));
vi.mock("./HistoryPane", () => ({ default: ({ account }: { account: string }) => <div>history for {account}</div> }));

import PositionsPanel from "./PositionsPanel";
import { noteHistoryAccounts, type BrokerAccount } from "./lib/trading";
import { DEFAULT_SETTINGS } from "./theme";

const accounts: BrokerAccount[] = [
  { key: "capital:paper", broker: "capital", env: "paper", isRealMoney: false, history: false },
  { key: "capital:demo", broker: "capital", env: "demo", isRealMoney: false, history: true },
];

function mount(account: string) {
  noteHistoryAccounts(accounts);
  render(<PositionsPanel account={account} accounts={accounts} trading={DEFAULT_SETTINGS.trading} />);
}

afterEach(cleanup);

describe("PositionsPanel History tab", () => {
  it("is absent on an account without broker history", () => {
    mount("capital:paper");
    expect(screen.queryByRole("button", { name: "History" })).toBeNull();
  });

  it("opens the history pane for a history account", () => {
    mount("capital:demo");
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    expect(screen.getByText("history for capital:demo")).toBeTruthy();
    expect(screen.queryByText("No open positions.")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npx vitest run src/PositionsPanel.history.test.tsx`
Expected: FAIL, no button named "History".

- [ ] **Step 3: Widen TableTab**

In `frontend/src/lib/positionsTable.tsx:14`:

```ts
export type TableTab = "positions" | "orders" | "history";
```

Then search the file for `tab === "positions"` ternaries in `POSITION_COLUMNS` label/tip callbacks; they treat anything else as "orders", which is fine because the history tab never renders `PositionsHead`.

- [ ] **Step 4: Wire the dock**

In `frontend/src/PositionsPanel.tsx`:

Add imports:

```ts
import HistoryPane from "./HistoryPane";
```

and `accountSupportsHistory` to the existing `./lib/trading` import.

After `const rows = tab === "positions" ? positions : orders;` add:

```ts
  const hasHistory = accountSupportsHistory(account);
  // Switching to an account without history while its tab is open falls back.
  const shownTab: TableTab = tab === "history" && !hasHistory ? "positions" : tab;
```

Replace every later read of `tab` in the render (the `rows` choice stays on `tab`; the TabButton `on=` props, the empty-state text and `PositionsHead tab=`) with `shownTab`, and change `rows` to `const rows = shownTab === "positions" ? positions : orders;` placed after `shownTab`. Also replace `tab === "positions"` in the `groups` computation with `shownTab === "positions"`.

Add the third tab button after Orders:

```tsx
            {hasHistory && (
              <TabButton label="History" count={0} on={shownTab === "history"} onClick={() => setTab("history")} />
            )}
```

Wrap the table section so history renders instead:

```tsx
          {shownTab === "history" ? (
            <HistoryPane account={account} precisionFor={precisionFor} onJumpToEpic={onJumpToEpic} />
          ) : rows.length === 0 ? (
            <div className="pp-empty">
              {shownTab === "positions" ? "No open positions." : "No working orders."}
            </div>
          ) : (
            /* existing pp-table-wrap block unchanged */
          )}
```

(Keep the existing `<div className="pp-table-wrap">…</div>` block as the last branch verbatim.)

- [ ] **Step 5: Wire the phone view**

In `frontend/src/mobile/MobilePositionsView.tsx`, add `import HistoryPane from "../HistoryPane";` and `accountSupportsHistory` to the `../lib/trading` import. Below `const account = getTradesAccount();` add:

```ts
  const hasHistory = accountSupportsHistory(account);
  const shownTab: TableTab = tab === "history" && !hasHistory ? "positions" : tab;
```

Use `shownTab` where the render reads `tab` (the `unsorted` choice, `orderKey`, `rankRows`, the tab `on` classes, the empty-state text, `PositionsHead tab=`). Add after the Orders button:

```tsx
        {hasHistory && (
          <button className={`pp-tab${shownTab === "history" ? " on" : ""}`} onClick={() => setTab("history")}>
            History
          </button>
        )}
```

and render `<HistoryPane account={account} tips={false} />` in place of the table when `shownTab === "history"`, with the same ternary shape as the dock.

- [ ] **Step 6: Run the tests**

Run: `cd frontend && npx vitest run src/PositionsPanel.history.test.tsx src/PositionsPanel.mt5LiveSwitch.test.tsx src/HistoryPane.test.tsx`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/positionsTable.tsx frontend/src/PositionsPanel.tsx frontend/src/mobile/MobilePositionsView.tsx frontend/src/PositionsPanel.history.test.tsx
git commit -m "feat(history): History tab in the positions dock and phone view"
```

---

### Task 7: Closed-trade chart markers

**Files:**
- Modify: `frontend/src/lib/tradeMarkers.ts` (new exports after `exitMarkerSpecs`)
- Modify: `frontend/src/ChartCore.tsx` (refs ~831-836, `drawTradeMarkers` ~3731-3769, subscriptions ~3770-3795 and their cleanup)
- Test: `frontend/src/lib/tradeMarkers.test.ts`

**Interfaces:**
- Consumes: `ClosedTradeView`, `subscribeMarkerHistory`, `MarkerHistory` (Task 4); existing `TradeMarkerSpecOpts`, `JournalTrade`, `tradeLabel`.
- Produces: `historyAsJournal(trades: ClosedTradeView[]): JournalTrade[]`, `historyEntrySpecs(history: ClosedTradeView[], o: TradeMarkerSpecOpts): TradeMarkerSpec[]`.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/lib/tradeMarkers.test.ts` (add the imports to the existing import lines at the top):

```ts
import { historyAsJournal, historyEntrySpecs, exitMarkerSpecs } from "./tradeMarkers";
import type { ClosedTradeView } from "./accountHistory";

function closed(over: Partial<ClosedTradeView> = {}): ClosedTradeView {
  return {
    dealId: "H1", epic: "OIL", side: "buy", size: 1, entry: 70, exit: 71,
    openedAt: 1_000, closedAt: 4_000, closeSource: "TP", pnl: 9.5, currency: "EUR", ...over,
  };
}

describe("broker history markers", () => {
  it("maps closes onto the journal shape so exits reuse the journal path", () => {
    const [j] = historyAsJournal([closed({ side: "sell", pnl: -3 })]);
    expect(j).toEqual({ ts: 4, epic: "OIL", leg: "short", entry: 70, exit: 71, quantity: 1, pnl: -3 });
  });

  it("derives a missing pnl from the move and direction", () => {
    expect(historyAsJournal([closed({ pnl: null, side: "sell", entry: 70, exit: 69, size: 2 })])[0].pnl).toBe(2);
  });

  it("gives each partial its own exit marker", () => {
    const journal = historyAsJournal([closed({ closedAt: 4_000 }), closed({ closedAt: 5_000, exit: 72 })]);
    const keys = exitMarkerSpecs({ ...base, trades: [], journal }).map((s) => s.key);
    expect(new Set(keys).size).toBe(2);
  });

  it("draws one hentry per deal, at the open, with the summed size", () => {
    const specs = historyEntrySpecs(
      [closed({ size: 1, closedAt: 4_000 }), closed({ size: 2, closedAt: 5_000 })],
      { ...base, trades: [], journal: [] },
    );
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ key: "hentry:H1", timestamp: 1_000, price: 70, placement: "below", win: null });
    expect(specs[0].label).toContain("3");
  });

  it("skips the entry while the deal is still open, when the open time is unknown, or off-window", () => {
    const opts = { ...base, journal: [] };
    expect(historyEntrySpecs([closed()], { ...opts, trades: [position({ id: "H1" })] })).toEqual([]);
    expect(historyEntrySpecs([closed({ openedAt: null })], { ...opts, trades: [] })).toEqual([]);
    expect(historyEntrySpecs([closed()], { ...opts, trades: [], oldestLoadedMs: 2_000 })).toEqual([]);
  });

  it("draws nothing for another epic or while replaying", () => {
    expect(historyEntrySpecs([closed({ epic: "GOLD" })], { ...base, trades: [], journal: [] })).toEqual([]);
    expect(historyEntrySpecs([closed()], { ...base, trades: [], journal: [], replaying: true })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd frontend && npx vitest run src/lib/tradeMarkers.test.ts`
Expected: FAIL, `historyAsJournal` is not exported.

- [ ] **Step 3: Implement the history source**

In `frontend/src/lib/tradeMarkers.ts`, add `import type { ClosedTradeView } from "./accountHistory";` beside the other type imports, and after `exitMarkerSpecs`:

```ts
/** Broker-reported closes (lib/accountHistory) as journal rows, so exits flow
 * through the SAME path as journal exits: per-fill arrows via exitMarkerSpecs and
 * coarse-view pills via aggregateExitsByBar. Each partial close has its own close
 * time, so journalKey stays unique across partials. A close with no broker P&L
 * gets (exit - entry) x direction x size, the journal's own pnl unit. */
export function historyAsJournal(trades: ClosedTradeView[]): JournalTrade[] {
  return trades.map((t) => {
    const dir = t.side === "buy" ? 1 : -1;
    return {
      ts: t.closedAt / 1000,
      epic: t.epic,
      leg: t.side === "buy" ? "long" : "short",
      entry: t.entry,
      exit: t.exit,
      quantity: t.size,
      pnl: t.pnl ?? (t.exit - t.entry) * dir * t.size,
    };
  });
}

/** ENTRY markers for broker-closed trades: one per deal (partials share it, size
 * summed), at the matched open. Skipped while any part of the deal is still open
 * (the position book's own `entry:<id>` marker covers it), when the open fell
 * before the fetched range, off the loaded window, or while replaying. Keyed
 * `hentry:` so it never collides with an open position's `entry:`. */
export function historyEntrySpecs(history: ClosedTradeView[], o: TradeMarkerSpecOpts): TradeMarkerSpec[] {
  if (o.replaying) return [];
  const open = new Set(o.trades.filter((t) => t.kind === "position").map((t) => t.id));
  const byDeal = new Map<string, { first: ClosedTradeView; size: number }>();
  for (const t of history) {
    if (t.epic !== o.epic || t.openedAt == null || open.has(t.dealId)) continue;
    const seen = byDeal.get(t.dealId);
    if (seen) seen.size += t.size;
    else byDeal.set(t.dealId, { first: t, size: t.size });
  }
  const specs: TradeMarkerSpec[] = [];
  for (const [dealId, { first, size }] of byDeal) {
    const at = first.openedAt as number;
    if (!drawableAt(at, o.oldestLoadedMs)) continue;
    specs.push({
      key: `hentry:${dealId}`,
      timestamp: at,
      price: first.entry,
      label: `${tradeLabel("position", first.side)} ${size} @ ${first.entry.toFixed(o.precision)}`,
      win: null,
      placement: first.side === "buy" ? "below" : "above",
    });
  }
  return specs;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/lib/tradeMarkers.test.ts`
Expected: all pass.

- [ ] **Step 5: Feed it into ChartCore**

In `frontend/src/ChartCore.tsx`:

Add `historyAsJournal, historyEntrySpecs` to the `./lib/tradeMarkers` import and add:

```ts
import { subscribeMarkerHistory, type MarkerHistory } from "./lib/accountHistory";
```

Next to `journalRef` (~833):

```ts
  // Broker-reported closes for the trades account (lib/accountHistory). When
  // active they REPLACE the journal as the exit source and add closed-trade
  // entries; inactive (paper, other brokers) leaves the journal path as it was.
  const markerHistRef = useRef<MarkerHistory>({ active: false, trades: [] });
```

In `drawTradeMarkers`, compute the exit source once and use it in both the opts and the aggregation:

```ts
        const hist = markerHistRef.current;
        const exitSource = hist.active ? historyAsJournal(hist.trades) : journalRef.current;
        const opts = {
          trades: tradesRef.current,
          journal: exitSource,
          epic: epicRef.current,
          precision: precisionRef.current,
          oldestLoadedMs,
          replaying,
        };
        const entry = [
          ...entryMarkerSpecs(opts),
          ...(hist.active ? historyEntrySpecs(hist.trades, opts) : []),
        ];
        const clusters = aggregateExitsByBar(
          exitSource,
          epicRef.current,
          bars.map((k) => ({ timestamp: k.timestamp, high: k.high })),
          replaying,
        );
```

(The rest of the function, the `exitsCollide` branch, stays as is.)

After `unsubJournal`:

```ts
      const unsubHistory = subscribeMarkerHistory((h) => {
        markerHistRef.current = h;
        drawTradeMarkers();
        handle.redrawRef.current(); // re-project the coarse-TF exit pills
      });
```

and call `unsubHistory()` in the same cleanup that calls `unsubJournal()` (search the effect's return for `unsubJournal();`).

- [ ] **Step 6: Run the affected tests**

Run: `cd frontend && npx vitest run src/lib/tradeMarkers.test.ts src/lib/accountHistory.test.ts`
Expected: all pass. (ChartCore has no unit test for this path; it is covered by the manual check in Task 8.)

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/tradeMarkers.ts frontend/src/lib/tradeMarkers.test.ts frontend/src/ChartCore.tsx
git commit -m "feat(history): closed-trade chart markers from broker history"
```

---

### Task 8: Typecheck, lint, docs and the manual check

**Files:**
- Modify: `CLAUDE.md` (new short `## Account history` section after `## Alerts`)

- [ ] **Step 1: Ask before the heavy checks**

`tsc -b` and eslint are high CPU on the user's laptop. Ask once: "Run `npx tsc -b` and `npx eslint src` in frontend, plus the backend history tests?" Wait for yes.

- [ ] **Step 2: Run them**

```bash
cd frontend && npx tsc -b && npx eslint src/HistoryPane.tsx src/lib/accountHistory.ts src/lib/historyTable.ts src/lib/tradeMarkers.ts src/ChartCore.tsx src/PositionsPanel.tsx src/mobile/MobilePositionsView.tsx src/lib/trading.ts
cd ../backend && uv run pytest tests/test_capital_history.py tests/test_history_route.py tests/test_trading_reconnect.py tests/test_capital_exec.py -q
```

Expected: zero tsc errors, zero eslint errors, all pytest green. Fix anything reported before continuing.

- [ ] **Step 3: Document it in CLAUDE.md**

Append after the Alerts section of the repo-root `CLAUDE.md`:

```markdown
## Account history

Capital.com dealing accounts (`capital:demo`, `capital-live:live`) report
closed trades and the cash ledger through `ExecutionBroker.get_history`
(`supports_history`), served by `GET /api/history?account=&days=7|30|90`
with epoch-ms times; other accounts answer `{supported: false}`. Upstream
limits shape `brokers/_capital_history.py`: transactions cap at 100 rows per
call (paged, deduped on `reference`), activity at one day per call (walked
sequentially through the shared rate limiter, past days kept in `DayCache`).
The History tab (`HistoryPane.tsx`) and the chart's closed-trade markers both
read `lib/accountHistory.ts`; on a history account the markers replace the
live journal's exits. Spec: docs/superpowers/specs/2026-10-21-capital-account-history-design.md.
```

- [ ] **Step 4: Manual check (read-only, live account)**

Ask the user to open the app on `capital-live:live`, open the History tab on 30d, and compare three closed trades (entry, exit, P&L, closed by) and the funding total against Capital's own web history for the same range. Then focus a recently closed epic (TSLA had a TP close on 2026-10-21) and confirm one entry and one exit marker. Do not drive this through Playwright MCP (it is the user's real Chrome).

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: account history in CLAUDE.md"
```
