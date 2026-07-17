"""Per-instrument cost profiles: broker-prefilled, user-editable, snapshotted
into runs by the frontend at submit time."""
from __future__ import annotations

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field

from auto_trader.api.deps import get_data, guarded
from auto_trader.api.schemas import SlippageDTO
from auto_trader.core.cost_profiles import COST_PROFILES

router = APIRouter()


class CostProfileIn(BaseModel):
    spread: float | None = Field(default=None, ge=0)
    slippage: SlippageDTO | None = None
    finLongDailyPct: float | None = None
    finShortDailyPct: float | None = None


def _zeroed(epic: str) -> dict:
    return {"epic": epic, "spread": 0.0,
            "slippage": {"kind": "fixed", "value": 0.0, "atrMult": 0.0},
            "finLongDailyPct": 0.0, "finShortDailyPct": 0.0,
            "source": "manual", "updatedAt": 0}


async def _broker_prefill(broker_id: str, epic: str) -> dict | None:
    """Spread from the snapshot quote only. Broker fee rates are NOT prefetched:
    broker sign conventions are inconsistent (Capital reports a negative number
    when it charges you), so financing is user-entered with the engine's
    convention (positive = cost). Returns None when the broker has no detail."""
    broker = get_data(broker_id)
    detail = await guarded(broker_id, lambda: broker.get_market_detail(epic), "market lookup")
    if not detail:
        return None
    snap = detail.get("snapshot") or {}
    bid, offer = snap.get("bid"), snap.get("offer")
    spread = round(offer - bid, 10) if isinstance(bid, (int, float)) and isinstance(offer, (int, float)) else 0.0
    if spread <= 0:
        # A missing or crossed quote (closed market, stale snapshot) carries no
        # information; treating it as "no data" keeps a stale zero from being
        # persisted as an authoritative source:"broker" profile.
        return None
    return {"spread": spread}


@router.get("/api/costs/{epic}")
async def get_profile(epic: str, broker_id: str = Query("capital", alias="broker")) -> dict:
    existing = await COST_PROFILES.get(epic)
    if existing:
        return existing
    fetched = await _broker_prefill(broker_id, epic)
    if fetched is None:
        return _zeroed(epic)
    await COST_PROFILES.upsert(epic, {**fetched, "source": "broker"})
    return await COST_PROFILES.get(epic)


@router.put("/api/costs/{epic}")
async def put_profile(epic: str, body: CostProfileIn) -> dict:
    current = await COST_PROFILES.get(epic) or _zeroed(epic)
    patch = {k: v for k, v in body.model_dump().items() if v is not None}
    await COST_PROFILES.upsert(epic, {**current, **patch, "source": "manual"})
    return await COST_PROFILES.get(epic)


@router.post("/api/costs/{epic}/refetch")
async def refetch_profile(epic: str, broker_id: str = Query("capital", alias="broker")) -> dict:
    old = await COST_PROFILES.get(epic)
    base = old or _zeroed(epic)
    fetched = await _broker_prefill(broker_id, epic)
    # Only claim source "broker" when a fetch actually landed. When the broker
    # has no detail, keep the previous profile's source untouched (a fresh
    # zeroed profile stays "manual") rather than mislabelling it.
    source = "broker" if fetched is not None else base["source"]
    await COST_PROFILES.upsert(epic, {**base, **(fetched or {}), "source": source})
    return {"old": old, "new": await COST_PROFILES.get(epic)}
