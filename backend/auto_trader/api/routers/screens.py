"""Screener: saved screens (CRUD) and screen runs (start, poll, cancel).

A screen is judged on each symbol's last closed bar (core/screen_eval.py);
runs are in-memory jobs (api/screen_jobs.py). Every route is per user."""

from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field, StringConstraints, field_validator

from auto_trader.api import deps
from auto_trader.api.screen_jobs import SCREEN_JOBS, JobBusy
from auto_trader.core.models import Resolution
from auto_trader.core.screen_eval import ScreenSpecError, compile_screen
from auto_trader.core.screen_store import SCREEN_STORE

router = APIRouter()

_MAX_SYMBOLS = 500
_MAX_EXPR = 2000

Symbol = Annotated[str, StringConstraints(max_length=64)]


class ColumnBody(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    expression: str = Field(max_length=_MAX_EXPR)


class ScreenRunBody(BaseModel):
    broker: str
    resolution: Resolution
    symbols: list[Symbol]
    expression: str = Field(max_length=_MAX_EXPR)
    columns: list[ColumnBody] = Field(default_factory=list, max_length=8)
    priceSide: Literal["bid", "mid", "ask"] = "mid"

    @field_validator("symbols")
    @classmethod
    def _clean_symbols(cls, v: list[str]) -> list[str]:
        # Strip, drop blanks, dedupe (first spelling wins), then cap. Run and
        # save share this, so a saved screen always runs as it was stored.
        out = list(dict.fromkeys(s.strip() for s in v if s.strip()))
        if len(out) > _MAX_SYMBOLS:
            raise ValueError(f"at most {_MAX_SYMBOLS} symbols per screen")
        return out


class ScreenBody(ScreenRunBody):
    name: str = Field(min_length=1, max_length=80)


def _compile(body: ScreenRunBody):
    try:
        return compile_screen(body.expression, [c.model_dump() for c in body.columns])
    except ScreenSpecError as e:
        raise HTTPException(422, {
            "code": e.err.code, "message": e.err.message,
            "start": e.err.start, "end": e.err.end,
            "field": e.field, "index": e.index,
        })


def _data(body: ScreenBody, broker: str) -> dict:
    return {"name": body.name, "broker": broker, "resolution": body.resolution.value,
            "symbols": body.symbols, "expression": body.expression,
            "columns": [c.model_dump() for c in body.columns]}


@router.get("/api/screens")
async def list_screens(request: Request) -> dict:
    return {"screens": await SCREEN_STORE.list(deps.current_user(request))}


@router.post("/api/screens")
async def create_screen(request: Request, body: ScreenBody) -> dict:
    _compile(body)
    broker = deps.resolve_broker(request, body.broker)
    return await SCREEN_STORE.create(deps.current_user(request), _data(body, broker))


@router.put("/api/screens/{screen_id}")
async def update_screen(request: Request, screen_id: str, body: ScreenBody) -> dict:
    _compile(body)
    broker = deps.resolve_broker(request, body.broker)
    row = await SCREEN_STORE.update(deps.current_user(request), screen_id, _data(body, broker))
    if row is None:
        raise HTTPException(404, "no such screen")
    return row


@router.delete("/api/screens/{screen_id}", status_code=204)
async def delete_screen(request: Request, screen_id: str) -> None:
    if not await SCREEN_STORE.delete(deps.current_user(request), screen_id):
        raise HTTPException(404, "no such screen")


@router.post("/api/screens/run")
async def run_screen(request: Request, body: ScreenRunBody) -> dict:
    symbols = body.symbols  # already stripped, deduped and capped
    if not symbols:
        raise HTTPException(422, "add at least one symbol")
    cs = _compile(body)
    broker = deps.resolve_broker(request, body.broker)
    try:
        jid = SCREEN_JOBS.start(deps.current_user(request), broker=broker,
                                resolution=body.resolution.value, side=body.priceSide,
                                symbols=symbols, cs=cs)
    except JobBusy:
        raise HTTPException(409, "a screen is already running")
    return {"jobId": jid, "total": len(symbols)}


@router.get("/api/screens/jobs/{job_id}")
async def screen_job(request: Request, job_id: str) -> dict:
    st = SCREEN_JOBS.status(deps.current_user(request), job_id)
    if st is None:
        raise HTTPException(404, "no such screen run")
    return st


@router.post("/api/screens/jobs/{job_id}/cancel", status_code=204)
async def cancel_screen_job(request: Request, job_id: str) -> None:
    if not SCREEN_JOBS.cancel(deps.current_user(request), job_id):
        raise HTTPException(404, "no running screen with that id")
