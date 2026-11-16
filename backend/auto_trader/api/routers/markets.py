"""Market data & discovery routes: health, brokers, search, meta, favorites."""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from auto_trader.brokers.yahoo_earnings import EARNINGS
from auto_trader.brokers.yahoo_splits import SPLITS
from auto_trader.core.catalog_cache import cached_catalog
from auto_trader.core.market_status import MARKET_STATUS

from .. import deps
from ..deps import broker_query, get_data, guarded, request_is_admin
from ..schemas import MarketDTO

router = APIRouter()


@router.get("/health")
async def health() -> dict:
    return {"status": "ok"}


@router.get("/api/brokers")
async def brokers(request: Request) -> dict:
    # Selector payload: registered data brokers + execution accounts. The frontend
    # populates the toolbar broker/account dropdown from this. Non-admins in
    # hosted mode see only the unrestricted (credential-free) brokers.
    assert deps._registry is not None, "registry not initialised"
    admin = request_is_admin(request)
    return {**deps._registry.describe(include_restricted=admin), "isAdmin": admin}


@router.get("/api/markets", response_model=list[MarketDTO])
async def markets(
    q: str = Query(""), broker_id: str = Depends(broker_query)
) -> list[MarketDTO]:
    # Keyword search. The symbol-search modal uses this while the user types; its
    # default/category browsing comes from /api/markets/all (filtered client-side).
    broker = get_data(broker_id)  # 404 on unknown broker — surface, don't mask as 502
    found = await guarded(broker_id, lambda: broker.search_markets(q), "market search")
    return [MarketDTO(**m) for m in found]


@router.get("/api/markets/all", response_model=list[MarketDTO])
async def all_markets(
    broker_id: str = Depends(broker_query),
) -> list[MarketDTO]:
    # The full instrument catalogue (~4000), one upstream call. The modal caches
    # this and filters by instrumentType for its category chips. Served through
    # core/catalog_cache.py so page loads don't each cost an upstream call.
    broker = get_data(broker_id)
    found = await cached_catalog(
        broker_id,
        broker,
        lambda: guarded(broker_id, lambda: broker.all_markets(), "market list"),
    )
    return [MarketDTO(**m) for m in found]


async def _cached_meta(
    broker_id: str, epic: str, max_age_s: float | None = None
) -> dict | None:
    """The broker's meta for `epic`, from the shared server-side cache
    (core/market_status.py), so every user and reload reuses one lookup."""
    broker = get_data(broker_id)
    return await MARKET_STATUS.get(
        broker_id,
        epic,
        lambda: guarded(broker_id, lambda: broker.get_market_meta(epic), "market lookup"),
        max_age_s,
    )


# Most epics one status call may ask for, and how many uncached ones it looks
# up upstream at once.
_STATUS_MAX_EPICS = 100
_STATUS_CONCURRENCY = 4
# The oldest cached answer a fresh=1 meta request accepts.
_FRESH_MAX_AGE_S = 30.0


@router.get("/api/markets/status")
async def markets_status(
    epic: list[str] = Query(default_factory=list),
    broker_id: str = Depends(broker_query),
) -> dict[str, dict[str, object]]:
    # Open/closed for many epics in one call (the tab bar's closed badges).
    # Served from the shared cache, so it costs no upstream call once warm. A
    # failed lookup answers closed: null plus error: true for that epic only;
    # closed: null alone means the broker doesn't report open/closed.
    epics = list(dict.fromkeys(e for e in epic if e))
    if len(epics) > _STATUS_MAX_EPICS:
        raise HTTPException(422, f"at most {_STATUS_MAX_EPICS} epics")
    gate = asyncio.Semaphore(_STATUS_CONCURRENCY)

    async def one(e: str) -> tuple[str, dict[str, object]]:
        async with gate:
            try:
                meta = await _cached_meta(broker_id, e) or {}
            except Exception:
                return e, {"closed": None, "nextOpen": None, "error": True}
        return e, {"closed": meta.get("closed"), "nextOpen": meta.get("nextOpen")}

    return dict(await asyncio.gather(*(one(e) for e in epics)))


