"""Broker abstraction.

Milestone 1 only needs market data (historical candles) for backtesting.
Order execution is simulated by the engine, so it is intentionally NOT part of
this interface yet. We add an `ExecutionBroker` seam later for paper/live.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import datetime

from auto_trader.core.models import Candle, Resolution


class MarketDataBroker(ABC):
    """Read-only market data. Implemented per broker (capital.com first)."""

    @abstractmethod
    async def get_candles(
        self,
        epic: str,
        resolution: Resolution,
        start: datetime,
        end: datetime,
    ) -> list[Candle]:
        """Return candles in [start, end], ascending by time. UTC throughout."""
        raise NotImplementedError
