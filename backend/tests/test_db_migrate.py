"""run_migrations: user_version-gated, per-step transaction, idempotent."""
from __future__ import annotations

import sqlite3

from auto_trader.core.db_migrate import run_migrations, table_columns


def _mem() -> sqlite3.Connection:
    return sqlite3.connect(":memory:")


def test_runs_pending_steps_and_stamps_version():
    conn = _mem()
    calls: list[int] = []
    run_migrations(conn, {1: lambda c: calls.append(1), 2: lambda c: calls.append(2)})
    assert calls == [1, 2]
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 2


def test_skips_already_applied_versions():
    conn = _mem()
    conn.execute("PRAGMA user_version = 1")
    calls: list[int] = []
    run_migrations(conn, {1: lambda c: calls.append(1), 2: lambda c: calls.append(2)})
    assert calls == [2]


def test_noop_when_current():
    conn = _mem()
    conn.execute("PRAGMA user_version = 2")
    run_migrations(conn, {1: lambda c: (_ for _ in ()).throw(AssertionError)})
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 2


def test_failing_step_does_not_stamp():
    conn = _mem()
    conn.execute("CREATE TABLE t (a)")

    def bad(c: sqlite3.Connection) -> None:
        c.execute("INSERT INTO t VALUES (1)")
        raise RuntimeError("boom")

    try:
        run_migrations(conn, {1: bad})
    except RuntimeError:
        pass
    else:
        raise AssertionError("expected RuntimeError")
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM t").fetchone()[0] == 0  # rolled back


def test_failing_step_rolls_back_ddl():
    """Regression: explicit BEGIN ensures DDL (ALTER TABLE) rolls back on failure."""
    conn = _mem()
    conn.execute("CREATE TABLE t (a TEXT)")

    def bad_ddl(c: sqlite3.Connection) -> None:
        c.execute("ALTER TABLE t ADD COLUMN b TEXT")
        raise RuntimeError("boom")

    try:
        run_migrations(conn, {1: bad_ddl})
    except RuntimeError:
        pass
    else:
        raise AssertionError("expected RuntimeError")
    # Verify DDL rolled back: column b should not exist
    assert table_columns(conn, "t") == ["a"]
    # Verify version not stamped
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 0
    # Verify retry succeeds with corrected step
    def good_ddl(c: sqlite3.Connection) -> None:
        c.execute("ALTER TABLE t ADD COLUMN b TEXT")

    run_migrations(conn, {1: good_ddl})
    assert table_columns(conn, "t") == ["a", "b"]
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 1


def test_table_columns():
    conn = _mem()
    conn.execute("CREATE TABLE t (a TEXT, b INTEGER)")
    assert table_columns(conn, "t") == ["a", "b"]
