"""Account-wide figures from broker data only: the server-side half of
frontend/src/lib/accountStats.ts. The browser adds estimates the server has no
inputs for (working-order margin from the configured leverage, the paper
balance); those are left out on purpose, so a margin level here can differ
slightly from the dock's when resting orders reserve margin."""
from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from auto_trader.core.models import Position

METRICS = ("marginLevel", "openPnl", "openPnlPct", "equity", "available", "drawdown")


@dataclass(frozen=True)
class AccountMetrics:
    balance: float | None
    equity: float | None
    margin: float | None
    available: float | None
    open_pnl: float | None
    margin_level: float | None
    open_pnl_pct: float | None
    currency: str | None
    # Figures a judgement needs but the broker did not supply while positions
    # are open. Non-empty means "not monitored", never a silent hold.
    missing: tuple[str, ...]

    def value_of(self, metric: str) -> float | None:
        return {
            "marginLevel": self.margin_level,
            "openPnl": self.open_pnl,
            "openPnlPct": self.open_pnl_pct,
            "equity": self.equity,
            "available": self.available,
        }.get(metric)


def _num(v) -> float | None:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def account_metrics(
    summary: dict | None, positions: Sequence[Position], *, cash_balance: bool
) -> AccountMetrics:
    s = summary or {}
    balance = _num(s.get("balance"))
    available = _num(s.get("available"))
    currency = s.get("currency") if isinstance(s.get("currency"), str) else None
    reported_pnl = _num(s.get("profitLoss"))
    summed = [p.upnl for p in positions if p.upnl is not None]
    open_pnl = reported_pnl if reported_pnl is not None else (sum(summed) if positions else 0.0)
    if positions and reported_pnl is None and len(summed) != len(positions):
        open_pnl = None

    missing: list[str] = []
    if positions:
        if balance is None:
            missing.append("balance")
        if available is None:
            missing.append("available")
        if open_pnl is None:
            missing.append("profitLoss")

    all_margin_known = bool(positions) and all(p.margin is not None for p in positions)
    margin: float | None
    equity: float | None
    if not positions:
        margin = 0.0
        equity = balance if (not cash_balance or open_pnl is None) else (
            balance + open_pnl if balance is not None else None)
    elif missing:
        margin = None
        equity = None
    elif all_margin_known:
        margin = sum(p.margin for p in positions)  # type: ignore[misc]
        equity = available + margin  # type: ignore[operator]
    else:
        pnl_term = open_pnl if cash_balance else 0.0
        margin = max(0.0, balance + pnl_term - available)  # type: ignore[operator]
        equity = balance if not cash_balance else balance + open_pnl  # type: ignore[operator]

    margin_level = (equity / margin * 100) if (equity is not None and margin) else None
    open_pnl_pct = (open_pnl / balance * 100) if (open_pnl is not None and balance) else None
    return AccountMetrics(
        balance=balance, equity=equity, margin=margin, available=available,
        open_pnl=open_pnl, margin_level=margin_level, open_pnl_pct=open_pnl_pct,
        currency=currency, missing=tuple(missing),
    )
