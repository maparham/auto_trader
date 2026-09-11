"""Cross-user usage counts for the admin console.

THIS MODULE IS THE ONLY PLACE that queries the user-partitioned tables without
a user filter. Import it from auto_trader/api/routers/admin.py and from nowhere
else: every other caller must stay user-scoped through its store module.

It returns COUNTS AND SIZES ONLY. No key names, no values, no alert params, no
run configs. Nothing here can leak one user's content to another.
"""

from __future__ import annotations

import logging
import os
import sqlite3
from dataclasses import dataclass

from auto_trader.config import settings

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class Source:
    """One (db file, table) to count rows in, grouped by user_id.

    field: the output key the count lands on.
    time_col: column to take max() of for lastSeen (None to skip).
    size_col: column whose total length counts toward stateBytes (None to skip).
    """

    path: str
    table: str
    field: str
    time_col: str | None
    size_col: str | None


def _sources() -> tuple[Source, ...]:
    return (
        Source(settings.state_db_path, "app_state", "stateRows", "updated_at", "value"),
        Source(settings.runs_db_path, "runs", "runs", "created_at", None),
        Source(settings.sweeps_db_path, "sweeps", "sweeps", "created_at", None),
        Source(settings.wfo_db_path, "wfo", "wfo", "created_at", None),
        Source(settings.alerts_db_path, "alerts", "alerts", "updated_at", None),
        Source(settings.alerts_db_path, "triggered", "triggered", "time", None),
        Source(
            settings.cost_profiles_db_path,
            "cost_profiles",
            "costProfiles",
            "updated_at",
            None,
        ),
        Source(settings.patterns_db_path, "presets", "patternPresets", "created_at", None),
    )


_SOURCES = _sources()

_FIELDS = (
    "stateRows", "runs", "sweeps", "wfo", "alerts", "triggered",
    "costProfiles", "patternPresets",
)


def _blank(user_id: str) -> dict:
    row = {"userId": user_id, "stateBytes": 0, "lastSeen": None}
    for f in _FIELDS:
        row[f] = 0
    return row


def _scan(src: Source, out: dict[str, dict]) -> None:
    """Fold one source's per-user aggregates into `out`. A missing file, a
    missing table, or a missing column contributes nothing."""
    if not os.path.exists(src.path):
        return
    cols = ["user_id", "COUNT(*)"]
    cols.append(f"MAX({src.time_col})" if src.time_col else "NULL")
    cols.append(f"SUM(LENGTH({src.size_col}))" if src.size_col else "0")
    sql = f"SELECT {', '.join(cols)} FROM {src.table} GROUP BY user_id"
    try:
        conn = sqlite3.connect(f"file:{src.path}?mode=ro", uri=True, timeout=5.0)
    except sqlite3.Error as exc:
        # Logged, never silent: a zero column must be distinguishable from a
        # column this scan could not read (a read-only open can fail on a db
        # nothing has opened since boot).
        log.warning("usage scan could not open %s: %s", src.path, exc)
        return
    try:
        rows = conn.execute(sql).fetchall()
    except sqlite3.Error as exc:
        log.warning("usage scan failed for %s.%s: %s", src.path, src.table, exc)
        return  # table or column absent on this deployment
    finally:
        conn.close()
    for user_id, count, last, size in rows:
        if not isinstance(user_id, str):
            continue
        row = out.setdefault(user_id, _blank(user_id))
        row[src.field] = row.get(src.field, 0) + int(count or 0)
        row["stateBytes"] += int(size or 0)
        if last is not None:
            row["lastSeen"] = max(row["lastSeen"] or 0, int(last))


def collect_usage() -> list[dict]:
    """One row per user id seen in any partitioned table, newest first."""
    out: dict[str, dict] = {}
    for src in _SOURCES:
        _scan(src, out)
    return sorted(out.values(), key=lambda r: (-(r["lastSeen"] or 0), r["userId"]))
