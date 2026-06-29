"""Domain models shared across brokers, engine, strategies, and the API.

Conventions:
- All timestamps are timezone-aware UTC. Convert to local time only at display.
- `time` on a Candle is the bar's OPEN time (the start of the interval).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import Enum


class Side(str, Enum):
    BUY = "buy"
    SELL = "sell"


class Resolution(str, Enum):
    """Supported candle intervals. Values match Capital.com's `resolution` enum."""

    MINUTE = "MINUTE"
    MINUTE_5 = "MINUTE_5"
    MINUTE_15 = "MINUTE_15"
    MINUTE_30 = "MINUTE_30"
    HOUR = "HOUR"
    HOUR_4 = "HOUR_4"
    DAY = "DAY"
    WEEK = "WEEK"

    @property
    def seconds(self) -> int:
        return {
            "MINUTE": 60,
            "MINUTE_5": 300,
            "MINUTE_15": 900,
            "MINUTE_30": 1800,
            "HOUR": 3600,
            "HOUR_4": 14400,
            "DAY": 86400,
            "WEEK": 604800,
        }[self.value]


@dataclass(frozen=True, slots=True)
class Candle:
    """A single OHLCV bar. `time` is the bar open time (UTC)."""

    time: datetime
    open: float
    high: float
    low: float
    close: float
    volume: float = 0.0


@dataclass(frozen=True, slots=True)
class Signal:
    """A strategy's intent at a given bar. quantity in instrument units."""

    side: Side
    quantity: float
    reason: str = ""


@dataclass(slots=True)
class Trade:
    """A completed round-trip (entry -> exit), produced by the engine."""

    side: Side
    quantity: float
    entry_time: datetime
    entry_price: float
    exit_time: datetime
    exit_price: float
    pnl: float
    reason_in: str = ""
    reason_out: str = ""


@dataclass(slots=True)
class Fill:
    """A single executed order. Markers on the chart come from these."""

    time: datetime
    side: Side
    price: float
    quantity: float
    reason: str = ""


# --- order execution (paper / live) -----------------------------------------
#
# These model the ExecutionBroker seam (see brokers/base.py). The same Order /
# OrderResult / Position types flow through the paper executor and the real
# Capital.com dealing executor, so the API and frontend speak one shape.


class OrderType(str, Enum):
    MARKET = "market"  # fills now at the live price
    LIMIT = "limit"  # rests until price reaches `limit_level`, then fills


class OrderSource(str, Enum):
    """Who originated the order. STRATEGY orders are blocked on real money."""

    MANUAL = "manual"
    STRATEGY = "strategy"


class OrderStatus(str, Enum):
    """Lifecycle of a submitted order.

    UNKNOWN is distinct from REJECTED: it means the submission itself raised
    (timeout / dropped connection) so we DON'T know whether it filled. The caller
    must reconcile via the broker (confirms / positions) and must never blindly
    re-submit, or it risks a double fill.
    """

    PENDING = "pending"
    FILLED = "filled"
    PARTIALLY_FILLED = "partially_filled"
    REJECTED = "rejected"
    UNKNOWN = "unknown"


@dataclass(frozen=True, slots=True)
class Order:
    """An intent to trade. `client_order_id` is caller-generated and is the
    idempotency key — a retried submit with the same id must not double-fill."""

    epic: str
    side: Side
    quantity: float
    client_order_id: str
    type: OrderType = OrderType.MARKET
    # Resting price for a LIMIT order (ignored for MARKET).
    limit_level: float | None = None
    stop_level: float | None = None
    take_profit_level: float | None = None
    source: OrderSource = OrderSource.MANUAL
    reason: str = ""


@dataclass(slots=True)
class OrderResult:
    """The outcome of submitting an Order."""

    client_order_id: str
    status: OrderStatus
    deal_reference: str | None = None
    deal_id: str | None = None
    filled_quantity: float = 0.0
    fill_price: float | None = None
    reason: str = ""
    submitted_at: datetime | None = None
    resolved_at: datetime | None = None


@dataclass(frozen=True, slots=True)
class Position:
    """One open position. Capital.com is multi-position-per-epic (hedging), so a
    position is keyed by `deal_id`; net exposure for an epic is the sum of
    `signed_size` across its positions (see `net_position`)."""

    epic: str
    side: Side
    quantity: float  # unsigned size of this deal
    open_level: float
    deal_id: str
    stop_level: float | None = None
    take_profit_level: float | None = None
    upnl: float | None = None
    created_at: datetime | None = None
    # Broker-reported margin facts (None when the broker doesn't supply them, e.g.
    # the paper sim). `leverage` is the broker's real per-position leverage (Capital
    # applies different ratios per instrument — 5:1 on US shares, 10:1 elsewhere);
    # `margin` is the deposit requirement in the ACCOUNT currency (current notional /
    # leverage, FX-converted), so the dock shows the broker's figure, not a guess.
    leverage: float | None = None
    margin: float | None = None

    @property
    def signed_size(self) -> float:
        return self.quantity if self.side is Side.BUY else -self.quantity


def net_position(positions: list[Position], epic: str) -> float:
    """Net signed exposure for `epic` across all its (possibly hedged) deals."""
    return sum(p.signed_size for p in positions if p.epic == epic)


@dataclass(frozen=True, slots=True)
class WorkingOrder:
    """A resting limit order: waits until the market reaches `limit_level`, then
    fills into a Position (carrying its SL/TP). Keyed by `order_id`."""

    epic: str
    side: Side
    quantity: float
    limit_level: float
    order_id: str
    stop_level: float | None = None
    take_profit_level: float | None = None
    created_at: datetime | None = None
