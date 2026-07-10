"""expires_at threads through the core models and API schemas as an optional
UTC field defaulting to None (= Good-Till-Cancelled)."""

from __future__ import annotations

from datetime import datetime, timezone

from auto_trader.api.schemas import LevelsRequest, OrderRequest, WorkingOrderDTO
from auto_trader.core.models import Order, Side, WorkingOrder


def test_order_expires_at_defaults_none() -> None:
    o = Order(epic="EURUSD", side=Side.BUY, quantity=1, client_order_id="c1")
    assert o.expires_at is None


def test_order_carries_expires_at() -> None:
    when = datetime(2026, 7, 11, 16, 0, tzinfo=timezone.utc)
    o = Order(epic="EURUSD", side=Side.BUY, quantity=1, client_order_id="c1", expires_at=when)
    assert o.expires_at == when


def test_working_order_expires_at_defaults_none() -> None:
    w = WorkingOrder(epic="EURUSD", side=Side.BUY, quantity=1, limit_level=1.1, order_id="WO-1")
    assert w.expires_at is None


def test_schemas_have_expiry_fields() -> None:
    assert OrderRequest.model_fields["expires_at"].default is None
    assert LevelsRequest.model_fields["expires_at"].default is None
    assert LevelsRequest.model_fields["clear_expiry"].default is False
    assert WorkingOrderDTO.model_fields["expires_at"].default is None