@router.get("/api/market/{epic}")
async def market_meta(
    epic: str,
    broker_id: str = Depends(broker_query),
    fresh: bool = False,
) -> dict[str, object]:
    # Display precision + open/closed status for one epic, from the platform's own
    # single-market snapshot (one upstream call). The chart calls this on load so a
    # symbol persisted without precision (the bulk list omits it, e.g. OIL_CRUDE)
    # still renders at the right scale, and polls it so the tab badge / price label
    # flip when the market closes while the chart is open.
    # fresh=1 (the chart's re-check after its stream went quiet) refuses a
    # cached answer older than _FRESH_MAX_AGE_S, so a market that just closed
    # shows as fast as before the shared cache.
    meta = await _cached_meta(broker_id, epic, _FRESH_MAX_AGE_S if fresh else None) or {}
    return {
        "epic": epic,
        "pricePrecision": meta.get("pricePrecision"),
        # `closed` is derived from the instrument's opening hours (authoritative on
        # both demo and live); `status` is the raw marketStatus, kept for reference.
        "closed": meta.get("closed"),
        "nextOpen": meta.get("nextOpen"),
        "status": meta.get("status"),
    }


# Instrument types that can split, in each broker's own vocabulary: Capital,
# IG and MT5 use Capital's instrumentType words, yfinance/dukascopy their own.
_EQUITY_TYPES = frozenset({"SHARES", "stock", "etf"})


async def _equity_meta(epic: str, broker_id: str) -> dict | None:
    """The broker's meta for `epic` when it is an equity, else None. Splits and
    earnings markers are decoration, so a failed type lookup reads as "not an
    equity", not an error."""
    broker = get_data(broker_id)
    try:
        meta = await broker.get_market_meta(epic)
    except Exception:  # noqa: BLE001
        return None
    return meta if (meta or {}).get("type") in _EQUITY_TYPES else None


@router.get("/api/market/{epic}/splits")
async def market_splits(
    epic: str, broker_id: str = Depends(broker_query)
) -> dict[str, object]:
    # Split history for the chart's split markers, from Yahoo. The epic is the
    # ticker for Capital and yfinance; IG and MT5 name it in meta.yahooTicker. Equities only, by the broker's
    # own instrument type: Yahoo's GOLD is Barrick, not the gold CFD.
    meta = await _equity_meta(epic, broker_id)
    if meta is None:
        return {"epic": epic, "splits": []}
    splits = await SPLITS.get(epic, ticker=meta.get("yahooTicker"))
    return {"epic": epic, "splits": [{"time": s.ts, "ratio": s.ratio} for s in splits]}


@router.get("/api/market/{epic}/earnings")
async def market_earnings(
    epic: str, broker_id: str = Depends(broker_query)
) -> dict[str, object]:
    # Past and upcoming earnings dates for the chart's earnings markers, from
    # Yahoo, gated exactly like the splits above. epsActual is null until the
    # quarter is reported; revenue figures are null where Yahoo has none.
    meta = await _equity_meta(epic, broker_id)
    if meta is None:
        return {"epic": epic, "earnings": []}
    rows = await EARNINGS.get(epic, ticker=meta.get("yahooTicker"))
    return {
        "epic": epic,
        "earnings": [
            {
                "time": e.ts,
                "epsEstimate": e.eps_estimate,
                "epsActual": e.eps_actual,
                "surprisePct": e.surprise_pct,
                "revenueEstimate": e.revenue_estimate,
                "revenueActual": e.revenue_actual,
                "session": e.session,
                "openTime": e.open_ts,
                "closeTime": e.close_ts,
            }
            for e in rows
        ],
    }


@router.get("/api/market/{epic}/details")
async def market_details(
    epic: str, broker_id: str = Depends(broker_query)
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
    broker_id: str = Depends(broker_query),
) -> list[MarketDTO]:
    # The account's FAVORITES watchlist — the modal's opening view.
    broker = get_data(broker_id)
    found = await guarded(broker_id, lambda: broker.favorites(), "favorites")
    return [MarketDTO(**m) for m in found]


@router.put("/api/favorites/{epic}", status_code=204)
async def add_favorite(
    epic: str, broker_id: str = Depends(broker_query)
) -> None:
    # Add an epic to the FAVORITES watchlist (creates the list on first add).
    broker = get_data(broker_id)
    try:
        await broker.add_favorite(epic)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"add favorite failed: {e}") from e


@router.delete("/api/favorites/{epic}", status_code=204)
async def remove_favorite(
    epic: str, broker_id: str = Depends(broker_query)
) -> None:
    # Remove an epic from the FAVORITES watchlist.
    broker = get_data(broker_id)
    try:
        await broker.remove_favorite(epic)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"remove favorite failed: {e}") from e
