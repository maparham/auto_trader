"""Order execution routes: orders, quote, account, positions, working orders."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from auto_trader.core.broker_health import BrokerReconnecting
from auto_trader.core.models import (
    Order,
    OrderResult,
    OrderSource,
    OrderStatus,
    OrderType,
    Side,
)

from ..deps import get_exec
from ..schemas import (
    AccountSummaryDTO,
    LevelsRequest,
    OrderRequest,
    OrderResultDTO,
    PositionDTO,
    QuoteDTO,
    WorkingOrderDTO,
)

router = APIRouter()


def _order_result_dto(r: OrderResult) -> OrderResultDTO:
    return OrderResultDTO(
        client_order_id=r.client_order_id,
        status=r.status.value,
        deal_reference=r.deal_reference,
        deal_id=r.deal_id,
        filled_quantity=r.filled_quantity,
        fill_price=r.fill_price,
        reason=r.reason,
    )


def _position_dto(p) -> PositionDTO:
    return PositionDTO(
        epic=p.epic,
        side=p.side.value,
        quantity=p.quantity,
        open_level=p.open_level,
        deal_id=p.deal_id,
        stop_level=p.stop_level,
        take_profit_level=p.take_profit_level,
        upnl=p.upnl,
        created_at=p.created_at,
        leverage=p.leverage,
        margin=p.margin,
    )


def _working_order_dto(w) -> WorkingOrderDTO:
    return WorkingOrderDTO(
        epic=w.epic,
        side=w.side.value,
        quantity=w.quantity,
        limit_level=w.limit_level,
        order_id=w.order_id,
        stop_level=w.stop_level,
        take_profit_level=w.take_profit_level,
        created_at=w.created_at,
        expires_at=w.expires_at,
    )


@router.post("/api/orders", response_model=OrderResultDTO)
async def place_order(req: OrderRequest) -> OrderResultDTO:
    try:
        side = Side(req.side)
        source = OrderSource(req.source)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e

    broker = get_exec(req.account)

    # Real-money safety gates (no live executor exists in P1, but enforce here so
    # the contract holds the moment one is added):
    if broker.is_real_money:
        if not req.confirm:
            raise HTTPException(
                status_code=422, detail="live orders require confirm=true"
            )
        if source is OrderSource.STRATEGY:
            raise HTTPException(
                status_code=403, detail="automated orders are not allowed on live"
            )

    try:
        order_type = OrderType(req.type)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e

    order = Order(
        epic=req.epic,
        side=side,
        quantity=req.quantity,
        client_order_id=req.client_order_id,
        type=order_type,
        limit_level=req.limit_level,
        stop_level=req.stop_level,
        take_profit_level=req.take_profit_level,
        source=source,
        expires_at=req.expires_at,
    )
    try:
        result = await broker.place_order(order)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"order failed: {e}") from e
    if result.status is OrderStatus.REJECTED:
        raise HTTPException(status_code=422, detail=result.reason or "order rejected")
    return _order_result_dto(result)


@router.get("/api/quote/{epic}", response_model=QuoteDTO)
async def quote(epic: str, account: str = Query("capital:paper")) -> QuoteDTO:
    broker = get_exec(account)
    q = getattr(broker, "quote", None)
    if q is None:  # only the paper executor exposes a synthetic quote in P1
        raise HTTPException(status_code=404, detail="quote unavailable for account")
    try:
        return QuoteDTO(**await q(epic))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"quote failed: {e}") from e


@router.get("/api/account", response_model=AccountSummaryDTO)
async def account_summary(account: str = Query("capital:paper")) -> AccountSummaryDTO:
    """The account's real balance/available/currency (live dealing accounts). 404 when
    the account has no real summary (paper sim), so the dock keeps its paper figures."""
    broker = get_exec(account)
    fn = getattr(broker, "get_account_summary", None)
    if fn is None:
        raise HTTPException(status_code=404, detail="account summary unavailable")
    try:
        return AccountSummaryDTO(**await fn())
    except BrokerReconnecting as e:
        raise HTTPException(503, f"{account}: broker reconnecting — retry shortly") from e
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"account summary failed: {e}") from e


@router.get("/api/positions", response_model=list[PositionDTO])
async def positions(
    account: str = Query("capital:paper"), epic: str = Query("")
) -> list[PositionDTO]:
    broker = get_exec(account)
    try:
        found = await broker.get_positions(epic or None)
    except BrokerReconnecting as e:
        raise HTTPException(503, f"{account}: broker reconnecting — retry shortly") from e
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"positions failed: {e}") from e
    return [_position_dto(p) for p in found]


@router.delete("/api/positions/{deal_id}", response_model=OrderResultDTO)
async def close_position(
    deal_id: str,
    account: str = Query("capital:paper"),
    quantity: float | None = Query(None),
) -> OrderResultDTO:
    broker = get_exec(account)
    try:
        result = await broker.close_position(deal_id, quantity)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"close failed: {e}") from e
    if result.status is OrderStatus.REJECTED:
        raise HTTPException(status_code=404, detail=result.reason or "close rejected")
    return _order_result_dto(result)


@router.put("/api/positions/{deal_id}", response_model=OrderResultDTO)
async def modify_position(
    deal_id: str, req: LevelsRequest, account: str = Query("capital:paper")
) -> OrderResultDTO:
    # Edit an open position's SL/TP (the combined Apply after dragging lines).
    broker = get_exec(account)
    try:
        result = await broker.modify_position(
            deal_id,
            stop_level=req.stop_level,
            take_profit_level=req.take_profit_level,
            clear_stop=req.clear_stop,
            clear_take_profit=req.clear_take_profit,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"modify failed: {e}") from e
    if result.status is OrderStatus.REJECTED:
        raise HTTPException(status_code=422, detail=result.reason or "modify rejected")
    return _order_result_dto(result)


@router.get("/api/orders/working", response_model=list[WorkingOrderDTO])
async def working_orders(
    account: str = Query("capital:paper"), epic: str = Query("")
) -> list[WorkingOrderDTO]:
    broker = get_exec(account)
    try:
        found = await broker.get_working_orders(epic or None)
    except BrokerReconnecting as e:
        raise HTTPException(503, f"{account}: broker reconnecting — retry shortly") from e
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"working orders failed: {e}") from e
    return [_working_order_dto(w) for w in found]


@router.put("/api/orders/working/{order_id}", response_model=OrderResultDTO)
async def modify_working_order(
    order_id: str, req: LevelsRequest, account: str = Query("capital:paper")
) -> OrderResultDTO:
    broker = get_exec(account)
    try:
        result = await broker.modify_working_order(
            order_id,
            limit_level=req.limit_level,
            stop_level=req.stop_level,
            take_profit_level=req.take_profit_level,
            clear_stop=req.clear_stop,
            clear_take_profit=req.clear_take_profit,
            expires_at=req.expires_at,
            clear_expiry=req.clear_expiry,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"modify failed: {e}") from e
    if result.status is OrderStatus.REJECTED:
        raise HTTPException(status_code=422, detail=result.reason or "modify rejected")
    return _order_result_dto(result)


@router.delete("/api/orders/working/{order_id}", response_model=OrderResultDTO)
async def cancel_working_order(
    order_id: str, account: str = Query("capital:paper")
) -> OrderResultDTO:
    broker = get_exec(account)
    try:
        result = await broker.cancel_working_order(order_id)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"cancel failed: {e}") from e
    if result.status is OrderStatus.REJECTED:  # unknown order
        raise HTTPException(status_code=404, detail=result.reason or "no such order")
    return _order_result_dto(result)
