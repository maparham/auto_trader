"""Paper execution broker: simulated fills on live Capital.com quotes.

Implements the same `ExecutionBroker` interface as the real dealing executor, so
the API, engine, and frontend treat paper and live identically. No real money
and no upstream order calls are involved — fills are priced from the live
snapshot and positions are tracked in-process.

Position book is NETTED per epic (one position per epic, signed), which diverges
from Capital.com's default multi-position-per-epic hedging. This keeps
`Context.position` simple for the strategy seam; the divergence is intentional
and documented here.
"""

from __future__ import annotations

import asyncio
from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import TYPE_CHECKING

from auto_trader.brokers.base import ExecutionBroker, MarketDataBroker
from auto_trader.brokers.capital import pick_side

if TYPE_CHECKING:
    from auto_trader.brokers.registry import BrokerRegistry
from auto_trader.core.models import (
    Order,
    OrderResult,
    OrderStatus,
    OrderType,
    Position,
    Side,
    WorkingOrder,
)
from auto_trader.core.tick_store import TICK_STORE


@dataclass(frozen=True, slots=True)
class TriggerAction:
    """One thing the market reaching `price` should do to the book.

    kind="fill": working order `id` should fill into a position at `price`.
    kind="close": position `id` should close at `price`. `reason` is why
    (limit / stop / take_profit) — surfaced so the UI can explain the action."""

    kind: str  # "fill" | "close"
    id: str  # order_id (fill) or deal_id (close)
    price: float
    reason: str


def evaluate_triggers(
    price: float,
    positions: list[Position],
    working_orders: list[WorkingOrder],
) -> list[TriggerAction]:
    """PURE: given a mark price, decide which resting orders fill and which
    positions hit their stop/take-profit. No I/O, no mutation — all the
    correctness lives here so it can be unit-tested directly (mirrors
    `aggregate_ticks` / `_market_hours_state`). `price` is the mid.

    A BUY limit fills when the market trades at or below its level; a SELL limit
    at or above. A long stops out when price <= stop and takes profit when
    price >= take-profit (reversed for a short). Stop wins over take-profit if
    both are somehow crossed at once (risk first)."""
    actions: list[TriggerAction] = []
    for wo in working_orders:
        if wo.side is Side.BUY:
            crossed = price <= wo.limit_level
            # Fill at the limit, or better if the market gapped through it (or the
            # order was marketable — placed above the market). Never worse than the
            # limit the user set.
            fill = min(wo.limit_level, price)
        else:
            crossed = price >= wo.limit_level
            fill = max(wo.limit_level, price)
        if crossed:
            actions.append(TriggerAction("fill", wo.order_id, fill, "limit"))
    for p in positions:
        long = p.side is Side.BUY
        stop_hit = p.stop_level is not None and (
            price <= p.stop_level if long else price >= p.stop_level
        )
        tp_hit = p.take_profit_level is not None and (
            price >= p.take_profit_level if long else price <= p.take_profit_level
        )
        if stop_hit:
            actions.append(TriggerAction("close", p.deal_id, p.stop_level, "stop"))  # type: ignore[arg-type]
        elif tp_hit:
            actions.append(
                TriggerAction("close", p.deal_id, p.take_profit_level, "take_profit")  # type: ignore[arg-type]
            )
    return actions


def validate_levels(
    side: Side, ref_price: float, stop: float | None, take_profit: float | None
) -> str | None:
    """Reason string if SL/TP sit on the wrong side of `ref_price`, else None.
    For a BUY the stop must be below and the target above the reference price
    (reversed for a SELL). Mirrors what a real broker would reject."""
    long = side is Side.BUY
    if stop is not None and ((long and stop >= ref_price) or (not long and stop <= ref_price)):
        return "stop-loss is on the wrong side of the price"
    if take_profit is not None and (
        (long and take_profit <= ref_price) or (not long and take_profit >= ref_price)
    ):
        return "take-profit is on the wrong side of the price"
    return None


