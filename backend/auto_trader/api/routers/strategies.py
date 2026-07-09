"""Coded-strategy discovery: list backend/strategies/*.py and serve their
source read-only. Files are authored in the user's IDE; the app never writes
them. The loader module attribute (not a from-import) is read at call time so
tests can monkeypatch STRATEGIES_DIR."""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException

from auto_trader.strategy import loader

from ..schemas import StrategyInfoDTO, StrategySourceDTO

router = APIRouter()


@router.get("/api/strategies", response_model=list[StrategyInfoDTO])
async def strategies() -> list[StrategyInfoDTO]:
    return [
        StrategyInfoDTO(
            filename=i.filename, name=i.name, description=i.description,
            hedged=i.hedged, error=i.error,
        )
        for i in loader.list_strategies(loader.STRATEGIES_DIR)
    ]


@router.get("/api/strategies/{filename}/source", response_model=StrategySourceDTO)
async def strategy_source(filename: str) -> StrategySourceDTO:
    if Path(filename).name != filename or not filename.endswith(".py"):
        raise HTTPException(404, f"unknown strategy '{filename}'")
    path = loader.STRATEGIES_DIR / filename
    if not path.is_file():
        raise HTTPException(404, f"unknown strategy '{filename}'")
    return StrategySourceDTO(filename=filename, source=path.read_text())
