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
    """Read-only market data: candles, quotes, the instrument catalogue and the
    favourites watchlist. Implemented per broker (capital.com first).

    Only the three pricing primitives — `get_candles`, `get_recent_candles`,
    `get_quote` — are abstract: that's the floor a broker must clear for the chart
    and paper trading to work at all. The catalogue / meta / favourites surface
    (which the symbol-search modal uses) ships with graceful defaults — empty
    catalogue, no favourites — so a minimal or watchlist-less broker can register
    without stubbing six methods. A full-featured broker (Capital) overrides them.

    `price_side` is one of "bid" | "mid" | "ask". Catalogue/meta/favourite calls
    return loosely-typed dicts in the shapes the routes pass through (see
    `CapitalComBroker` for the canonical shapes).
    """

    # Whether this broker has a live tick/candle stream wired (the /ws/candles
    # route + the paper trigger driver depend on it). Capital does; IG does not yet
    # (its Lightstreamer feed is a deferred follow-up), so IG charts load REST
    # history but don't tick live. A broker flips this to True when it gains a
    # `capital_stream`-style generator.
    supports_streaming: bool = False

    # Set once by BrokerRegistry.add_data to the id the broker is registered under
    # ("capital", "capital-live", ...). Lets streams/paper key the shared tick
    # store by feed instead of epic alone, so a shared epic (e.g. GOLD) doesn't mix
    # demo and live ticks.
    broker_id: str | None = None

    # Broker-reported display name for the selector ("Ava Trade Ltd (demo)").
    # Optional: most brokers leave it None and the frontend falls back to its
    # static per-id label map. A broker that learns its real name at runtime
    # (MT5 via MetaApi account information) fills it in whenever it can.
    display_name: str | None = None

    @abstractmethod
    async def get_candles(
        self,
        epic: str,
        resolution: Resolution,
        start: datetime,
        end: datetime,
        price_side: str = "mid",
    ) -> list[Candle]:
        """Return candles in [start, end], ascending by time. UTC throughout."""
        raise NotImplementedError

    @abstractmethod
    async def get_recent_candles(
        self,
        epic: str,
        resolution: Resolution,
        count: int,
        price_side: str = "mid",
    ) -> list[Candle]:
        """Most recent `count` candles regardless of date (robust on closed markets)."""
        raise NotImplementedError

    @abstractmethod
    async def get_quote(self, epic: str) -> tuple[float | None, float | None]:
        """Latest (bid, ask) snapshot for `epic`, or (None, None) if unavailable.

        The paper executor prices simulated fills off this, so every data broker
        must provide it — that's what keeps paper trading broker-agnostic rather
        than welded to one broker's internals.
        """
        raise NotImplementedError

    # --- catalogue / favourites: optional, default to empty -----------------
    # Override per broker that has a searchable catalogue + watchlist. The
    # defaults let a data-only broker register and chart without a catalogue.

    async def search_markets(self, query: str, limit: int = 20) -> list[dict]:
        """Keyword instrument search → [{epic, name, status, type}], tradeable first."""
        return []

    async def all_markets(self) -> list[dict]:
        """The full instrument catalogue (the symbol-search modal filters it client-side)."""
        return []

    async def get_market_meta(self, epic: str) -> dict | None:
        """Display precision + open/closed status for one epic, or None if unknown."""
        return None

    async def get_market_detail(self, epic: str) -> dict | None:
        """Full instrument detail for the details modal, or None if unknown."""
        return None

    async def favorites(self) -> list[dict]:
        """The account's favourites watchlist (the modal's opening view)."""
        return []

    async def add_favorite(self, epic: str) -> None:
        """Add `epic` to the favourites watchlist. No-op if unsupported."""
        return None

    async def remove_favorite(self, epic: str) -> None:
        """Remove `epic` from the favourites watchlist. No-op if unsupported."""
        return None


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