class PaperExecutionBroker(ExecutionBroker):
    """Simulated executor. Fills at the live bid/ask snapshot; books positions
    in memory; dedupes on `client_order_id`."""

    # Cap on retained idempotency results (LRU). Far above any realistic in-flight
    # retry window; bounds memory for a long-running / strategy-driven session.
    _RESULTS_MAX = 4096

    def __init__(
        self,
        market_broker: MarketDataBroker,
        slippage: float = 0.0,
        tick_store=TICK_STORE,
    ) -> None:
        self._market = market_broker
        self._slippage = slippage
        self._ticks = tick_store
        # Netted position book: epic -> Position (signed via side+quantity).
        self._book: dict[str, Position] = {}
        # Resting limit orders: order_id -> WorkingOrder. Filled by check_triggers.
        self._working: dict[str, WorkingOrder] = {}
        # Idempotency: client_order_id -> the result we already returned. Bounded
        # LRU — idempotency only matters within a retry window, so old entries are
        # evicted rather than retained for the process lifetime (memory cap).
        self._results: OrderedDict[str, OrderResult] = OrderedDict()
        self._next_deal = 1
        self._next_order = 1
        self._lock = asyncio.Lock()

    def _store_result(self, client_order_id: str, result: OrderResult) -> None:
        """Record an idempotency result, evicting the oldest past the LRU cap."""
        self._results[client_order_id] = result
        self._results.move_to_end(client_order_id)
        while len(self._results) > self._RESULTS_MAX:
            self._results.popitem(last=False)

    @property
    def env(self) -> str:
        return "paper"

    @property
    def is_real_money(self) -> bool:
        return False

    # --- pricing ----------------------------------------------------------

    async def _snapshot_quote(self, epic: str) -> tuple[float | None, float | None]:
        """(bid, ask) from the data broker's snapshot, or (None, None).

        Delegates to the broker's `get_quote` so paper pricing stays agnostic to
        which broker feeds it. The snapshot is a fallback only — for a streamed
        epic the tick store has a far fresher price (see `_fill_price`)."""
        return await self._market.get_quote(epic)

    async def _fill_price(self, epic: str, side: Side) -> float | None:
        """Fill at the side that crosses the spread, plus slippage against us.
        None if no price is available.

        Prefer the freshest live tick (sub-second, present whenever the epic is
        being streamed) over the REST snapshot, which can be up to ~30s stale due
        to the broker's market-detail cache. The tick store records mid prices, so
        a tick-based fill crosses from the mid by half the snapshot spread when we
        have one, else just applies slippage."""
        tick = self._ticks.latest(self._market.broker_id, epic)
        bid, ask = await self._snapshot_quote(epic)
        if tick is not None:
            mid = tick[1]
            half_spread = (ask - bid) / 2 if bid is not None and ask is not None else 0.0
            base = mid + half_spread if side is Side.BUY else mid - half_spread
        else:
            base = pick_side(bid, ask, "ask" if side is Side.BUY else "bid")
        if base is None:
            return None
        return base + (self._slippage if side is Side.BUY else -self._slippage)

    # --- ExecutionBroker --------------------------------------------------

    async def place_order(self, order: Order) -> OrderResult:
        async with self._lock:
            existing = self._results.get(order.client_order_id)
            if existing is not None:
                self._results.move_to_end(order.client_order_id)  # LRU: keep alive
                return existing  # idempotent: don't fill twice / re-rest

            submitted = datetime.now(timezone.utc)

            def reject(reason: str) -> OrderResult:
                r = OrderResult(
                    client_order_id=order.client_order_id,
                    status=OrderStatus.REJECTED,
                    reason=reason,
                    submitted_at=submitted,
                    resolved_at=datetime.now(timezone.utc),
                )
                self._store_result(order.client_order_id, r)
                return r

            if order.type is OrderType.LIMIT:
                if order.limit_level is None:
                    return reject("limit order requires a level")
                bad = validate_levels(
                    order.side, order.limit_level, order.stop_level, order.take_profit_level
                )
                if bad:
                    return reject(bad)
                order_id = self._mint_order()
                self._working[order_id] = WorkingOrder(
                    epic=order.epic,
                    side=order.side,
                    quantity=order.quantity,
                    limit_level=order.limit_level,
                    order_id=order_id,
                    stop_level=order.stop_level,
                    take_profit_level=order.take_profit_level,
                    created_at=submitted,
                )
                # A resting order is PENDING (not filled): check_triggers fills it
                # when the market reaches the level.
                result = OrderResult(
                    client_order_id=order.client_order_id,
                    status=OrderStatus.PENDING,
                    deal_id=order_id,
                    submitted_at=submitted,
                    resolved_at=datetime.now(timezone.utc),
                )
                self._store_result(order.client_order_id, result)
                return result

            # MARKET: fill now at the live price.
            price = await self._fill_price(order.epic, order.side)
            if price is None:
                return reject("no quote available for epic")
            bad = validate_levels(
                order.side, price, order.stop_level, order.take_profit_level
            )
            if bad:
                return reject(bad)
            deal_id = self._apply(order, price)
            result = OrderResult(
                client_order_id=order.client_order_id,
                status=OrderStatus.FILLED,
                deal_id=deal_id,
                filled_quantity=order.quantity,
                fill_price=price,
                submitted_at=submitted,
                resolved_at=datetime.now(timezone.utc),
            )
            self._store_result(order.client_order_id, result)
            return result

    def _apply(self, order: Order, price: float) -> str:
        """Apply a filled order to the netted book, returning the deal_id of the
        resulting (or affected) position."""
        delta = order.quantity if order.side is Side.BUY else -order.quantity
        pos = self._book.get(order.epic)
        prev = pos.signed_size if pos else 0.0
        new_signed = prev + delta

        if abs(new_signed) < 1e-12:
            # Flat: remove the position entirely.
            if pos is not None:
                del self._book[order.epic]
            return pos.deal_id if pos else self._mint()

        adding = prev != 0 and (prev > 0) == (delta > 0)
        if adding:
            # Same direction: keep the deal, blend the entry level. Preserve the
            # existing SL/TP — a plain market scale-in carries none, and dropping
            # them would silently leave the (now larger) position unprotected. A
            # scale-in that DOES carry its own levels overrides.
            open_level = (abs(prev) * pos.open_level + abs(delta) * price) / abs(
                new_signed
            )
            deal_id = pos.deal_id
            stop_level = order.stop_level if order.stop_level is not None else pos.stop_level
            take_profit_level = (
                order.take_profit_level
                if order.take_profit_level is not None
                else pos.take_profit_level
            )
        elif prev != 0 and (prev > 0) == (new_signed > 0):
            # Partial close, same direction remains: keep deal + original entry, and
            # keep the existing SL/TP (the synthesized closing order carries none).
            open_level = pos.open_level
            deal_id = pos.deal_id
            stop_level = pos.stop_level
            take_profit_level = pos.take_profit_level
        else:
            # Fresh open (prev == 0) or reversal through zero: new leg at `price`
            # with this order's own levels (`pos` may be None here).
            open_level = price
            deal_id = self._mint()
            stop_level = order.stop_level
            take_profit_level = order.take_profit_level

        self._book[order.epic] = Position(
            epic=order.epic,
            side=Side.BUY if new_signed > 0 else Side.SELL,
            quantity=abs(new_signed),
            open_level=open_level,
            deal_id=deal_id,
            stop_level=stop_level,
            take_profit_level=take_profit_level,
            created_at=datetime.now(timezone.utc),
        )
        return deal_id

    def _mint(self) -> str:
        deal_id = f"PAPER-{self._next_deal}"
        self._next_deal += 1
        return deal_id

    def _mint_order(self) -> str:
        order_id = f"WO-{self._next_order}"
        self._next_order += 1
        return order_id

    async def get_positions(self, epic: str | None = None) -> list[Position]:
        async with self._lock:
            book = [p for p in self._book.values() if epic is None or p.epic == epic]
        # Mark to market: uPnL = signed_size * (current_mid - entry). Priced off
        # the same live source as fills (tick first, snapshot fallback). Done
        # outside the lock — _current_mid awaits the network/snapshot. Fetch the
        # marks concurrently so a cold snapshot for one epic doesn't serialize the
        # rest (latency stays ~one round-trip, not N).
        mids = await asyncio.gather(*(self._current_mid(p.epic) for p in book))
        out: list[Position] = []
        for p, mid in zip(book, mids):
            upnl = p.signed_size * (mid - p.open_level) if mid is not None else None
            out.append(
                Position(
                    epic=p.epic,
                    side=p.side,
                    quantity=p.quantity,
                    open_level=p.open_level,
                    deal_id=p.deal_id,
                    stop_level=p.stop_level,
                    take_profit_level=p.take_profit_level,
                    upnl=upnl,
                    created_at=p.created_at,
                )
            )
        return out

    async def _current_mid(self, epic: str) -> float | None:
        """Current mid price for marking positions to market."""
        tick = self._ticks.latest(self._market.broker_id, epic)
        if tick is not None:
            return tick[1]
        bid, ask = await self._snapshot_quote(epic)
        return pick_side(bid, ask, "mid")

    async def quote(self, epic: str) -> dict[str, float | None]:
        """The bid/ask/mid a paper order would fill at right now.

        Sourced from the SAME pricing the order ticket's Buy/Sell buttons show, so
        the displayed price is the price you get: ask = the live mid widened by
        half the snapshot spread (what a BUY crosses), bid = the same for a SELL.
        Live because the mid comes from the tick stream; the spread comes from the
        (coarser) snapshot. mid/bid/ask are None when no price is available."""
        bid, ask = await self._snapshot_quote(epic)
        tick = self._ticks.latest(self._market.broker_id, epic)
        if tick is None:
            # No live tick: price off the snapshot bid/ask, but widen by slippage
            # the SAME way `_fill_price` does (BUY fills at ask+slippage, SELL at
            # bid-slippage) so the quoted price matches the fill.
            return {
                "bid": bid - self._slippage if bid is not None else None,
                "ask": ask + self._slippage if ask is not None else None,
                "mid": pick_side(bid, ask, "mid"),
            }
        mid = tick[1]
        half = (ask - bid) / 2 if bid is not None and ask is not None else 0.0
        return {
            "bid": mid - half - self._slippage,
            "ask": mid + half + self._slippage,
            "mid": mid,
        }

    async def close_position(
        self, deal_id: str, quantity: float | None = None
    ) -> OrderResult:
        async with self._lock:
            pos = next((p for p in self._book.values() if p.deal_id == deal_id), None)
            if pos is None:
                return OrderResult(
                    client_order_id="",
                    status=OrderStatus.REJECTED,
                    reason="no such position",
                )
            # Closing means trading the opposite side at the live price.
            close_side = Side.SELL if pos.side is Side.BUY else Side.BUY
            price = await self._fill_price(pos.epic, close_side)
            if price is None:
                return OrderResult(
                    client_order_id="",
                    status=OrderStatus.REJECTED,
                    reason="no quote available for epic",
                )
            close_qty = self._close_at(deal_id, price, quantity)
            return OrderResult(
                client_order_id=self._mint(),
                status=OrderStatus.FILLED,
                deal_id=deal_id,
                filled_quantity=close_qty or 0.0,
                fill_price=price,
                resolved_at=datetime.now(timezone.utc),
            )

    def _close_at(
        self, deal_id: str, price: float, quantity: float | None = None
    ) -> float | None:
        """Close (or reduce) a position at `price` by applying an opposing fill.
        Lock-held + synchronous so the trigger driver can reuse it. Returns the
        quantity closed, or None if the deal is unknown."""
        pos = next((p for p in self._book.values() if p.deal_id == deal_id), None)
        if pos is None:
            return None
        close_qty = pos.quantity if quantity is None else min(quantity, pos.quantity)
        close_side = Side.SELL if pos.side is Side.BUY else Side.BUY
        self._apply(
            Order(
                epic=pos.epic,
                side=close_side,
                quantity=close_qty,
                client_order_id=self._mint(),
            ),
            price,
        )
        return close_qty

    async def modify_position(
        self,
        deal_id: str,
        *,
        stop_level: float | None = None,
        take_profit_level: float | None = None,
        clear_stop: bool = False,
        clear_take_profit: bool = False,
    ) -> OrderResult:
        async with self._lock:
            pos = next((p for p in self._book.values() if p.deal_id == deal_id), None)
            if pos is None:
                return OrderResult(
                    client_order_id="",
                    status=OrderStatus.REJECTED,
                    reason="no such position",
                )
            # None = keep (partial drag update); clear_* = remove the level.
            new_stop = (
                None
                if clear_stop
                else (stop_level if stop_level is not None else pos.stop_level)
            )
            new_tp = (
                None
                if clear_take_profit
                else (
                    take_profit_level
                    if take_profit_level is not None
                    else pos.take_profit_level
                )
            )
            # Validate SL/TP against the CURRENT market, not the entry: a real
            # broker rejects relative to the live price, and a winning position
            # must be able to trail its stop past entry into profit. Fall back to
            # the entry level when no price is available.
            ref_price = await self._current_mid(pos.epic)
            if ref_price is None:
                ref_price = pos.open_level
            # Validate ONLY the levels this edit actually CHANGES. The apply/drag
            # paths send the full resolved SL+TP (they don't use the None-means-
            # unchanged convention), so a stop-only edit still carries the existing
            # TP. Re-checking a kept TP against the drifted market would reject the
            # stop edit for a TP the user never touched — e.g. on a non-streamed
            # epic whose triggers never fired and the market has since crossed the
            # TP. A kept level was valid when set and simply triggers on the next
            # tick; clearing a level needs no validation either. (This differs from
            # modify_working_order, which validates against the order's own limit —
            # a user-editable reference — so it must re-check kept levels.)
            bad = validate_levels(
                pos.side,
                ref_price,
                new_stop if new_stop != pos.stop_level else None,
                new_tp if new_tp != pos.take_profit_level else None,
            )
            if bad:
                return OrderResult(
                    client_order_id="", status=OrderStatus.REJECTED, reason=bad
                )
            self._book[pos.epic] = Position(
                epic=pos.epic,
                side=pos.side,
                quantity=pos.quantity,
                open_level=pos.open_level,
                deal_id=pos.deal_id,
                stop_level=new_stop,
                take_profit_level=new_tp,
                created_at=pos.created_at,
            )
            return OrderResult(
                client_order_id="",
                status=OrderStatus.FILLED,
                deal_id=deal_id,
                resolved_at=datetime.now(timezone.utc),
            )

    # --- working orders ---------------------------------------------------

    async def get_working_orders(self, epic: str | None = None) -> list[WorkingOrder]:
        async with self._lock:
            return [
                w for w in self._working.values() if epic is None or w.epic == epic
            ]

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
        async with self._lock:
            wo = self._working.get(order_id)
            if wo is None:
                return OrderResult(
                    client_order_id="", status=OrderStatus.REJECTED, reason="no such order"
                )
            new_level = limit_level if limit_level is not None else wo.limit_level
            # None = keep (partial drag update); clear_* = remove the level.
            new_stop = (
                None
                if clear_stop
                else (stop_level if stop_level is not None else wo.stop_level)
            )
            new_tp = (
                None
                if clear_take_profit
                else (
                    take_profit_level
                    if take_profit_level is not None
                    else wo.take_profit_level
                )
            )
            bad = validate_levels(wo.side, new_level, new_stop, new_tp)
            if bad:
                return OrderResult(
                    client_order_id="", status=OrderStatus.REJECTED, reason=bad
                )
            self._working[order_id] = WorkingOrder(
                epic=wo.epic,
                side=wo.side,
                quantity=wo.quantity,
                limit_level=new_level,
                order_id=order_id,
                stop_level=new_stop,
                take_profit_level=new_tp,
                created_at=wo.created_at,
            )
            return OrderResult(
                client_order_id="", status=OrderStatus.PENDING, deal_id=order_id
            )

    async def cancel_working_order(self, order_id: str) -> OrderResult:
        async with self._lock:
            if self._working.pop(order_id, None) is None:
                return OrderResult(
                    client_order_id="", status=OrderStatus.REJECTED, reason="no such order"
                )
            # FILLED here means "action completed", not a fill — there's no
            # CANCELLED status and the route only needs success vs not-found.
            return OrderResult(
                client_order_id="", status=OrderStatus.FILLED, deal_id=order_id
            )

    # --- trigger driver (paper-only; real brokers trigger server-side) -----

    async def check_triggers(self) -> bool:
        """Fill resting limits and close positions whose SL/TP the market reached.

        Thin driver around the pure `evaluate_triggers`: reads the latest tick
        (synchronously) per epic and applies the resulting fills/closes under the
        book lock. Only epics with a live tick are evaluated — a limit/SL/TP on an
        epic that isn't being streamed won't trigger (documented paper limit).

        Returns True if the book changed (a fill/close happened), so the caller can
        push a 'trades changed' notification instead of the frontend polling."""
        changed = False
        async with self._lock:
            epics = {p.epic for p in self._book.values()}
            epics |= {w.epic for w in self._working.values()}
            for epic in epics:
                tick = self._ticks.latest(self._market.broker_id, epic)
                if tick is None:
                    continue
                price = tick[1]
                # Re-snapshot and re-evaluate until the book stops changing on this
                # tick: a working-order fill can create a position whose SL/TP this
                # same price already crosses, and it must close now rather than sit
                # unprotected until the next cycle. Bounded — each non-empty pass
                # removes at least one working order or position, so it converges.
                for _ in range(len(self._working) + len(self._book) + 1):
                    positions = [p for p in self._book.values() if p.epic == epic]
                    working = [w for w in self._working.values() if w.epic == epic]
                    actions = evaluate_triggers(price, positions, working)
                    if not actions:
                        break
                    changed = True
                    for action in actions:
                        if action.kind == "fill":
                            wo = self._working.pop(action.id, None)
                            if wo is None:
                                continue
                            self._apply(
                                Order(
                                    epic=wo.epic,
                                    side=wo.side,
                                    quantity=wo.quantity,
                                    client_order_id=f"fill-{wo.order_id}",
                                    stop_level=wo.stop_level,
                                    take_profit_level=wo.take_profit_level,
                                ),
                                action.price,
                            )
                        elif action.kind == "close":
                            self._close_at(action.id, action.price)
        return changed


def register(
    registry: "BrokerRegistry", market: MarketDataBroker, broker_id: str = "capital"
) -> "PaperExecutionBroker":
    """Register a paper executor priced off `market`, under "{broker_id}:paper"."""
    paper = PaperExecutionBroker(market)
    registry.add_exec(f"{broker_id}:paper", paper)
    return paper
