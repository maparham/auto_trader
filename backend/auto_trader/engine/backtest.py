"""Event-driven backtest engine.

Design guarantees that make a backtest trustworthy:

1. No lookahead. The strategy is called at bar t with history up to and
   including t only. It never sees future bars.
2. Honest fills. A signal produced on bar t is filled at bar t+1's OPEN, not at
   bar t's close. This avoids the classic "trade at a price you couldn't have
   known" bug. A signal on the final bar is dropped (no next bar to fill on).
3. Same interface as live. The strategy receives the exact same Context it would
   get in paper/live trading; only the executor (here: simulated) differs.

Costs are modelled as a per-side commission plus optional slippage on the fill
price. Keep it explicit so results aren't accidentally optimistic.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

from auto_trader.core.models import Candle, Fill, Side, Trade
from auto_trader.strategy.base import Context, Strategy


@dataclass(slots=True)
class EquityPoint:
    time: datetime
    equity: float


@dataclass(slots=True)
class BacktestResult:
    fills: list[Fill] = field(default_factory=list)
    trades: list[Trade] = field(default_factory=list)
    equity: list[EquityPoint] = field(default_factory=list)

    # summary stats
    net_pnl: float = 0.0
    n_trades: int = 0
    win_rate: float = 0.0
    max_drawdown: float = 0.0

    def summary(self) -> dict:
        return {
            "net_pnl": round(self.net_pnl, 5),
            "n_trades": self.n_trades,
            "win_rate": round(self.win_rate, 4),
            "max_drawdown": round(self.max_drawdown, 5),
        }


class BacktestEngine:
    def __init__(
        self,
        strategy: Strategy,
        starting_cash: float = 10_000.0,
        commission_per_side: float = 0.0,
        slippage: float = 0.0,
    ) -> None:
        self.strategy = strategy
        self.starting_cash = starting_cash
        self.commission = commission_per_side
        self.slippage = slippage

    def run(self, candles: list[Candle]) -> BacktestResult:
        result = BacktestResult()
        ctx = Context()

        position = 0.0  # signed units held
        entry_price = 0.0  # average entry of the open position
        entry_time: datetime | None = None
        entry_reason = ""
        realized = 0.0
        pending: tuple[Side, float, str] | None = None  # signal awaiting next open

        peak_equity = self.starting_cash

        for i, bar in enumerate(candles):
            # 1) Execute any signal from the previous bar at THIS bar's open.
            if pending is not None:
                side, qty, reason = pending
                pending = None
                fill_price = self._fill_price(bar.open, side)
                result.fills.append(Fill(bar.time, side, fill_price, qty, reason))

                delta = qty if side is Side.BUY else -qty
                realized, position, entry_price, entry_time, entry_reason = self._apply(
                    result,
                    realized,
                    position,
                    entry_price,
                    entry_time,
                    entry_reason,
                    delta,
                    fill_price,
                    bar.time,
                    reason,
                )

            # 2) Mark-to-market equity using the close.
            unrealized = position * (bar.close - entry_price) if position else 0.0
            equity = self.starting_cash + realized + unrealized
            result.equity.append(EquityPoint(bar.time, equity))
            peak_equity = max(peak_equity, equity)
            result.max_drawdown = max(result.max_drawdown, peak_equity - equity)

            # 3) Let the strategy decide for the NEXT bar (no lookahead).
            ctx.history.append(bar)
            ctx.position = position
            if i < len(candles) - 1:  # last bar has no next-open to fill on
                signal = self.strategy.on_bar(ctx)
                if signal is not None:
                    pending = (signal.side, signal.quantity, signal.reason)

        # Include the mark-to-market of any position still open at the last bar,
        # so net_pnl matches the final equity point instead of reporting ~0 for a
        # buy-and-hold that never closed.
        final_unrealized = (
            position * (candles[-1].close - entry_price) if position and candles else 0.0
        )
        result.net_pnl = realized + final_unrealized
        result.n_trades = len(result.trades)
        wins = sum(1 for t in result.trades if t.pnl > 0)
        result.win_rate = wins / result.n_trades if result.n_trades else 0.0
        return result

    # --- helpers ----------------------------------------------------------

    def _fill_price(self, open_price: float, side: Side) -> float:
        # Slippage pushes the price against us: pay more to buy, receive less to sell.
        return open_price + (self.slippage if side is Side.BUY else -self.slippage)

    def _apply(
        self,
        result: BacktestResult,
        realized: float,
        position: float,
        entry_price: float,
        entry_time: datetime | None,
        entry_reason: str,
        delta: float,
        price: float,
        time: datetime,
        reason: str,
    ):
        """Apply a fill to the position, realizing PnL and recording round-trip
        trades when a position is reduced, closed, or reversed."""
        realized -= self.commission  # one side's commission per fill

        if position == 0 or (position > 0) == (delta > 0):
            # opening or adding in the same direction: update average entry
            new_pos = position + delta
            entry_price = (
                (abs(position) * entry_price + abs(delta) * price) / abs(new_pos)
                if new_pos
                else 0.0
            )
            if position == 0:
                entry_time, entry_reason = time, reason
            return realized, new_pos, entry_price, entry_time, entry_reason

        # opposite direction: closing some/all of the position
        closing = min(abs(delta), abs(position))
        direction = 1 if position > 0 else -1
        pnl = direction * closing * (price - entry_price)
        realized += pnl
        result.trades.append(
            Trade(
                side=Side.BUY if direction > 0 else Side.SELL,
                quantity=closing,
                entry_time=entry_time,  # type: ignore[arg-type]
                entry_price=entry_price,
                exit_time=time,
                exit_price=price,
                pnl=pnl,
                reason_in=entry_reason,
                reason_out=reason,
            )
        )

        remaining = abs(delta) - closing
        new_pos = position + delta
        if remaining > 0:
            # reversed through zero: open a fresh position with the remainder
            entry_price, entry_time, entry_reason = price, time, reason
        elif new_pos == 0:
            entry_price, entry_time, entry_reason = 0.0, None, ""
        return realized, new_pos, entry_price, entry_time, entry_reason
