"""PaperExecutionBroker: simulated fills, netted book, idempotency.

The market broker's quote source (`_fetch_market_raw`) is stubbed so no session
or network is involved. Matches the project's test style (asyncio.run, no plugin).
"""

from __future__ import annotations

import asyncio

from auto_trader.brokers.capital import CapitalComBroker
from auto_trader.brokers.paper_exec import PaperExecutionBroker
from auto_trader.core.models import (
    Order,
    OrderStatus,
    OrderType,
    Side,
    net_position,
)


class _FakeTicks:
    """Stub tick store. `tick` is the latest mid, or None to force the snapshot."""

    def __init__(self, tick: float | None = None) -> None:
        self.tick = tick

    def latest(self, epic: str):
        return (1, self.tick) if self.tick is not None else None


def _broker(
    bid: float | None = 100.0,
    ask: float | None = 100.2,
    tick: float | None = None,
) -> PaperExecutionBroker:
    market = CapitalComBroker.__new__(CapitalComBroker)  # bypass __init__

    async def fake_raw(epic: str):
        return {"snapshot": {"bid": bid, "offer": ask}}

    market._fetch_market_raw = fake_raw  # type: ignore[method-assign]
    return PaperExecutionBroker(market, tick_store=_FakeTicks(tick))


def _order(side: Side, qty: float, coid: str, epic: str = "EURUSD") -> Order:
    return Order(epic=epic, side=side, quantity=qty, client_order_id=coid)


def test_buy_fills_at_ask_and_books_position() -> None:
    broker = _broker(bid=100.0, ask=100.2)
    result = asyncio.run(broker.place_order(_order(Side.BUY, 2, "c1")))

    assert result.status is OrderStatus.FILLED
    assert result.fill_price == 100.2  # BUY crosses at the ask
    assert result.filled_quantity == 2

    positions = asyncio.run(broker.get_positions("EURUSD"))
    assert len(positions) == 1
    assert positions[0].side is Side.BUY
    assert positions[0].quantity == 2
    assert positions[0].open_level == 100.2


def test_sell_fills_at_bid() -> None:
    broker = _broker(bid=100.0, ask=100.2)
    result = asyncio.run(broker.place_order(_order(Side.SELL, 1, "c1")))
    assert result.fill_price == 100.0  # SELL crosses at the bid


def test_dedupe_same_client_order_id_fills_once() -> None:
    broker = _broker()
    r1 = asyncio.run(broker.place_order(_order(Side.BUY, 1, "dup")))
    r2 = asyncio.run(broker.place_order(_order(Side.BUY, 1, "dup")))

    assert r1 is r2 or r1.fill_price == r2.fill_price
    # Only ONE fill happened: the netted book holds qty 1, not 2.
    positions = asyncio.run(broker.get_positions())
    assert net_position(positions, "EURUSD") == 1.0


def test_idempotency_cache_is_bounded_lru() -> None:
    # The idempotency map must not grow without bound: once past the cap, the
    # oldest entries are evicted (their order ids would re-fill, acceptable —
    # idempotency only protects an in-flight retry window).
    broker = _broker()
    broker._RESULTS_MAX = 3  # shrink the cap for the test
    for i in range(5):
        asyncio.run(broker.place_order(_order(Side.SELL, 1, f"o{i}")))
    assert len(broker._results) == 3
    assert "o0" not in broker._results and "o1" not in broker._results
    assert {"o2", "o3", "o4"} <= set(broker._results)


def test_no_quote_rejects() -> None:
    broker = _broker(bid=None, ask=None)
    result = asyncio.run(broker.place_order(_order(Side.BUY, 1, "c1")))
    assert result.status is OrderStatus.REJECTED
    assert "quote" in result.reason


def test_close_position_goes_flat() -> None:
    broker = _broker()
    asyncio.run(broker.place_order(_order(Side.BUY, 3, "open")))
    [pos] = asyncio.run(broker.get_positions("EURUSD"))

    close = asyncio.run(broker.close_position(pos.deal_id))
    assert close.status is OrderStatus.FILLED
    assert close.filled_quantity == 3
    assert asyncio.run(broker.get_positions("EURUSD")) == []


