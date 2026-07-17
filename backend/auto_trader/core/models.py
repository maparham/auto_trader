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
class RuleTerm:
    """One passing rule's exact comparison at the signal bar, kept so the chart
    can show *why* a trade fired without recomputing. `*_val` is the authoritative
    value the engine compared (None when the operand had no value there); `*_tf` is
    the operand's effective timeframe (base ⇒ the run's TF, else the higher TF) as a
    Resolution string, or None for a timeframe-less operand (price/const/entry). The
    frontend prettifies `*_tf` for display (e.g. MINUTE_15 → @15m).

    Lives here rather than in strategy/rule.py so Signal/Fill can reference it
    without a circular import (rule.py imports from this module)."""

    left_label: str
    left_val: float | None
    op: str
    right_label: str
    right_val: float | None
    left_tf: str | None = None
    right_tf: str | None = None


@dataclass(frozen=True, slots=True)
class InspectorTerm:
    """One rule's comparison at an arbitrary bar, captured for the bar inspector.

    Unlike RuleTerm (passing rules on fill bars only), this is recorded for EVERY
    rule at the inspected bar, so `passed` carries the raw comparison result — the
    inspector shows failing terms too. Labels/tf follow RuleTerm conventions."""

    left_label: str
    left_val: float | None
    op: str
    right_label: str
    right_val: float | None
    left_tf: str | None
    right_tf: str | None
    passed: bool


@dataclass(frozen=True, slots=True)
class BarGroupTrace:
    """One rule group (longEntry/shortEntry/longExit/shortExit) evaluated at a bar:
    every term with pass/fail, plus the group's AND/OR rollup."""

    group: str            # "longEntry" | "shortEntry" | "longExit" | "shortExit"
    combine: str          # "AND" | "OR"
    terms: tuple[InspectorTerm, ...]
    passed: bool


@dataclass(frozen=True, slots=True)
class BarTrace:
    """The full inspector snapshot for one bar: the four rule groups plus the
    engine's outcome for the signal that bar produced. `action` is "opened" when a
    fill resulted, "suppressed" when a passing entry was blocked (see `reason`), or
    "none" when no entry signal fired. Gate booleans expose why a suppression
    happened. `time` is unix seconds (the bar's open time)."""

    bar_index: int
    time: int
    groups: tuple[BarGroupTrace, ...]
    action: str           # "opened" | "suppressed" | "none"
    reason: str | None
    in_position_long: bool
    in_position_short: bool
    window_active: bool
    warmed_up: bool
    spacing_ok: bool | None


@dataclass(frozen=True, slots=True)
class Signal:
    """A strategy's intent at a given bar. quantity in instrument units.

    `leg` picks which position bucket the side acts on (hedging): leg="long"
    + BUY opens/adds long, leg="long" + SELL closes long; leg="short" + SELL
    opens/adds short, leg="short" + BUY closes short.

    `terms` are the passing rules' captured comparison values (empty for a signal
    with no rule provenance) — the engine threads them onto the resulting Fill.
    `combine` is the firing group's "AND"/"OR" (how to read the passing-only terms).
    """

    side: Side
    quantity: float
    reason: str = ""
    leg: str = "long"
    terms: tuple[RuleTerm, ...] = ()
    combine: str = "AND"
    # Per-signal bracket levels (coded strategies): absolute stop/target prices
    # attached to an OPENING signal. When set, the engine seeds the new position's
    # bracket from them instead of the side-level RiskConfig. None = not set.
    stop_level: float | None = None
    target_level: float | None = None
    # True when `quantity` is an author-specified size from a coded strategy's
    # ctx.buy(qty=...)/ctx.sell(qty=...) (explicit sizing), as opposed to the
    # run's default quantity. Live forwards explicit sizing to the order; a
    # default-sized signal instead uses the panel's configured quantity.
    quantity_explicit: bool = False


