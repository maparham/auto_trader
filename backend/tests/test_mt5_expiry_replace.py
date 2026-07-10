"""MT5 amend-expiry = cancel-and-replace.

MT5/MetaApi's ORDER_MODIFY cannot change a pending order's expiration (protocol
limitation, verified against the SDK + trade docs + a live account). So changing
an MT5 order's expiry must cancel the order and recreate it with the new
expiration. A level-only edit still uses the cheap in-place modify. If the
recreate fails after the cancel, the original order is rolled back."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

from metaapi_cloud_sdk.clients.metaapi.trade_exception import TradeException
from metaapi_cloud_sdk.clients.timeout_exception import TimeoutException

from auto_trader.brokers.mt5 import (
    MT5Broker,
    MT5ExecutionBroker,
    _mt5_expiry_changes,
    _order_is_gtc,
    _order_original_expiration,
)
from auto_trader.core.models import OrderStatus

MIDNIGHT = datetime(2026, 7, 10, 0, 0, tzinfo=timezone.utc)


def _day_order() -> dict:
    """A live-shaped ORDER_TIME_DAY sell-limit (expirationTime = day boundary)."""
    return {
        "id": "152150452",
        "symbol": "CrudeOIL",
        "type": "ORDER_TYPE_SELL_LIMIT",
        "volume": 1.0,
        "openPrice": 72.98,
        "stopLoss": 0,
        "takeProfit": 0,
        "expirationType": "ORDER_TIME_DAY",
        "expirationTime": MIDNIGHT,
    }


# --- pure helpers ---------------------------------------------------------


def test_order_is_gtc() -> None:
    assert _order_is_gtc({"expirationType": "ORDER_TIME_GTC"})
    assert _order_is_gtc({})  # no type + no time = GTC
    assert not _order_is_gtc(_day_order())


def test_expiry_changes_specific_vs_day() -> None:
    # A specific future expiry differs from the day-boundary → change.
    assert _mt5_expiry_changes(_day_order(), MIDNIGHT + timedelta(minutes=39), False)
    # Carrying the same value forward (level-only edit) → no change.
    assert not _mt5_expiry_changes(_day_order(), MIDNIGHT, False)
    # No expiry supplied → no change.
    assert not _mt5_expiry_changes(_day_order(), None, False)


def test_expiry_changes_clear() -> None:
    assert _mt5_expiry_changes(_day_order(), None, True)  # clear a DAY order → change
    assert not _mt5_expiry_changes({"expirationType": "ORDER_TIME_GTC"}, None, True)


def test_original_expiration_roundtrip() -> None:
    assert _order_original_expiration(_day_order()) == {
        "expiration": {"type": "ORDER_TIME_DAY", "time": MIDNIGHT}
    }
    assert _order_original_expiration({"expirationType": "ORDER_TIME_GTC"}) is None


# --- integration: modify_working_order -----------------------------------


class _ReplaceConn:
    """Records cancel/create/modify calls; can fail the first create (to force a
    rollback) and/or the rollback create."""

    def __init__(
        self,
        order,
        *,
        create_rejects=False,   # clean server reject (TradeException) → rollback is safe
        create_ambiguous=False,  # timeout / drop → order MAY be live → must NOT rollback
        cancel_fails=False,
        rollback_fails=False,
    ):
        self._order = order
        self.calls: list = []
        self._create_rejects = create_rejects
        self._create_ambiguous = create_ambiguous
        self._cancel_fails = cancel_fails
        self._rollback_fails = rollback_fails
        self._creates = 0

    async def get_orders(self, options=None):
        return [self._order]

    async def cancel_order(self, order_id, options=None):
        self.calls.append(("cancel", order_id))
        if self._cancel_fails:
            raise TimeoutException("mt5: rpc timed out")
        return {"stringCode": "TRADE_RETCODE_DONE"}

    async def create_limit_sell_order(self, symbol, volume, price, sl, tp, options=None):
        self._creates += 1
        self.calls.append(("create_sell", symbol, volume, price, sl, tp, options))
        if self._creates == 1:
            if self._create_ambiguous:
                raise TimeoutException("mt5: rpc timed out")  # server state unknown
            if self._create_rejects:
                raise TradeException("rejected", 10004, "TRADE_RETCODE_REJECT")
        if self._rollback_fails and self._creates == 2:
            raise TradeException("rollback rejected", 10004, "TRADE_RETCODE_REJECT")
        return {"orderId": "NEW1", "stringCode": "TRADE_RETCODE_DONE"}

    async def create_limit_buy_order(self, symbol, volume, price, sl, tp, options=None):
        self._creates += 1
        self.calls.append(("create_buy", symbol, volume, price, sl, tp, options))
        return {"orderId": "NEW1", "stringCode": "TRADE_RETCODE_DONE"}

    async def modify_order(self, order_id, price, sl, tp, options=None):
        self.calls.append(("modify", order_id, price, sl, tp))
        return {"stringCode": "TRADE_RETCODE_DONE"}


def _broker(conn) -> MT5ExecutionBroker:
    data = MT5Broker(token="t", account_id="a")

    async def _ensure():
        return conn

    data._ensure = _ensure
    data._conn = conn
    data._synced = True
    return MT5ExecutionBroker(data)


def _kinds(conn) -> list[str]:
    return [c[0] for c in conn.calls]


def test_level_only_edit_uses_plain_modify() -> None:
    # Carry the current expiry forward (what the frontend sends on a level edit).
    conn = _ReplaceConn(_day_order())
    res = asyncio.run(
        _broker(conn).modify_working_order("152150452", limit_level=73.0, expires_at=MIDNIGHT)
    )
    assert res.status is OrderStatus.FILLED
    assert _kinds(conn) == ["modify"]  # no cancel / create
    assert ("modify", "152150452", 73.0, 0, 0) in conn.calls


def test_expiry_change_cancels_and_recreates() -> None:
    conn = _ReplaceConn(_day_order())
    new_exp = MIDNIGHT + timedelta(minutes=39)
    res = asyncio.run(
        _broker(conn).modify_working_order("152150452", expires_at=new_exp)
    )
    assert res.status is OrderStatus.PENDING
    assert res.deal_id == "NEW1"  # replacement's new ticket
    assert _kinds(conn) == ["cancel", "create_sell"]  # cancel then recreate, no modify
    # The recreate carries the merged level + the NEW expiration.
    create = next(c for c in conn.calls if c[0] == "create_sell")
    _, symbol, volume, price, _sl, _tp, options = create
    assert symbol == "CrudeOIL" and volume == 1.0 and price == 72.98
    assert options == {"expiration": {"type": "ORDER_TIME_SPECIFIED", "time": new_exp}}


def test_clear_expiry_recreates_as_gtc() -> None:
    conn = _ReplaceConn(_day_order())
    res = asyncio.run(
        _broker(conn).modify_working_order("152150452", clear_expiry=True)
    )
    assert res.status is OrderStatus.PENDING
    create = next(c for c in conn.calls if c[0] == "create_sell")
    assert create[-1] is None  # no expiration options → GTC


def test_cancel_failure_does_not_recreate() -> None:
    # A cancel that RAISES has unknown state (did it cancel or not?) → UNKNOWN, so
    # the caller reconciles. Critically, we must NOT create a replacement (that
    # could leave two orders if the cancel actually went through).
    conn = _ReplaceConn(_day_order(), cancel_fails=True)
    res = asyncio.run(
        _broker(conn).modify_working_order("152150452", expires_at=MIDNIGHT + timedelta(hours=1))
    )
    assert res.status is OrderStatus.UNKNOWN
    assert _kinds(conn) == ["cancel"]  # never created


def test_clean_reject_rolls_back_original() -> None:
    # A TradeException means the server definitively rejected the replacement (no
    # order placed), so restoring the original is safe.
    conn = _ReplaceConn(_day_order(), create_rejects=True)
    res = asyncio.run(
        _broker(conn).modify_working_order("152150452", expires_at=MIDNIGHT + timedelta(hours=1))
    )
    assert res.status is OrderStatus.REJECTED
    assert "restored" in res.reason
    # cancel, rejected create, then rollback create of the ORIGINAL (with its DAY expiry).
    assert _kinds(conn) == ["cancel", "create_sell", "create_sell"]
    rollback = conn.calls[-1]
    assert rollback[3] == 72.98  # original openPrice
    assert rollback[-1] == {"expiration": {"type": "ORDER_TIME_DAY", "time": MIDNIGHT}}


def test_ambiguous_create_failure_does_not_rollback() -> None:
    # A timeout/connection-drop create may have ALREADY placed the replacement on
    # the server. Recreating the original would double up → we must NOT rollback;
    # return UNKNOWN so the caller reconciles. Exactly one create attempt.
    conn = _ReplaceConn(_day_order(), create_ambiguous=True)
    res = asyncio.run(
        _broker(conn).modify_working_order("152150452", expires_at=MIDNIGHT + timedelta(hours=1))
    )
    assert res.status is OrderStatus.UNKNOWN
    assert _kinds(conn) == ["cancel", "create_sell"]  # no second (rollback) create


def test_rollback_failure_reports_orderless() -> None:
    conn = _ReplaceConn(_day_order(), create_rejects=True, rollback_fails=True)
    res = asyncio.run(
        _broker(conn).modify_working_order("152150452", expires_at=MIDNIGHT + timedelta(hours=1))
    )
    assert res.status is OrderStatus.REJECTED
    assert "CANCELLED with no replacement" in res.reason
