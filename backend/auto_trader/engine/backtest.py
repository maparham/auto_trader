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

from auto_trader.core.models import Candle, Fill, Side, Signal, Trade
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

        # Two independent buckets (hedging). Each holds a non-negative size, its
        # average entry price, and the open time/reason for trade records.
        long_qty = short_qty = 0.0
        long_entry = short_entry = 0.0
        long_time: datetime | None = None
        short_time: datetime | None = None
        long_reason = short_reason = ""
        realized = 0.0
        pending: list[Signal] = []  # signals from the previous bar, filled at this open

        peak_equity = self.starting_cash

        for i, bar in enumerate(candles):
            # 1) Fill everything queued on the previous bar at THIS bar's open.
            for sig in pending:
                fill_price = self._fill_price(bar.open, sig.side)
                result.fills.append(
                    Fill(bar.time, sig.side, fill_price, sig.quantity, sig.reason, sig.leg)
                )
                realized -= self.commission  # one side's commission per fill

                if sig.leg == "long":
                    if sig.side is Side.BUY:  # open / add long
                        new_qty = long_qty + sig.quantity
                        long_entry = (
                            (long_qty * long_entry + sig.quantity * fill_price) / new_qty
                            if new_qty
                            else 0.0
                        )
                        if long_qty == 0:
                            long_time, long_reason = bar.time, sig.reason
                        long_qty = new_qty
                    else:  # SELL -> close / reduce long
                        closing = min(sig.quantity, long_qty)
                        if closing > 0:
                            pnl = closing * (fill_price - long_entry)
                            realized += pnl
                            result.trades.append(
                                Trade(
                                    side=Side.BUY, quantity=closing,
                                    entry_time=long_time, entry_price=long_entry,  # type: ignore[arg-type]
                                    exit_time=bar.time, exit_price=fill_price, pnl=pnl,
                                    leg="long", reason_in=long_reason, reason_out=sig.reason,
                                )
                            )
                            long_qty -= closing
                            if long_qty == 0:
                                long_entry, long_time, long_reason = 0.0, None, ""
                else:  # short leg
                    if sig.side is Side.SELL:  # open / add short
                        new_qty = short_qty + sig.quantity
                        short_entry = (
                            (short_qty * short_entry + sig.quantity * fill_price) / new_qty
                            if new_qty
                            else 0.0
                        )
                        if short_qty == 0:
                            short_time, short_reason = bar.time, sig.reason
                        short_qty = new_qty
                    else:  # BUY -> close / reduce short
                        closing = min(sig.quantity, short_qty)
                        if closing > 0:
                            pnl = closing * (short_entry - fill_price)  # short profits on a drop
                            realized += pnl
                            result.trades.append(
                                Trade(
                                    side=Side.SELL, quantity=closing,
                                    entry_time=short_time, entry_price=short_entry,  # type: ignore[arg-type]
                                    exit_time=bar.time, exit_price=fill_price, pnl=pnl,
                                    leg="short", reason_in=short_reason, reason_out=sig.reason,
                                )
                            )
                            short_qty -= closing
                            if short_qty == 0:
                                short_entry, short_time, short_reason = 0.0, None, ""
            pending = []

            # 2) Mark-to-market both buckets on the close.
            long_unrealized = long_qty * (bar.close - long_entry) if long_qty else 0.0
            short_unrealized = short_qty * (short_entry - bar.close) if short_qty else 0.0
            equity = self.starting_cash + realized + long_unrealized + short_unrealized
            result.equity.append(EquityPoint(bar.time, equity))
            peak_equity = max(peak_equity, equity)
            result.max_drawdown = max(result.max_drawdown, peak_equity - equity)

            # 3) Let the strategy decide for the NEXT bar (no lookahead).
            ctx.history.append(bar)
            ctx.position_long = long_qty
            ctx.position_short = short_qty
            if i < len(candles) - 1:  # last bar has no next-open to fill on
                pending = list(self.strategy.on_bar(ctx))

        # Mark-to-market any still-open buckets at the last bar so net_pnl matches
        # the final equity point instead of reporting ~0 for a held position.
        if candles:
            last = candles[-1].close
            realized += long_qty * (last - long_entry) if long_qty else 0.0
            realized += short_qty * (short_entry - last) if short_qty else 0.0
        result.net_pnl = realized
        result.n_trades = len(result.trades)
        round_trip_cost = 2 * self.commission
        wins = sum(1 for t in result.trades if t.pnl > round_trip_cost)
        result.win_rate = wins / result.n_trades if result.n_trades else 0.0
        return result

    # --- helpers ----------------------------------------------------------

    def _fill_price(self, open_price: float, side: Side) -> float:
        # Slippage pushes the price against us: pay more to buy, receive less to sell.
        return open_price + (self.slippage if side is Side.BUY else -self.slippage)
