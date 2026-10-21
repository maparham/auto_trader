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

import asyncio
import logging
from collections import OrderedDict, defaultdict
from collections.abc import Awaitable, Callable
from dataclasses import replace
from datetime import date, datetime, time, timedelta, timezone

import httpx

from auto_trader.core.models import ClosedTrade, LedgerEntry, Side

logger = logging.getLogger(__name__)

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
        status = r.get("status")
        if status is not None and status != "ACCEPTED":
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
    """Give each close a TRADE ledger row of the same deal, each row used once.
    Partial closes share a dealId, so pairs are taken closest-in-time first across
    the whole deal: a close whose own row fell outside a truncated ledger then
    stays unmatched instead of taking a later partial's row."""
    pool: dict[str, list[LedgerEntry]] = defaultdict(list)
    for e in ledger:
        if e.kind == "TRADE" and e.deal_id:
            pool[e.deal_id].append(e)
    ordered = sorted(trades, key=lambda t: t.closed_at)
    edges = sorted(
        (abs((e.at - t.closed_at).total_seconds()), i, j)
        for i, t in enumerate(ordered)
        for j, e in enumerate(pool.get(t.deal_id, ()))
    )
    matched: dict[int, LedgerEntry] = {}
    used: set[tuple[str, int]] = set()
    for _, i, j in edges:
        deal = ordered[i].deal_id
        if i in matched or (deal, j) in used:
            continue
        matched[i] = pool[deal][j]
        used.add((deal, j))
    return [
        replace(t, pnl=matched[i].amount, currency=matched[i].currency) if i in matched else t
        for i, t in enumerate(ordered)
    ]


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


RequestFn = Callable[..., Awaitable[httpx.Response]]

# Capital expects naive UTC, whole seconds.
_TS_FMT = "%Y-%m-%dT%H:%M:%S"
TX_PAGE = 100  # transactions rows per call (server cap)
TX_MAX_PAGES = 20
DAY_CACHE_MAX = 120


def _fmt(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime(_TS_FMT)


def _ceil_second(dt: datetime) -> datetime:
    """Capital takes whole seconds; round UP so rows sharing the oldest row's
    second come back on the next page."""
    return dt.replace(microsecond=0) + (timedelta(seconds=1) if dt.microsecond else timedelta(0))


def _row_key(r: dict) -> str:
    """Dedupe key: `reference`, or the row's own fields when it has none, so
    blank references cannot collapse distinct rows into one."""
    ref = r.get("reference")
    if ref:
        return str(ref)
    return "|".join(str(r.get(k)) for k in ("dateUtc", "transactionType", "instrumentName", "size", "dealId"))


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def fetch_transactions(
    request: RequestFn, since: datetime, until: datetime,
) -> tuple[list[LedgerEntry], bool]:
    """Page the 100-row-capped ledger newest to oldest. The next page ends at the
    oldest row seen, rounded UP to a whole second (Capital takes whole seconds and
    rows carry milliseconds), so rows sharing that second come back and are deduped
    on `reference`. Stops on a short page, a page with nothing new (100+ rows in
    one second), or the page cap. The flag is True when it stopped on a full page
    (the cap, or a stuck second), so older rows in the range may be missing."""
    seen: dict[str, dict] = {}
    truncated = False
    # Not rounded up: `until` is "now", and Capital 400s a `to` in the future.
    # Rows in the trailing partial second land on the next refresh.
    to = until
    for _ in range(TX_MAX_PAGES):
        resp = await request(
            "GET", "/api/v1/history/transactions",
            params={"from": _fmt(since), "to": _fmt(to)},
        )
        rows = resp.json().get("transactions") or []
        fresh = [r for r in rows if _row_key(r) not in seen]
        for r in fresh:
            seen[_row_key(r)] = r
        if len(rows) < TX_PAGE:
            break
        if not fresh:
            truncated = True
            break
        times = [t for r in rows if (t := utc(r.get("dateUtc"))) is not None]
        if not times:
            break
        to = _ceil_second(min(times))
    else:
        truncated = True
        logger.warning(
            "fetch_transactions hit the %d-page cap for range %s..%s; older rows may be missing",
            TX_MAX_PAGES, since, until,
        )
    return parse_transactions(list(seen.values())), truncated


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

        # Settled on the task itself, not in this awaiter: if the request that
        # started the fetch is cancelled, the shielded task still finishes, stays
        # in-flight for later askers until then, and still lands in the cache.
        def settle(t: asyncio.Future) -> None:
            self._inflight.pop(d, None)
            if t.cancelled() or t.exception() is not None:
                return
            day_end = datetime.combine(d + timedelta(days=1), time(0), tzinfo=timezone.utc)
            if day_end <= started:
                self._days[d] = t.result()
                while len(self._days) > self._max:
                    self._days.popitem(last=False)

        task.add_done_callback(settle)
        return await asyncio.shield(task)


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
