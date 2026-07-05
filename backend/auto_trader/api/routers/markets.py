"""Market data & discovery routes: health, brokers, search, meta, favorites."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from .. import deps
from ..deps import get_data, guarded
from ..schemas import MarketDTO

router = APIRouter()


@router.get("/health")
async def health() -> dict:
    return {"status": "ok"}


@router.get("/api/brokers")
async def brokers() -> dict:
    # Selector payload: registered data brokers + execution accounts. The frontend
    # populates the toolbar broker/account dropdown from this.
    assert deps._registry is not None, "registry not initialised"
    return deps._registry.describe()


@router.get("/api/markets", response_model=list[MarketDTO])
async def markets(
    q: str = Query(""), broker_id: str = Query("capital", alias="broker")
) -> list[MarketDTO]:
    # Keyword search. The symbol-search modal uses this while the user types; its
    # default/category browsing comes from /api/markets/all (filtered client-side).
    broker = get_data(broker_id)  # 404 on unknown broker — surface, don't mask as 502
    found = await guarded(broker_id, lambda: broker.search_markets(q), "market search")
    return [MarketDTO(**m) for m in found]


@router.get("/api/markets/all", response_model=list[MarketDTO])
async def all_markets(
    broker_id: str = Query("capital", alias="broker"),
) -> list[MarketDTO]:
    # The full instrument catalogue (~4000), one upstream call. The modal caches
    # this and filters by instrumentType for its category chips.
    broker = get_data(broker_id)
    found = await guarded(broker_id, lambda: broker.all_markets(), "market list")
    return [MarketDTO(**m) for m in found]


@router.get("/api/market/{epic}")
async def market_meta(
    epic: str, broker_id: str = Query("capital", alias="broker")
) -> dict[str, object]:
    # Display precision + open/closed status for one epic, from the platform's own
    # single-market snapshot (one upstream call). The chart calls this on load so a
    # symbol persisted without precision (the bulk list omits it, e.g. OIL_CRUDE)
    # still renders at the right scale, and polls it so the tab badge / price label
    # flip when the market closes while the chart is open.
    broker = get_data(broker_id)
    meta = await guarded(broker_id, lambda: broker.get_market_meta(epic), "market lookup")
    meta = meta or {}
    return {
        "epic": epic,
        "pricePrecision": meta.get("pricePrecision"),
        # `closed` is derived from the instrument's opening hours (authoritative on
        # both demo and live); `status` is the raw marketStatus, kept for reference.
        "closed": meta.get("closed"),
        "nextOpen": meta.get("nextOpen"),
        "status": meta.get("status"),
    }


@router.get("/api/market/{epic}/details")
async def market_details(
    epic: str, broker_id: str = Query("capital", alias="broker")
) -> dict[str, object]:
    # Full broker-provided instrument detail (instrument + dealingRules + snapshot),
    # passed through verbatim for the chart's instrument-details modal. Fetched once
    # on modal-open — NOT polled (unlike /api/market/{epic}); the snapshot section is
    # a point-in-time quote and that's fine for a click-to-open view.
    broker = get_data(broker_id)
    detail = await guarded(broker_id, lambda: broker.get_market_detail(epic), "market lookup")
    if detail is None:
        raise HTTPException(status_code=404, detail=f"unknown market '{epic}'")
    return detail


@router.get("/api/favorites", response_model=list[MarketDTO])
async def favorites(
    broker_id: str = Query("capital", alias="broker"),
) -> list[MarketDTO]:
    # The account's FAVORITES watchlist — the modal's opening view.
    broker = get_data(broker_id)
    found = await guarded(broker_id, lambda: broker.favorites(), "favorites")
    return [MarketDTO(**m) for m in found]


@router.put("/api/favorites/{epic}", status_code=204)
async def add_favorite(
    epic: str, broker_id: str = Query("capital", alias="broker")
) -> None:
    # Add an epic to the FAVORITES watchlist (creates the list on first add).
    broker = get_data(broker_id)
    try:
        await broker.add_favorite(epic)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"add favorite failed: {e}") from e


@router.delete("/api/favorites/{epic}", status_code=204)
async def remove_favorite(
    epic: str, broker_id: str = Query("capital", alias="broker")
) -> None:
    # Remove an epic from the FAVORITES watchlist.
    broker = get_data(broker_id)
    try:
        await broker.remove_favorite(epic)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"remove favorite failed: {e}") from e
