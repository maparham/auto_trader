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
from auto_trader.engine.risk import RiskConfig, is_trailing, stop_level, target_level
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
        long_risk: RiskConfig | None = None,
        short_risk: RiskConfig | None = None,
        series: dict[str, list[float | None]] | None = None,
    ) -> None:
        self.strategy = strategy
        self.starting_cash = starting_cash
        self.commission = commission_per_side
        self.slippage = slippage
        self.long_risk = long_risk
        self.short_risk = short_risk
        self.series = series or {}

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
        long_stop = long_target = None  # active levels for the open long
        short_stop = short_target = None
        long_extreme = short_extreme = 0.0  # favorable high/low water mark since entry
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
                            if self.long_risk:
                                long_extreme = fill_price
                                long_stop = stop_level(
                                    self.long_risk.stop, fill_price, "long",
                                    self._atr_at(self.long_risk.stop.length, i), long_extreme,
                                )
                                long_target = target_level(
                                    self.long_risk.target, fill_price, "long",
                                    self._atr_at(self.long_risk.target.length, i),
                                )
                        long_qty = new_qty
                    else:  # SELL -> close / reduce long
                        closing = min(sig.quantity, long_qty)
                        if closing > 0:
                            realized, long_qty = self._close_long(
                                result, realized, long_qty, long_entry, long_time,
                                long_reason, fill_price, bar.time, sig.reason, closing,
                            )
                            if long_qty == 0:
                                long_entry, long_time, long_reason = 0.0, None, ""
                                long_stop = long_target = None
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
                            if self.short_risk:
                                short_extreme = fill_price
                                short_stop = stop_level(
                                    self.short_risk.stop, fill_price, "short",
                                    self._atr_at(self.short_risk.stop.length, i), short_extreme,
                                )
                                short_target = target_level(
                                    self.short_risk.target, fill_price, "short",
                                    self._atr_at(self.short_risk.target.length, i),
                                )
                        short_qty = new_qty
                    else:  # BUY -> close / reduce short
                        closing = min(sig.quantity, short_qty)
                        if closing > 0:
                            realized, short_qty = self._close_short(
                                result, realized, short_qty, short_entry, short_time,
                                short_reason, fill_price, bar.time, sig.reason, closing,
                            )
                            if short_qty == 0:
                                short_entry, short_time, short_reason = 0.0, None, ""
                                short_stop = short_target = None
            pending = []

            # 1b) Intra-bar stop/target for any open bucket. Pessimistic: stop is
            # tested before target EXCEPT when the bar already opens at/through the
            # target (the open resolves that order); gaps fill against us; and this
            # runs AFTER open/rule-exit fills so a same-bar rule exit pre-empts it.
            if long_qty > 0 and self.long_risk:
                hit = None
                if long_target is not None and bar.open >= long_target:
                    # Opened at/through the target: it filled at the open, before
                    # the bar's low could reach the stop. The open resolves the
                    # intra-bar order, so this is NOT the ambiguous stop-wins case.
                    hit = (self._fill_price(long_target, Side.SELL), "target")
                elif long_stop is not None and bar.low <= long_stop:
                    raw = min(bar.open, long_stop)  # gap-down fills worse
                    reason = "trail" if is_trailing(self.long_risk.stop) else "stop"
                    hit = (self._fill_price(raw, Side.SELL), reason)
                elif long_target is not None and bar.high >= long_target:
                    hit = (self._fill_price(long_target, Side.SELL), "target")
                if hit:
                    px, reason = hit
                    result.fills.append(Fill(bar.time, Side.SELL, px, long_qty, reason, "long"))
                    realized -= self.commission
                    realized, long_qty = self._close_long(
                        result, realized, long_qty, long_entry, long_time,
                        long_reason, px, bar.time, reason, long_qty,
                    )
                    long_entry, long_time, long_reason = 0.0, None, ""
                    long_stop = long_target = None

            if short_qty > 0 and self.short_risk:
                hit = None
                if short_target is not None and bar.open <= short_target:
                    # Opened at/through the target (mirror of the long case): the
                    # open resolves the order, so the target filled before the
                    # bar's high could reach the stop.
                    hit = (self._fill_price(short_target, Side.BUY), "target")
                elif short_stop is not None and bar.high >= short_stop:
                    raw = max(bar.open, short_stop)
                    reason = "trail" if is_trailing(self.short_risk.stop) else "stop"
                    hit = (self._fill_price(raw, Side.BUY), reason)
                elif short_target is not None and bar.low <= short_target:
                    hit = (self._fill_price(short_target, Side.BUY), "target")
                if hit:
                    px, reason = hit
                    result.fills.append(Fill(bar.time, Side.BUY, px, short_qty, reason, "short"))
                    realized -= self.commission
                    realized, short_qty = self._close_short(
                        result, realized, short_qty, short_entry, short_time,
                        short_reason, px, bar.time, reason, short_qty,
                    )
                    short_entry, short_time, short_reason = 0.0, None, ""
                    short_stop = short_target = None

            # 1c) Trailing ratchet for still-open buckets, using THIS bar's
            # extreme — for the NEXT bar only (the check above already ran).
            # A trailing stop only ever tightens. With trailAtr an ATR spike can
            # compute a looser stop (and a cold ATR yields None); clamp so the
            # stop never loosens and a momentary None never wipes it.
            if long_qty > 0 and self.long_risk and is_trailing(self.long_risk.stop):
                long_extreme = max(long_extreme, bar.high)
                new_stop = stop_level(
                    self.long_risk.stop, long_entry, "long",
                    self._atr_at(self.long_risk.stop.length, i), long_extreme,
                )
                if new_stop is not None:
                    long_stop = new_stop if long_stop is None else max(long_stop, new_stop)
            if short_qty > 0 and self.short_risk and is_trailing(self.short_risk.stop):
                short_extreme = min(short_extreme, bar.low)
                new_stop = stop_level(
                    self.short_risk.stop, short_entry, "short",
                    self._atr_at(self.short_risk.stop.length, i), short_extreme,
                )
                if new_stop is not None:
                    short_stop = new_stop if short_stop is None else min(short_stop, new_stop)

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

    def _atr_at(self, length: int | None, i: int) -> float | None:
        if length is None:
            return None
        arr = self.series.get(f"ATR_{length}", [])
        return arr[i] if i < len(arr) else None

    @staticmethod
    def _close_long(result, realized, qty, entry, entry_time, entry_reason,
                    fill_price, exit_time, exit_reason, closing):
        """Book a long close (SELL leg=long) for `closing` units; return
        (realized, remaining_qty)."""
        pnl = closing * (fill_price - entry)
        realized += pnl
        result.trades.append(
            Trade(
                side=Side.BUY, quantity=closing,
                entry_time=entry_time, entry_price=entry,  # type: ignore[arg-type]
                exit_time=exit_time, exit_price=fill_price, pnl=pnl,
                leg="long", reason_in=entry_reason, reason_out=exit_reason,
            )
        )
        return realized, qty - closing

    @staticmethod
    def _close_short(result, realized, qty, entry, entry_time, entry_reason,
                     fill_price, exit_time, exit_reason, closing):
        pnl = closing * (entry - fill_price)  # short profits on a drop
        realized += pnl
        result.trades.append(
            Trade(
                side=Side.SELL, quantity=closing,
                entry_time=entry_time, entry_price=entry,  # type: ignore[arg-type]
                exit_time=exit_time, exit_price=fill_price, pnl=pnl,
                leg="short", reason_in=entry_reason, reason_out=exit_reason,
            )
        )
        return realized, qty - closing
