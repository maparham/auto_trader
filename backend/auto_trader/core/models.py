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
