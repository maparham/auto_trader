"""Simple moving-average crossover — a reference strategy for the vertical slice.

Go long when the fast SMA crosses above the slow SMA; flip flat/short when it
crosses below. Trades only on the bar where the cross happens.
"""

from __future__ import annotations

from auto_trader.core.models import Side, Signal
from auto_trader.strategy.base import Context, Strategy


def _sma(values: list[float], period: int) -> float | None:
    if len(values) < period:
        return None
    return sum(values[-period:]) / period


class SmaCross(Strategy):
    def __init__(self, fast: int = 9, slow: int = 21, quantity: float = 1.0) -> None:
        if fast >= slow:
            raise ValueError("fast period must be < slow period")
        self.fast = fast
        self.slow = slow
        self.quantity = quantity

    def on_bar(self, ctx: Context) -> Signal | None:
        closes = [c.close for c in ctx.history]
        # Need one extra bar to detect a *cross* (compare prev vs current).
        if len(closes) < self.slow + 1:
            return None

        fast_now, slow_now = _sma(closes, self.fast), _sma(closes, self.slow)
        fast_prev = _sma(closes[:-1], self.fast)
        slow_prev = _sma(closes[:-1], self.slow)
        if None in (fast_now, slow_now, fast_prev, slow_prev):
            return None

        crossed_up = fast_prev <= slow_prev and fast_now > slow_now
        crossed_down = fast_prev >= slow_prev and fast_now < slow_now

        if crossed_up and ctx.position <= 0:
            return Signal(Side.BUY, self.quantity, reason=f"SMA{self.fast}>SMA{self.slow}")
        if crossed_down and ctx.position > 0:
            return Signal(Side.SELL, self.quantity, reason=f"SMA{self.fast}<SMA{self.slow}")
        return None
