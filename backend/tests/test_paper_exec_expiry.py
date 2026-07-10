"""Paper executor stores a limit order's expiry and cancels it once expired."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

from auto_trader.brokers.paper_exec import PaperExecutionBroker, expired_order_ids
from auto_trader.core.models import Order, OrderType, Side, WorkingOrder


class _FakeTicks:
    def __init__(self, tick: float | None = None) -> None:
        self.tick = tick

    def latest(self, broker: str | None, epic: str):
        return (1, self.tick) if self.tick is not None else None


class _FakeMarket:
    broker_id: str | None = "capital"

    def __init__(self, bid=100.0, ask=100.2) -> None:
        self.bid, self.ask = bid, ask

    async def get_quote(self, epic: str):
        return (self.bid, self.ask)


def _broker(tick: float | None = None) -> PaperExecutionBroker:
    return PaperExecutionBroker(_FakeMarket(), tick_store=_FakeTicks(tick))


def _limit(coid: str, level: float, expires_at) -> Order:
    return Order(
        epic="EURUSD", side=Side.BUY, quantity=1, client_order_id=coid,
        type=OrderType.LIMIT, limit_level=level, expires_at=expires_at,
    )


def test_expired_order_ids_selects_only_past() -> None:
    now = datetime(2026, 7, 11, 12, 0, tzinfo=timezone.utc)
    past = WorkingOrder(epic="E", side=Side.BUY, quantity=1, limit_level=1, order_id="a",
                        expires_at=now - timedelta(minutes=1))
    future = WorkingOrder(epic="E", side=Side.BUY, quantity=1, limit_level=1, order_id="b",
                          expires_at=now + timedelta(minutes=1))
    gtc = WorkingOrder(epic="E", side=Side.BUY, quantity=1, limit_level=1, order_id="c",
                       expires_at=None)
    assert expired_order_ids(now, [past, future, gtc]) == ["a"]


def test_expired_order_ids_coerces_naive_datetime_to_utc() -> None:
    """I2: a direct API caller can send a no-'Z' ISO string -> pydantic yields a
    NAIVE datetime. Comparing it against an aware `now` must not raise TypeError
    (it previously did, halting ALL paper fills/expiries every 0.5s while that
    order rested)."""
    now = datetime(2026, 7, 11, 12, 0, tzinfo=timezone.utc)
    naive_past = WorkingOrder(
        epic="E", side=Side.BUY, quantity=1, limit_level=1, order_id="naive",
        expires_at=datetime(2026, 7, 11, 11, 0),  # naive, in the past, no tzinfo
    )
    assert expired_order_ids(now, [naive_past]) == ["naive"]


def test_place_stores_expiry_and_sweep_cancels_it() -> None:
    broker = _broker(tick=100.0)  # far from the limit (90) so it never fills
    past = datetime.now(timezone.utc) - timedelta(seconds=1)
    asyncio.run(broker.place_order(_limit("c1", 90.0, past)))

    orders = asyncio.run(broker.get_working_orders("EURUSD"))
    assert len(orders) == 1 and orders[0].expires_at == past

    changed = asyncio.run(broker.check_triggers())
    assert changed is True
    assert asyncio.run(broker.get_working_orders("EURUSD")) == []


def test_sweep_keeps_unexpired_and_gtc() -> None:
    broker = _broker(tick=100.0)
    future = datetime.now(timezone.utc) + timedelta(hours=1)
    asyncio.run(broker.place_order(_limit("c1", 90.0, future)))
    asyncio.run(broker.place_order(_limit("c2", 90.0, None)))

    asyncio.run(broker.check_triggers())
    assert len(asyncio.run(broker.get_working_orders("EURUSD"))) == 2


def test_modify_working_order_preserves_expiry() -> None:
    broker = _broker(tick=100.0)
    future = datetime.now(timezone.utc) + timedelta(hours=1)
    res = asyncio.run(broker.place_order(_limit("c1", 90.0, future)))

    asyncio.run(broker.modify_working_order(res.deal_id, limit_level=91.0))

    [wo] = asyncio.run(broker.get_working_orders("EURUSD"))
    assert wo.limit_level == 91.0
    assert wo.expires_at == future


def test_modify_keeps_expiry_by_default() -> None:
    broker = _broker(tick=100.0)
    future = datetime.now(timezone.utc) + timedelta(hours=1)
    r = asyncio.run(broker.place_order(_limit("c1", 90.0, future)))
    oid = r.deal_id

    asyncio.run(broker.modify_working_order(oid, limit_level=91.0))  # level-only edit
    wo = asyncio.run(broker.get_working_orders("EURUSD"))[0]
    assert wo.limit_level == 91.0
    assert wo.expires_at == future  # untouched


def test_modify_sets_and_clears_expiry() -> None:
    broker = _broker(tick=100.0)
    r = asyncio.run(broker.place_order(_limit("c1", 90.0, None)))
    oid = r.deal_id

    new = datetime.now(timezone.utc) + timedelta(hours=2)
    asyncio.run(broker.modify_working_order(oid, expires_at=new))
    assert asyncio.run(broker.get_working_orders("EURUSD"))[0].expires_at == new

    asyncio.run(broker.modify_working_order(oid, clear_expiry=True))
    assert asyncio.run(broker.get_working_orders("EURUSD"))[0].expires_at is None
