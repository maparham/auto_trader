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
