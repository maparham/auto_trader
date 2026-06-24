"""Strategy interface.

The same Strategy subclass runs unchanged in backtest, paper, and live: the
engine feeds it one bar at a time and the strategy may only see history up to
and including that bar (no lookahead). It returns an optional Signal; the engine
decides how/when that signal is filled.
"""

from __future__ import annotations

from abc import ABC, abstractmethod

from auto_trader.core.models import Candle, Signal


class Context:
    """Read-only view the engine passes to the strategy at each bar.

    `position` is the current signed quantity held (positive = long,
    negative = short, 0 = flat). `history` holds all bars seen so far,
    inclusive of the current bar, oldest first.
    """

    def __init__(self) -> None:
        self.history: list[Candle] = []
        self.position: float = 0.0

    @property
    def bar(self) -> Candle:
        return self.history[-1]


class Strategy(ABC):
    """Override on_bar. Keep it pure: read ctx, return a Signal or None."""

    @abstractmethod
    def on_bar(self, ctx: Context) -> Signal | None:
        ...
