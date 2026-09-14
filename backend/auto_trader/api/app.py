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
import re
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from auto_trader.brokers.paper_exec import PaperExecutionBroker
from auto_trader.brokers.registry import build_registry
from auto_trader.core.tick_store import TICK_STORE

from . import deps
from .auth import install_auth
from .guard import cors_origins, install_guards
from . import mcp_server
from .mcp_server import mcp_http_app, mcp_session
from .routers import admin, agent, alerts, backtest, charts, compute, costs, demo, expr, markets, mt5, patterns, pattern_presets, shell_auth, state, strategy, stream, trading, strategies

log = logging.getLogger(__name__)


_TOKEN_RE = re.compile(r"(token=)[^&\s\"']+")


class _TokenRedactionFilter(logging.Filter):
    """Rewrite `token=<value>` to `token=REDACTED` in log-record args (hosted
    WS dials put the Clerk JWT in the query string, and uvicorn.access prints
    the request line verbatim). Filters must never raise — a raising filter
    drops the record — so any surprise arg shape passes through untouched."""

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            if isinstance(record.args, tuple):
                record.args = tuple(
                    _TOKEN_RE.sub(r"\1REDACTED", a) if isinstance(a, str) else a
                    for a in record.args
                )
            if isinstance(record.msg, str) and "token=" in record.msg:
                record.msg = _TOKEN_RE.sub(r"\1REDACTED", record.msg)
        except Exception:
            pass
        return True


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
            if not any(isinstance(f, _TokenRedactionFilter) for f in handler.filters):
                handler.addFilter(_TokenRedactionFilter())
    # httpx logs every outbound request at INFO ("HTTP Request: GET ..."), which
    # floods the console during candle backfills and MetaApi polling. Broker-level
    # request visibility stays available by lowering this back to INFO/DEBUG.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    app_log = logging.getLogger("auto_trader")
    if not app_log.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(fmt)
        app_log.addHandler(handler)
        app_log.setLevel(logging.INFO)
        app_log.propagate = False  # the handler above logs it; don't double via root
    # Feed the admin console's Logs panel. Installed last so it sees records
    # only after the redaction filter is attached to the upstream handlers.
    from auto_trader.core.log_buffer import install as install_log_buffer

    # The redaction filter must ride the buffer's own handler: it is attached
    # to the LOGGERS, not to the stream handlers that carry the filter above.
    install_log_buffer(_TokenRedactionFilter())


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
    # MT5 idle watchdog: auto-undeploy a deployed-but-unused MetaApi account so a
    # forgotten deployment stops billing. Spawned only when MT5 is configured.
    try:
        mt5_watchdog = asyncio.create_task(
            deps._run_mt5_idle_watchdog(deps.get_data("mt5"))
        )
    except HTTPException:
        mt5_watchdog = None

    from auto_trader.config import telegram_settings
    from auto_trader.core.alert_engine import ALERT_ENGINE
    from auto_trader.core.alert_migrate import migrate_legacy_alerts
    from auto_trader.core.alert_store import ALERT_STORE
    from auto_trader.core.push_notify import PUSH
    from auto_trader.core.state_store import STATE_STORE
    from auto_trader.core.telegram_notify import TELEGRAM
    from .alert_hooks import build_alert_hooks
    from .routers import state as state_router

    TELEGRAM.configure(
        telegram_settings.bot_token or None, ALERT_STORE, hooks=build_alert_hooks()
    )
    PUSH.configure(ALERT_STORE)
    ALERT_ENGINE.configure(
        store=ALERT_STORE,
        get_broker=deps.get_data,
        broadcast=state_router.broadcast_to_user,
        notifiers=[TELEGRAM.notifier, PUSH.notifier],
    )
    telegram_poller = asyncio.create_task(TELEGRAM.run_poller())
    try:
        # One-shot lift of legacy localStorage alert blobs (mirrored into
        # StateStore pre-engine) into alerts.db, BEFORE start() so the
        # engine's registry load below sees the migrated rows. A migration
        # failure must not prevent boot — it's a background convenience, not
        # a boot dependency.
        try:
            migrated = await migrate_legacy_alerts(STATE_STORE, ALERT_STORE)
            if migrated:
                logging.getLogger("auto_trader.alerts").info(
                    "migrated %d legacy alert(s) from localStorage blobs", migrated
                )
        except Exception:
            logging.getLogger("auto_trader.alerts").exception(
                "legacy alert migration failed; continuing boot"
            )
        # start() is the first raising await in this block (a real store
        # failure is possible here) — it's inside try/finally so a failure
        # still tears down flusher/triggers/mt5_watchdog below rather than
        # leaking them.
        await ALERT_ENGINE.start()
        # The MCP endpoint is mounted, so its own lifespan never runs — drive its
        # streamable-HTTP session manager from here for the app's lifetime.
        async with mcp_session():
            yield
    finally:
        # A raise/hang in ALERT_ENGINE.stop() must not prevent the teardown
        # below (flusher/triggers/watchdog cancel + the registry close) —
        # same "one broken cleanup step can't block the rest" convention as
        # the suppress()s a few lines down.
        with suppress(Exception):
            await ALERT_ENGINE.stop()
        telegram_poller.cancel()
        with suppress(asyncio.CancelledError):
            await telegram_poller
        watchdogs = [t for t in (mt5_watchdog,) if t is not None]
        for task in (flusher, *triggers, *watchdogs):
            task.cancel()
        with suppress(asyncio.CancelledError):
            await flusher  # lets run_flusher do its final flush
        for task in (*triggers, *watchdogs):
            with suppress(asyncio.CancelledError):
                await task
        await deps._registry.aclose()
        deps._registry = None