def test_partial_close_keeps_entry_level() -> None:
    broker = _broker(bid=100.0, ask=100.2)
    asyncio.run(broker.place_order(_order(Side.BUY, 4, "open")))
    [pos] = asyncio.run(broker.get_positions("EURUSD"))

    asyncio.run(broker.close_position(pos.deal_id, quantity=1))
    [remaining] = asyncio.run(broker.get_positions("EURUSD"))
    assert remaining.quantity == 3
    assert remaining.open_level == 100.2  # entry unchanged by a partial close
    assert remaining.deal_id == pos.deal_id


def test_adding_blends_entry_level() -> None:
    # First BUY at ask 100.2, then a second BUY after the quote moves to 100.6.
    broker = _broker(bid=100.0, ask=100.2)
    asyncio.run(broker.place_order(_order(Side.BUY, 1, "a")))

    async def fake_raw(epic: str):
        return {"snapshot": {"bid": 100.4, "offer": 100.6}}

    broker._market._fetch_market_raw = fake_raw  # type: ignore[method-assign]
    asyncio.run(broker.place_order(_order(Side.BUY, 1, "b")))

    [pos] = asyncio.run(broker.get_positions("EURUSD"))
    assert pos.quantity == 2
    assert pos.open_level == (100.2 + 100.6) / 2  # volume-weighted blend


def test_reversal_through_zero_opens_new_leg() -> None:
    broker = _broker(bid=100.0, ask=100.2)
    asyncio.run(broker.place_order(_order(Side.BUY, 1, "long")))
    # SELL 3 reverses: closes the 1 long, opens 2 short at the bid (100.0).
    asyncio.run(broker.place_order(_order(Side.SELL, 3, "flip")))

    [pos] = asyncio.run(broker.get_positions("EURUSD"))
    assert pos.side is Side.SELL
    assert pos.quantity == 2
    assert pos.open_level == 100.0


def test_modify_position_sets_stops() -> None:
    broker = _broker()
    asyncio.run(broker.place_order(_order(Side.BUY, 1, "open")))
    [pos] = asyncio.run(broker.get_positions("EURUSD"))

    asyncio.run(
        broker.modify_position(pos.deal_id, stop_level=99.0, take_profit_level=101.0)
    )
    [updated] = asyncio.run(broker.get_positions("EURUSD"))
    assert updated.stop_level == 99.0
    assert updated.take_profit_level == 101.0


def test_modify_position_clears_stop_but_keeps_tp() -> None:
    # clear_stop removes the SL; an unspecified (None) TP is left untouched —
    # None alone can't mean "clear" (that would break partial drag updates).
    broker = _broker()
    asyncio.run(broker.place_order(_order(Side.BUY, 1, "open")))
    [pos] = asyncio.run(broker.get_positions("EURUSD"))
    asyncio.run(
        broker.modify_position(pos.deal_id, stop_level=99.0, take_profit_level=101.0)
    )

    asyncio.run(broker.modify_position(pos.deal_id, clear_stop=True))
    [updated] = asyncio.run(broker.get_positions("EURUSD"))
    assert updated.stop_level is None
    assert updated.take_profit_level == 101.0  # untouched


def test_modify_position_validates_against_current_market_not_entry() -> None:
    # A long opened ~100; price rises to 110. Trailing the stop up to 105 (locking
    # profit) is valid against the CURRENT market (105 < 110) even though 105 is
    # above the entry — modify must validate against market, not open_level.
    broker = _broker(bid=100.0, ask=100.2)
    asyncio.run(broker.place_order(_order(Side.BUY, 1, "open")))
    [pos] = asyncio.run(broker.get_positions("EURUSD"))
    assert pos.open_level == 100.2

    broker._ticks = _FakeTicks(110.0)  # market moved up
    res = asyncio.run(broker.modify_position(pos.deal_id, stop_level=105.0))
    assert res.status is not OrderStatus.REJECTED
    [updated] = asyncio.run(broker.get_positions("EURUSD"))
    assert updated.stop_level == 105.0


