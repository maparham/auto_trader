"""Minimal sqlite migration runner, shared by the user-data stores.

Versioning rides SQLite's built-in `PRAGMA user_version` (an int stored in the
DB header, 0 for every existing file), so no migrations table is needed. Each
store passes {version: step}; every step with version > current runs inside
one transaction and stamps the new version — a failed step rolls back and
leaves the version unstamped, so the next startup retries it.

This replaces the one-off inline pattern in tick_store.py for NEW migrations;
tick_store's own migration is deliberately left as-is.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Callable


def table_columns(conn: sqlite3.Connection, table: str) -> list[str]:
    # table must be a code-controlled name; PRAGMA cannot be parameterized.
    return [r[1] for r in conn.execute(f"PRAGMA table_info({table})")]


def run_migrations(
    conn: sqlite3.Connection,
    steps: dict[int, Callable[[sqlite3.Connection], None]],
) -> None:
    current = conn.execute("PRAGMA user_version").fetchone()[0]
    for version in sorted(steps):
        if version <= current:
            continue
        try:
            # IMMEDIATE serializes concurrent-startup migrations (e.g. two
            # workers booting at once): the loser blocks here, then finds the
            # version already bumped and no-ops via the introspection guards.
            conn.execute("BEGIN IMMEDIATE")
            steps[version](conn)
            # PRAGMA cannot be parameterized; version is an int from our code.
            conn.execute(f"PRAGMA user_version = {int(version)}")
            conn.commit()
        except Exception:
            conn.rollback()
            raise