@dataclass(slots=True)
class BarStats:
    """Per-trade bar-count dynamics, accumulated one held bar at a time by
    `update`. Classification is by the bar close vs the entry price; favorable
    means up for a long and down for a short. The leading-underscore fields are
    running state, not exported onto the Trade."""

    bars_held: int = 0
    bars_in_profit: int = 0
    bars_in_loss: int = 0
    body_through: int = 0
    wick_from_profit: int = 0
    wick_from_loss: int = 0
    longest_profit_streak: int = 0
    longest_loss_streak: int = 0
    bars_to_mfe: int = 0
    bars_to_mae: int = 0
    entry_crossings: int = 0
    _cur_profit: int = 0
    _cur_loss: int = 0
    _prev_zone: int = 0  # last non-flat zone: +1 profit, -1 loss, 0 unset
    _fav: float = 0.0    # favorable extreme so far (seeded to entry)
    _adv: float = 0.0    # adverse extreme so far (seeded to entry)
    _seeded: bool = False

    def update(self, entry: float, leg: str, bar: "Candle") -> None:
        if not self._seeded:
            self._fav = entry
            self._adv = entry
            self._seeded = True
        self.bars_held += 1
        long = leg == "long"
        o, hi, lo, c = bar.open, bar.high, bar.low, bar.close
        profit = c > entry if long else c < entry
        loss = c < entry if long else c > entry

        if profit:
            self.bars_in_profit += 1
            self._cur_profit += 1
            self._cur_loss = 0
            if self._cur_profit > self.longest_profit_streak:
                self.longest_profit_streak = self._cur_profit
        elif loss:
            self.bars_in_loss += 1
            self._cur_loss += 1
            self._cur_profit = 0
            if self._cur_loss > self.longest_loss_streak:
                self.longest_loss_streak = self._cur_loss
        else:  # flat: neither zone, resets both streaks
            self._cur_profit = 0
            self._cur_loss = 0

        if min(o, c) < entry < max(o, c):
            self.body_through += 1

        if long:
            if profit and lo <= entry and not (min(o, c) < entry < max(o, c)):
                self.wick_from_profit += 1
            if loss and hi >= entry and not (min(o, c) < entry < max(o, c)):
                self.wick_from_loss += 1
            if hi > self._fav:
                self._fav = hi
                self.bars_to_mfe = self.bars_held
            if lo < self._adv:
                self._adv = lo
                self.bars_to_mae = self.bars_held
        else:
            if profit and hi >= entry and not (min(o, c) < entry < max(o, c)):
                self.wick_from_profit += 1
            if loss and lo <= entry and not (min(o, c) < entry < max(o, c)):
                self.wick_from_loss += 1
            if lo < self._fav:
                self._fav = lo
                self.bars_to_mfe = self.bars_held
            if hi > self._adv:
                self._adv = hi
                self.bars_to_mae = self.bars_held

        zone = 1 if profit else (-1 if loss else 0)
        if zone != 0:
            if self._prev_zone != 0 and zone != self._prev_zone:
                self.entry_crossings += 1
            self._prev_zone = zone


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
    # Overnight financing allocated to this trade (positive = cost already
    # subtracted from pnl-adjacent equity; see engine financing accrual). The
    # trade's share of its position's accrued financing, apportioned by the
    # closed quantity.
    financing: float = 0.0
    leg: str = "long"
    reason_in: str = ""
    reason_out: str = ""
    # Canonical sub-bar exit time for an intra-bar stop/target (see
    # engine.exit_time), resolved from 1-minute candles post-run. None when the
    # exit was not intra-bar or no finer data was available; consumers fall back
    # to exit_time. Display only: never affects pnl or exit_price.
    exit_time_exact: datetime | None = None
    stop_initial: float | None = None
    stop_final: float | None = None
    target: float | None = None
    # Excursion while the trade was open: worst adverse / best favorable price
    # move from entry (raw distance, always >= 0), plus the same as R-multiples
    # of the initial stop distance (None when the trade had no initial stop).
    mae: float = 0.0
    mfe: float = 0.0
    mae_r: float | None = None
    mfe_r: float | None = None
    # Per-trade bar-count dynamics (see engine BarStats): counts over the held
    # bars (entry through exit). All default 0 for trades built without them.
    bars_held: int = 0
    bars_in_profit: int = 0
    bars_in_loss: int = 0
    body_through: int = 0
    wick_from_profit: int = 0
    wick_from_loss: int = 0
    longest_profit_streak: int = 0
    longest_loss_streak: int = 0
    bars_to_mfe: int = 0
    bars_to_mae: int = 0
    entry_crossings: int = 0
    # Entry-context features at the SIGNAL bar (trend/vol regime/session/...),
    # attached post-run by engine.context_features; None until enriched.
    context: dict | None = None
    # Per-trade counterfactual results (see engine.whatif): exit-rule replay,
    # target replay, fill-delay cost, limit-entry replay. None until enriched.
    whatif: dict | None = None


@dataclass(slots=True)
class Fill:
    """A single executed order. Markers on the chart come from these.

    `signal_time` is the bar the firing signal was generated on (one bar before
    this fill, on the run's base timeframe) — None for a mechanical fill with no
    rule signal (stop/target/trail/session/range-end). `terms` are that signal's
    passing-rule comparison values, empty for a mechanical fill; `combine` is the
    firing group's AND/OR, None for a mechanical fill."""

    time: datetime
    side: Side
    price: float
    quantity: float
    reason: str = ""
    leg: str = "long"
    signal_time: datetime | None = None
    terms: tuple[RuleTerm, ...] = ()
    combine: str | None = None


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
    # Good-till-date expiry for a resting LIMIT order (UTC). None = Good-Till-
    # Cancelled (rests until filled or cancelled). Ignored for MARKET.
    expires_at: datetime | None = None
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
    # Good-till-date expiry (UTC). None = Good-Till-Cancelled. The paper executor
    # cancels the order once now >= expires_at; real brokers enforce server-side.
    expires_at: datetime | None = None