def test_tick_price_preferred_over_snapshot() -> None:
    # Snapshot says 100.0/100.2 but a fresh tick (mid 105.0) exists: the fill
    # must use the tick, crossing by half the snapshot spread (0.1).
    broker = _broker(bid=100.0, ask=100.2, tick=105.0)
    buy = asyncio.run(broker.place_order(_order(Side.BUY, 1, "b")))
    assert buy.fill_price == 105.0 + 0.1  # tick mid + half-spread for BUY

    broker2 = _broker(bid=100.0, ask=100.2, tick=105.0)
    sell = asyncio.run(broker2.place_order(_order(Side.SELL, 1, "s")))
    assert sell.fill_price == 105.0 - 0.1  # tick mid - half-spread for SELL


def test_tick_without_snapshot_uses_bare_mid() -> None:
    # Tick present, snapshot empty: no spread known, fill at the bare mid.
    broker = _broker(bid=None, ask=None, tick=105.0)
    buy = asyncio.run(broker.place_order(_order(Side.BUY, 1, "b")))
    assert buy.fill_price == 105.0


def test_upnl_marks_position_to_market() -> None:
    # Long 2 entered at ask 100.2; mark price (tick mid) rises to 101.0.
    broker = _broker(bid=100.0, ask=100.2)
    asyncio.run(broker.place_order(_order(Side.BUY, 2, "o")))
    broker._ticks = _FakeTicks(101.0)  # mark price moves up

    [pos] = asyncio.run(broker.get_positions("EURUSD"))
    assert pos.upnl == 2 * (101.0 - 100.2)  # signed_size * (mid - entry)


def test_upnl_negative_for_losing_short() -> None:
    broker = _broker(bid=100.0, ask=100.2)
    asyncio.run(broker.place_order(_order(Side.SELL, 1, "o")))  # entry at bid 100.0
    broker._ticks = _FakeTicks(102.0)  # price rises against the short

    [pos] = asyncio.run(broker.get_positions("EURUSD"))
    assert pos.upnl == -1 * (102.0 - 100.0)


def test_upnl_none_without_price() -> None:
    broker = _broker(bid=100.0, ask=100.2)
    asyncio.run(broker.place_order(_order(Side.BUY, 1, "o")))
    broker._ticks = _FakeTicks(None)

    async def no_quote(epic: str):
        return {"snapshot": {}}

    broker._market._fetch_market_raw = no_quote  # type: ignore[method-assign]
    [pos] = asyncio.run(broker.get_positions("EURUSD"))
    assert pos.upnl is None


def test_quote_widens_live_mid_by_snapshot_spread() -> None:
    # Snapshot spread is 0.2 (bid 100.0 / ask 100.2); a fresh tick puts the mid
    # at 105.0. The quote must center on the live mid with the snapshot's spread.
    broker = _broker(bid=100.0, ask=100.2, tick=105.0)
    q = asyncio.run(broker.quote("EURUSD"))
    assert q["mid"] == 105.0
    assert q["ask"] == 105.1  # mid + half-spread (what a BUY fills at)
    assert q["bid"] == 104.9  # mid - half-spread (what a SELL fills at)


def test_quote_falls_back_to_snapshot_without_tick() -> None:
    broker = _broker(bid=100.0, ask=100.2, tick=None)
    q = asyncio.run(broker.quote("EURUSD"))
    assert q["bid"] == 100.0 and q["ask"] == 100.2
    assert q["mid"] == (100.0 + 100.2) / 2


def test_quote_button_price_matches_fill_price() -> None:
    # The whole point of the signature: the price shown is the price you get.
    broker = _broker(bid=100.0, ask=100.2, tick=105.0)
    q = asyncio.run(broker.quote("EURUSD"))
    buy = asyncio.run(broker.place_order(_order(Side.BUY, 1, "b")))
    assert buy.fill_price == q["ask"]


def test_is_paper_not_real_money() -> None:
    broker = _broker()
    assert broker.env == "paper"
    assert broker.is_real_money is False


# --- limit orders + triggers ------------------------------------------------


def _limit(side: Side, qty: float, level: float, coid: str, **kw) -> Order:
    return Order(
        epic="EURUSD",
        side=side,
        quantity=qty,
        client_order_id=coid,
        type=OrderType.LIMIT,
        limit_level=level,
        **kw,
    )


