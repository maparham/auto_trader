"""Broker abstractions.

`MarketDataBroker` is read-only market data (historical candles for backtesting).
`ExecutionBroker` is the order-execution seam: the same interface is implemented
by the paper executor (simulated fills) and the real Capital.com dealing
executor, so the engine/API/frontend swap data source + executor without
touching the strategy interface.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import datetime

from auto_trader.core.models import (
    Candle,
    Order,
    OrderResult,
    Position,
    Resolution,
    WorkingOrder,
)


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


class ExecutionBroker(ABC):
    """Order execution. Paper (simulated) and live (Capital.com) implement this.

    `place_order` must be idempotent on `Order.client_order_id`: a retried submit
    with the same id returns the recorded result rather than placing a second
    order. Implementations that talk to a real broker should map business
    rejections (margin, market closed, min size) to an OrderResult with
    status=REJECTED rather than raising.
    """

    @property
    @abstractmethod
    def env(self) -> str:
        """Environment label: "paper" | "demo" | "live"."""
        raise NotImplementedError

    @property
    @abstractmethod
    def is_real_money(self) -> bool:
        """True only when orders move real money (the live environment)."""
        raise NotImplementedError

    @abstractmethod
    async def place_order(self, order: Order) -> OrderResult:
        raise NotImplementedError

    @abstractmethod
    async def get_positions(self, epic: str | None = None) -> list[Position]:
        """Open positions, optionally filtered to one epic."""
        raise NotImplementedError

    @abstractmethod
    async def close_position(
        self, deal_id: str, quantity: float | None = None
    ) -> OrderResult:
        """Close a position fully (quantity=None) or partially."""
        raise NotImplementedError

    @abstractmethod
    async def modify_position(
        self,
        deal_id: str,
        *,
        stop_level: float | None = None,
        take_profit_level: float | None = None,
        clear_stop: bool = False,
        clear_take_profit: bool = False,
    ) -> OrderResult:
        """Update the stop-loss / take-profit of an open position. A None level
        leaves it unchanged; clear_stop / clear_take_profit remove it."""
        raise NotImplementedError

    @abstractmethod
    async def get_working_orders(self, epic: str | None = None) -> list[WorkingOrder]:
        """Resting (unfilled) limit orders, optionally filtered to one epic."""
        raise NotImplementedError

    @abstractmethod
    async def modify_working_order(
        self,
        order_id: str,
        *,
        limit_level: float | None = None,
        stop_level: float | None = None,
        take_profit_level: float | None = None,
        clear_stop: bool = False,
        clear_take_profit: bool = False,
    ) -> OrderResult:
        """Change a resting order's price and/or its attached SL/TP. A None level
        leaves it unchanged; clear_stop / clear_take_profit remove it."""
        raise NotImplementedError

    @abstractmethod
    async def cancel_working_order(self, order_id: str) -> OrderResult:
        """Cancel a resting order."""
        raise NotImplementedError
