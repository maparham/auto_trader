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

    `position_long` / `position_short` are the current sizes held in each
    bucket (>= 0; a strategy can hold both at once — hedging). `history`
    holds all bars seen so far, inclusive of the current bar, oldest first.
    """

    def __init__(self) -> None:
        self.history: list[Candle] = []
        self.position_long: float = 0.0
        self.position_short: float = 0.0

    @property
    def bar(self) -> Candle:
        return self.history[-1]


class Strategy(ABC):
    """Override on_bar. Keep it pure: read ctx, return a list of Signals
    (0, 1, or 2 — e.g. a long exit and a short entry can fire on one bar)."""

    @abstractmethod
    def on_bar(self, ctx: Context) -> list[Signal]:
        ...