def test_limit_order_rests_then_fills_when_price_reached() -> None:
    broker = _broker(tick=100.0)
    res = asyncio.run(broker.place_order(_limit(Side.BUY, 2, 99.0, "L1")))
    assert res.status is OrderStatus.PENDING
    # It's resting, no position yet.
    assert asyncio.run(broker.get_positions("EURUSD")) == []
    assert len(asyncio.run(broker.get_working_orders("EURUSD"))) == 1

    # Price above the limit: still resting.
    broker._ticks.tick = 99.5
    asyncio.run(broker.check_triggers())
    assert asyncio.run(broker.get_positions("EURUSD")) == []

    # Price reaches the limit: fills into a position at the limit level.
    broker._ticks.tick = 99.0
    asyncio.run(broker.check_triggers())
    [pos] = asyncio.run(broker.get_positions("EURUSD"))
    assert pos.side is Side.BUY and pos.quantity == 2 and pos.open_level == 99.0
    assert asyncio.run(broker.get_working_orders("EURUSD")) == []


def test_limit_carries_sl_tp_onto_filled_position() -> None:
    broker = _broker(tick=100.0)
    asyncio.run(
        broker.place_order(
            _limit(Side.BUY, 1, 99.0, "L1", stop_level=98.0, take_profit_level=101.0)
        )
    )
    broker._ticks.tick = 99.0
    asyncio.run(broker.check_triggers())
    [pos] = asyncio.run(broker.get_positions("EURUSD"))
    assert pos.stop_level == 98.0 and pos.take_profit_level == 101.0


def test_stop_loss_auto_closes_long() -> None:
    broker = _broker(tick=100.0)
    asyncio.run(
        broker.place_order(
            Order(
                epic="EURUSD", side=Side.BUY, quantity=1, client_order_id="m",
                stop_level=98.0,
            )
        )
    )
    broker._ticks.tick = 97.9  # below the stop
    asyncio.run(broker.check_triggers())
    assert asyncio.run(broker.get_positions("EURUSD")) == []  # stopped out


def test_take_profit_auto_closes_long() -> None:
    broker = _broker(tick=100.0)
    asyncio.run(
        broker.place_order(
            Order(
                epic="EURUSD", side=Side.BUY, quantity=1, client_order_id="m",
                take_profit_level=102.0,
            )
        )
    )
    broker._ticks.tick = 102.1
    asyncio.run(broker.check_triggers())
    assert asyncio.run(broker.get_positions("EURUSD")) == []


def test_limit_rejects_wrong_side_stop() -> None:
    broker = _broker(tick=100.0)
    # BUY limit at 99 with a stop ABOVE it (100) is invalid.
    res = asyncio.run(
        broker.place_order(_limit(Side.BUY, 1, 99.0, "L1", stop_level=100.0))
    )
    assert res.status is OrderStatus.REJECTED and "stop" in res.reason


def test_modify_working_order_changes_level() -> None:
    broker = _broker(tick=100.0)
    res = asyncio.run(broker.place_order(_limit(Side.BUY, 1, 99.0, "L1")))
    asyncio.run(broker.modify_working_order(res.deal_id, limit_level=98.5))
    [wo] = asyncio.run(broker.get_working_orders("EURUSD"))
    assert wo.limit_level == 98.5


def test_cancel_working_order_removes_it() -> None:
    broker = _broker(tick=100.0)
    res = asyncio.run(broker.place_order(_limit(Side.BUY, 1, 99.0, "L1")))
    cancel = asyncio.run(broker.cancel_working_order(res.deal_id))
    assert cancel.status is OrderStatus.FILLED  # "action completed"
    assert asyncio.run(broker.get_working_orders("EURUSD")) == []


def test_modify_position_rejects_wrong_side_sl() -> None:
    broker = _broker(bid=100.0, ask=100.2, tick=100.1)
    asyncio.run(broker.place_order(_order(Side.BUY, 1, "m")))  # long ~100.1
    [pos] = asyncio.run(broker.get_positions("EURUSD"))
    bad = asyncio.run(broker.modify_position(pos.deal_id, stop_level=101.0))
    assert bad.status is OrderStatus.REJECTED


def test_market_order_rejects_wrong_side_tp() -> None:
    broker = _broker(bid=100.0, ask=100.2, tick=100.1)
    res = asyncio.run(
        broker.place_order(
            Order(
                epic="EURUSD", side=Side.BUY, quantity=1, client_order_id="m",
                take_profit_level=99.0,  # below entry for a long: invalid
            )
        )
    )
    assert res.status is OrderStatus.REJECTED


