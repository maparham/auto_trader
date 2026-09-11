"""System-health snapshot for the admin console.

Assembled from what the process already knows: no new collectors, no polling,
no writes. Every probe is wrapped so one failure is confined to its own key
instead of failing the whole endpoint.
"""

from __future__ import annotations

import os
import shutil
import time
from typing import Callable

from auto_trader.config import settings

_STARTED = time.time()


def _DB_PATHS() -> dict[str, str]:
    return {
        "app_state": settings.state_db_path,
        "backtest_runs": settings.runs_db_path,
        "backtest_sweeps": settings.sweeps_db_path,
        "backtest_wfo": settings.wfo_db_path,
        "cost_profiles": settings.cost_profiles_db_path,
        "alerts": settings.alerts_db_path,
        "patterns": settings.patterns_db_path,
        "candle_history": settings.candle_db_path,
        "tick_history": settings.tick_db_path,
    }


def _process() -> dict:
    from auto_trader.api.auth import auth_enabled

    return {
        "uptimeSeconds": round(time.time() - _STARTED, 1),
        "pid": os.getpid(),
        "hostedMode": auth_enabled(),
    }


def _idle_seconds() -> float:
    from auto_trader.api import activity

    return round(activity.idle_seconds(), 1)


def _feeds() -> list[dict]:
    from auto_trader.core.alert_engine import ALERT_ENGINE

    return ALERT_ENGINE.feeds_status()


def _alerts() -> dict:
    from auto_trader.core.alert_engine import ALERT_ENGINE

    rows = ALERT_ENGINE.feeds_status()
    return {"armed": sum(r["alerts"] for r in rows), "feeds": len(rows)}


def _brokers() -> dict:
    from auto_trader.api import deps
    from auto_trader.brokers.registry import RESTRICTED_BROKER_IDS

    reg = deps._registry
    if reg is None:
        return {
            "registered": [],
            "restricted": sorted(RESTRICTED_BROKER_IDS),
            "default": None,
        }
    described = reg.describe(include_restricted=True)
    return {
        "registered": sorted(described.get("data", {})),
        "restricted": sorted(RESTRICTED_BROKER_IDS),
        "default": reg.default_data_id(),
    }


def _databases() -> list[dict]:
    rows = []
    for name, path in _DB_PATHS().items():
        exists = os.path.exists(path)
        rows.append(
            {
                "name": name,
                "path": path,
                "exists": exists,
                "bytes": os.path.getsize(path) if exists else 0,
            }
        )
    return rows


def _disk() -> dict:
    target = os.path.dirname(os.path.abspath(settings.state_db_path)) or "."
    usage = shutil.disk_usage(target)
    return {"path": target, "totalBytes": usage.total, "freeBytes": usage.free}


def _snapshot() -> dict:
    return {
        "enabled": not os.environ.get("SNAPSHOT_DISABLED"),
        "frontendUrl": os.environ.get("FRONTEND_URL") or None,
    }


def _safe(fn: Callable):
    try:
        return fn()
    except Exception as exc:  # one bad probe must not blank the panel
        return {"error": str(exc)}


def collect_health() -> dict:
    return {
        "process": _safe(_process),
        "idleSeconds": _safe(_idle_seconds),
        "feeds": _safe(_feeds),
        "alerts": _safe(_alerts),
        "brokers": _safe(_brokers),
        "databases": _safe(_databases),
        "disk": _safe(_disk),
        "snapshot": _safe(_snapshot),
    }
