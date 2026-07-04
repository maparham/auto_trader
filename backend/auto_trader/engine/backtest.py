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
from auto_trader.engine.scaling import ScalingConfig, spacing_ok
from auto_trader.strategy.base import Context, Strategy


@dataclass(slots=True)
class EquityPoint:
    time: datetime
    equity: float


@dataclass(slots=True)
class Position:
    """One open position on a side. For independent mode each entry is its own
    Position; for the current (single-bucket) behaviour a side holds at most one.
    `stop`/`target` are absolute levels (None = none); `extreme` is the favorable
    high/low water mark since entry (for trailing); `breakeven_armed` is reserved
    for a later phase and unused here."""
    qty: float
    entry: float
    open_time: datetime
    open_reason: str
    stop: float | None = None
    target: float | None = None
    extreme: float = 0.0
    breakeven_armed: bool = False
    stop_initial: float | None = None


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
        long_scaling: ScalingConfig | None = None,
        short_scaling: ScalingConfig | None = None,
    ) -> None:
        self.strategy = strategy
        self.starting_cash = starting_cash
        self.commission = commission_per_side
        self.slippage = slippage
        self.long_risk = long_risk
        self.short_risk = short_risk
        self.series = series or {}
        self.long_scaling = long_scaling or ScalingConfig()
        self.short_scaling = short_scaling or ScalingConfig()

    def run(self, candles: list[Candle]) -> BacktestResult:
        result = BacktestResult()
        ctx = Context()

        longs: list[Position] = []
        shorts: list[Position] = []
        realized = 0.0
        pending: list[Signal] = []  # signals from the previous bar, filled at this open

        peak_equity = self.starting_cash
        last_long_open: float | None = None
        last_short_open: float | None = None

        for i, bar in enumerate(candles):
            # 1) Fill everything queued on the previous bar at THIS bar's open.
            for sig in pending:
                fill_price = self._fill_price(bar.open, sig.side)
                if sig.leg == "long":
                    positions, side, risk, scaling = longs, "long", self.long_risk, self.long_scaling
                    opening = sig.side is Side.BUY
                    last_open = last_long_open
                    close_side = Side.SELL
                else:
                    positions, side, risk, scaling = shorts, "short", self.short_risk, self.short_scaling
                    opening = sig.side is Side.SELL
                    last_open = last_short_open
                    close_side = Side.BUY

                if opening:
                    atr = self._atr_at(scaling.spacing.length if scaling.spacing else None, i)
                    if len(positions) >= scaling.max_concurrent or not spacing_ok(
                        scaling.spacing, last_open, fill_price, side, atr
                    ):
                        continue  # cap/spacing rejected: no fill, no commission
                    result.fills.append(Fill(bar.time, sig.side, fill_price, sig.quantity, sig.reason, sig.leg))
                    realized -= self.commission
                    self._open(positions, side, risk, fill_price, bar.time, sig.reason, sig.quantity, i)
                    if side == "long":
                        last_long_open = fill_price
                    else:
                        last_short_open = fill_price
                else:
                    realized = self._close_all(positions, side, result, realized, close_side, fill_price, bar.time, sig.reason)
                    if side == "long":
                        last_long_open = None
                    else:
                        last_short_open = None
            pending = []

            # 1b) Intra-bar stop/target, then 1c) trailing ratchet — per side.
            realized = self._intrabar_exit(longs, "long", self.long_risk, result, realized, bar)
            realized = self._intrabar_exit(shorts, "short", self.short_risk, result, realized, bar)
            # An intrabar stop/target that empties a side clears its spacing
            # anchor, so the next entry isn't wrongly blocked by a stale last-open.
            if not longs:
                last_long_open = None
            if not shorts:
                last_short_open = None
            self._ratchet_trailing(longs, "long", self.long_risk, bar, i)
            self._ratchet_trailing(shorts, "short", self.short_risk, bar, i)

            # 2) Mark-to-market on the close.
            equity = (
                self.starting_cash + realized
                + self._unrealized(longs, "long", bar.close)
                + self._unrealized(shorts, "short", bar.close)
            )
            result.equity.append(EquityPoint(bar.time, equity))
            peak_equity = max(peak_equity, equity)
            result.max_drawdown = max(result.max_drawdown, peak_equity - equity)

            # 3) Let the strategy decide for the NEXT bar (no lookahead).
            ctx.history.append(bar)
            ctx.position_long = sum(p.qty for p in longs)
            ctx.position_short = sum(p.qty for p in shorts)
            if i < len(candles) - 1:  # last bar has no next-open to fill on
                pending = list(self.strategy.on_bar(ctx))

        # Settle any still-open positions at the last close so net_pnl matches the
        # final equity point.
        if candles:
            last = candles[-1].close
            realized += self._unrealized(longs, "long", last)
            realized += self._unrealized(shorts, "short", last)
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

    def _open(self, positions, side, risk, fill_price, bar_time, reason, qty, i):
        """Open a NEW independent position; seed its stop/target/extreme from the
        fill price. (Pyramiding/merge is a later phase.)"""
        p = Position(qty=qty, entry=fill_price, open_time=bar_time, open_reason=reason)
        if risk:
            p.extreme = fill_price
            p.stop = stop_level(risk.stop, fill_price, side, self._atr_at(risk.stop.length, i), p.extreme)
            p.stop_initial = p.stop
            p.target = target_level(risk.target, fill_price, side, self._atr_at(risk.target.length, i))
        positions.append(p)

    def _close_all(self, positions, side, result, realized, close_side, fill_price, bar_time, reason):
        """Close EVERY open position on the side (P2 exit scope). One fill +
        commission + Trade per position. Returns updated realized."""
        while positions:
            result.fills.append(Fill(bar_time, close_side, fill_price, positions[0].qty, reason, side))
            realized -= self.commission
            realized = self._reduce(positions, side, result, realized, fill_price, bar_time, reason, positions[0].qty)
        return realized

    def _reduce(self, positions, side, result, realized, fill_price, bar_time, reason, qty):
        """A closing fill (SELL for long, BUY for short) of `qty` units against the
        side's open position; books a Trade and drops the position if flat. Returns
        the updated realized pnl."""
        if not positions:
            return realized
        p = positions[0]
        closing = min(qty, p.qty)
        if closing <= 0:
            return realized
        if side == "long":
            pnl = closing * (fill_price - p.entry)
            trade_side = Side.BUY
        else:
            pnl = closing * (p.entry - fill_price)
            trade_side = Side.SELL
        realized += pnl
        result.trades.append(
            Trade(
                side=trade_side, quantity=closing,
                entry_time=p.open_time, entry_price=p.entry,
                exit_time=bar_time, exit_price=fill_price, pnl=pnl,
                leg=side, reason_in=p.open_reason, reason_out=reason,
                stop_initial=p.stop_initial, stop_final=p.stop, target=p.target,
            )
        )
        p.qty -= closing
        if p.qty == 0:
            positions.pop(0)
        return realized

    def _intrabar_exit(self, positions, side, risk, result, realized, bar):
        """Pessimistic intra-bar stop/target for the side's open position (the
        open resolves the order when it gaps through the target). Books the exit
        and returns updated realized pnl. See the stops-feature design."""
        if not positions or not risk:
            return realized
        p = positions[0]
        hit = None
        if side == "long":
            if p.target is not None and bar.open >= p.target:
                hit = (self._fill_price(p.target, Side.SELL), "target")
            elif p.stop is not None and bar.low <= p.stop:
                raw = min(bar.open, p.stop)
                hit = (self._fill_price(raw, Side.SELL), "trail" if is_trailing(risk.stop) else "stop")
            elif p.target is not None and bar.high >= p.target:
                hit = (self._fill_price(p.target, Side.SELL), "target")
            close_side = Side.SELL
        else:
            if p.target is not None and bar.open <= p.target:
                hit = (self._fill_price(p.target, Side.BUY), "target")
            elif p.stop is not None and bar.high >= p.stop:
                raw = max(bar.open, p.stop)
                hit = (self._fill_price(raw, Side.BUY), "trail" if is_trailing(risk.stop) else "stop")
            elif p.target is not None and bar.low <= p.target:
                hit = (self._fill_price(p.target, Side.BUY), "target")
            close_side = Side.BUY
        if hit:
            px, reason = hit
            result.fills.append(Fill(bar.time, close_side, px, p.qty, reason, side))
            realized -= self.commission
            realized = self._reduce(positions, side, result, realized, px, bar.time, reason, p.qty)
        return realized

    def _ratchet_trailing(self, positions, side, risk, bar, i):
        """Extend the trailing extreme with THIS bar's high/low and recompute the
        stop for the NEXT bar — clamped so a trailing stop never loosens (and a
        cold ATR never wipes it)."""
        if not positions or not risk or not is_trailing(risk.stop):
            return
        p = positions[0]
        if side == "long":
            p.extreme = max(p.extreme, bar.high)
        else:
            p.extreme = min(p.extreme, bar.low)
        new_stop = stop_level(risk.stop, p.entry, side, self._atr_at(risk.stop.length, i), p.extreme)
        if new_stop is not None:
            if p.stop is None:
                p.stop = new_stop
            else:
                p.stop = max(p.stop, new_stop) if side == "long" else min(p.stop, new_stop)

    @staticmethod
    def _unrealized(positions, side, close):
        total = 0.0
        for p in positions:
            total += p.qty * (close - p.entry) if side == "long" else p.qty * (p.entry - close)
        return total