app = FastAPI(title="Chartkar API", version="0.1.0", lifespan=lifespan)

# Clerk auth. Installed BEFORE CORSMiddleware so CORS wraps it (Starlette
# stacks later-added middleware outside earlier ones) and auth 401s carry
# CORS headers a cross-origin browser frontend can read. No-op without
# CLERK_JWKS_URL. See auto_trader/api/auth.py.
install_auth(app)

# Vite dev origins + any CORS_ORIGINS deployment origins (read once at startup).
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins(),
    allow_methods=["*"],
    allow_headers=["*"],
    # Lets the browser read the broker-blocked marker (see deps.guarded) so the
    # frontend can tell "your network blocks the broker" from a generic outage.
    expose_headers=["X-Broker-Blocked", "X-Candles-Degraded"],
)

from . import activity


@app.middleware("http")
async def _track_activity(request, call_next):
    # Feed the compute host's idle watchdog. The activity poll itself is
    # excluded so the watchdog doesn't keep the box alive by watching it.
    if request.url.path != "/api/compute/activity":
        activity.touch()
    return await call_next(request)


# Remote-deployment guards (bearer-token gate + compute-only dealing block). No-op
# unless the corresponding env flags are set, which happens only on the remote host.
install_guards(app)

for _module in (markets, trading, state, charts, backtest, compute, strategy, stream, strategies, costs, expr, mt5, agent, patterns, pattern_presets, alerts, admin, shell_auth, demo):
    app.include_router(_module.router)
app.include_router(demo.admin_router)

# MCP endpoint for the Agent UI Bridge. Mounted LAST so it never shadows API
# routes; the guard middleware wraps mounts too, so REQUIRE_API_TOKEN covers it.
app.mount("/mcp", mcp_http_app())
mcp_server.configure_direct_tools(app)


@app.middleware("http")
async def _mcp_exact_path(request, call_next):
    # A Starlette mount only matches paths *under* it, so bare /mcp would get a
    # 307 to /mcp/. Agents configure the URL as http://host:8000/mcp, and not
    # every client re-sends a POST body across a redirect — rewrite the path so
    # the mount serves it directly.
    if request.scope.get("path") == "/mcp":
        request.scope["path"] = "/mcp/"
    return await call_next(request)


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
