"""FastAPI surface for the frontend.

Milestone 1 is request/response only (no WebSocket): fetch candles, run a
backtest, return candles + fills + trades + equity for the chart to render.

Run:  uvicorn auto_trader.api.app:app --reload --port 8000

The routes, DTOs and shared infra were split into domain modules:
- deps.py — shared singletons (`_registry`, `BROKER_HEALTH`, `get_data`,
  `get_exec`, `guarded`, `_run_paper_triggers`, `_fetch_symbol_candles`,
  `_parse_resolution`).
- schemas.py — every Pydantic request/response model + their `to_*` converters.
- routers/ — one APIRouter per domain (markets, trading, state, charts,
  backtest, stream), each mounted below with NO prefix so paths are unchanged.
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from auto_trader.brokers.paper_exec import PaperExecutionBroker
from auto_trader.brokers.registry import build_registry
from auto_trader.core.tick_store import TICK_STORE

from . import deps
from .guard import install_guards
from .routers import backtest, charts, compute, markets, state, strategy, stream, trading, strategies

log = logging.getLogger(__name__)


def _configure_logging() -> None:
    """Prefix every log line with a timestamp. uvicorn's default access/error
    formatters omit it; we override them in place, and give the app's own
    `auto_trader.*` logger a timestamped handler — so request logs AND app messages
    are all timestamped. Run from lifespan (after uvicorn has installed its
    handlers) so we override the live formatters."""
    fmt = logging.Formatter(
        "%(asctime)s %(levelname)s %(name)s %(message)s", datefmt="%Y-%m-%d %H:%M:%S"
    )
    for name in ("uvicorn", "uvicorn.access", "uvicorn.error"):
        for handler in logging.getLogger(name).handlers:
            handler.setFormatter(fmt)
    app_log = logging.getLogger("auto_trader")
    if not app_log.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(fmt)
        app_log.addHandler(handler)
        app_log.setLevel(logging.INFO)
        app_log.propagate = False  # the handler above logs it; don't double via root


@asynccontextmanager
async def lifespan(app: FastAPI):
    _configure_logging()
    deps._registry = build_registry()
    # Periodic batch-flush of recorded ticks to sqlite (sub-minute history).
    flusher = asyncio.create_task(TICK_STORE.run_flusher())
    # Paper limit/SL/TP trigger driver — one per registered paper executor, so
    # every broker's paper account triggers (not just Capital's). Discovered by
    # type from the registry, so adding a broker needs no edit here. (A paper
    # executor only fills resting orders for epics with a live tick, so IG paper
    # triggers wait on IG streaming — deferred — while Capital's work today.)
    triggers = [
        asyncio.create_task(deps._run_paper_triggers(b, key))
        for key, b in deps._registry.exec.items()
        if isinstance(b, PaperExecutionBroker)
    ]
    try:
        yield
    finally:
        for task in (flusher, *triggers):
            task.cancel()
        with suppress(asyncio.CancelledError):
            await flusher  # lets run_flusher do its final flush
        for task in triggers:
            with suppress(asyncio.CancelledError):
                await task
        await deps._registry.aclose()
        deps._registry = None


app = FastAPI(title="Auto Trader API", version="0.1.0", lifespan=lifespan)

# Vite dev server origins.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Remote-deployment guards (bearer-token gate + compute-only dealing block). No-op
# unless the corresponding env flags are set, which happens only on the remote host.
install_guards(app)

for _module in (markets, trading, state, charts, backtest, compute, strategy, stream, strategies):
    app.include_router(_module.router)


# Re-exports so the direct-call unit tests (which drive handlers as
# `app_module.<name>(...)` and monkeypatch a few symbols) keep resolving names on
# this module. Kept explicit rather than a star-import so the surface is auditable.
# NOTE: `backtest` here rebinds the earlier `routers.backtest` module import to the
# handler function — do this AFTER the include loop, which needs the module object.
from .deps import BROKER_HEALTH  # noqa: E402,F401
from .routers.backtest import backtest  # noqa: E402,F401
from .routers.strategy import evaluate_strategy  # noqa: E402,F401
from .schemas import EvaluateRequest  # noqa: E402,F401
from .routers.charts import candles, candles_synthetic  # noqa: E402,F401
from .routers.markets import market_meta  # noqa: E402,F401
from .routers.state import _broadcast_state, _state_subscribers  # noqa: E402,F401
from .schemas import BacktestRequest, RecurrenceMaskDTO  # noqa: E402,F401