# --- regression tests for code-review fixes ---------------------------------


def test_scale_in_preserves_existing_sl_tp() -> None:
    # A protected long, then a plain market scale-in (no SL/TP of its own): the
    # existing stop and target must survive — dropping them would silently leave
    # the larger position unprotected.
    broker = _broker(bid=100.0, ask=100.2)
    asyncio.run(
        broker.place_order(
            Order(
                epic="EURUSD", side=Side.BUY, quantity=1, client_order_id="open",
                stop_level=98.0, take_profit_level=103.0,
            )
        )
    )
    asyncio.run(broker.place_order(_order(Side.BUY, 1, "add")))  # scale in, no levels

    [pos] = asyncio.run(broker.get_positions("EURUSD"))
    assert pos.quantity == 2
    assert pos.stop_level == 98.0 and pos.take_profit_level == 103.0


def test_partial_close_preserves_sl_tp() -> None:
    broker = _broker(bid=100.0, ask=100.2)
    asyncio.run(
        broker.place_order(
            Order(
                epic="EURUSD", side=Side.BUY, quantity=4, client_order_id="open",
                stop_level=98.0, take_profit_level=103.0,
            )
        )
    )
    [pos] = asyncio.run(broker.get_positions("EURUSD"))
    asyncio.run(broker.close_position(pos.deal_id, quantity=1))

    [remaining] = asyncio.run(broker.get_positions("EURUSD"))
    assert remaining.quantity == 3
    assert remaining.stop_level == 98.0 and remaining.take_profit_level == 103.0


def test_modify_does_not_revalidate_untouched_level() -> None:
    # A long with a TP at 101; price then drifts to 102 (a non-streamed epic, so
    # the TP hasn't auto-triggered). Dragging only the STOP must not be rejected
    # for the untouched TP now sitting "below" the market — that kept TP simply
    # triggers on the next tick; it isn't this edit's concern.
    broker = _broker(bid=100.0, ask=100.2, tick=100.1)
    asyncio.run(
        broker.place_order(
            Order(
                epic="EURUSD", side=Side.BUY, quantity=1, client_order_id="open",
                take_profit_level=101.0,
            )
        )
    )
    [pos] = asyncio.run(broker.get_positions("EURUSD"))

    broker._ticks = _FakeTicks(102.0)  # price now above the kept TP
    res = asyncio.run(broker.modify_position(pos.deal_id, stop_level=99.0))
    assert res.status is not OrderStatus.REJECTED
    [updated] = asyncio.run(broker.get_positions("EURUSD"))
    assert updated.stop_level == 99.0
    assert updated.take_profit_level == 101.0  # kept, untouched


def test_gapped_limit_fill_stops_out_same_cycle() -> None:
    # A BUY limit at 99 with a stop at 98.5. Price gaps straight through both in a
    # single move: the fill (at 98.0) and the already-crossed stop must BOTH
    # resolve this cycle, not leave the position open and unprotected for one.
    broker = _broker(tick=100.0)
    asyncio.run(broker.place_order(_limit(Side.BUY, 1, 99.0, "L1", stop_level=98.5)))
    broker._ticks.tick = 98.0
    asyncio.run(broker.check_triggers())

    assert asyncio.run(broker.get_positions("EURUSD")) == []
    assert asyncio.run(broker.get_working_orders("EURUSD")) == []


def test_quote_no_tick_applies_slippage_matching_fill() -> None:
    # With slippage and no live tick, the quoted price must already include the
    # slippage the fill applies — the displayed price is the price you get.
    market = CapitalComBroker.__new__(CapitalComBroker)

    async def fake_raw(epic: str):
        return {"snapshot": {"bid": 100.0, "offer": 100.2}}

    market._fetch_market_raw = fake_raw  # type: ignore[method-assign]
    broker = PaperExecutionBroker(market, slippage=0.05, tick_store=_FakeTicks(None))

    q = asyncio.run(broker.quote("EURUSD"))
    assert q["ask"] == 100.2 + 0.05  # BUY crosses the ask, widened by slippage
    assert q["bid"] == 100.0 - 0.05

    buy = asyncio.run(broker.place_order(_order(Side.BUY, 1, "b")))
    assert buy.fill_price == q["ask"]
