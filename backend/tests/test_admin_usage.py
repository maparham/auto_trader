"""collect_usage(): cross-user counts, no content, missing files tolerated."""
from __future__ import annotations

import sqlite3

import pytest

from auto_trader.core import admin_usage


def _seed(path, ddl: str, rows: list[tuple], insert: str) -> None:
    conn = sqlite3.connect(path)
    conn.execute(ddl)
    conn.executemany(insert, rows)
    conn.commit()
    conn.close()


@pytest.fixture()
def dbs(tmp_path, monkeypatch):
    # Distinct names: conftest's autouse store fixtures already own
    # app_state.db / runs.db inside this same tmp_path.
    state = tmp_path / "usage_state.db"
    runs = tmp_path / "usage_runs.db"
    _seed(
        state,
        "CREATE TABLE app_state (user_id TEXT NOT NULL, key TEXT NOT NULL, "
        "value TEXT NOT NULL, updated_at INTEGER)",
        [("u1", "k1", "abcde", 1000), ("u1", "k2", "xy", 2000), ("u2", "k1", "z", 500)],
        "INSERT INTO app_state VALUES (?,?,?,?)",
    )
    _seed(
        runs,
        "CREATE TABLE runs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER)",
        [("r1", "u1", 3000), ("r2", "u2", 400)],
        "INSERT INTO runs VALUES (?,?,?)",
    )
    monkeypatch.setattr(
        admin_usage,
        "_SOURCES",
        (
            admin_usage.Source(str(state), "app_state", "stateRows", "updated_at", "value"),
            admin_usage.Source(str(runs), "runs", "runs", "created_at", None),
        ),
    )
    return tmp_path


def test_rows_per_user_with_counts(dbs):
    rows = {r["userId"]: r for r in admin_usage.collect_usage()}
    assert set(rows) == {"u1", "u2"}
    assert rows["u1"]["stateRows"] == 2
    assert rows["u1"]["stateBytes"] == 7  # "abcde" + "xy"
    assert rows["u1"]["runs"] == 1
    assert rows["u2"]["stateRows"] == 1


def test_last_seen_is_the_max_timestamp(dbs):
    rows = {r["userId"]: r for r in admin_usage.collect_usage()}
    assert rows["u1"]["lastSeen"] == 3000
    assert rows["u2"]["lastSeen"] == 500


def test_sorted_by_last_seen_desc(dbs):
    assert [r["userId"] for r in admin_usage.collect_usage()] == ["u1", "u2"]


def test_no_user_content_in_rows(dbs):
    row = admin_usage.collect_usage()[0]
    assert "abcde" not in str(row) and "k1" not in str(row)
    assert set(row) == {
        "userId", "stateRows", "stateBytes", "runs", "sweeps", "wfo", "alerts",
        "triggered", "costProfiles", "patternPresets", "lastSeen",
    }


def test_missing_db_file_is_empty_not_an_error(tmp_path, monkeypatch):
    monkeypatch.setattr(
        admin_usage,
        "_SOURCES",
        (admin_usage.Source(str(tmp_path / "nope.db"), "runs", "runs", "created_at", None),),
    )
    assert admin_usage.collect_usage() == []


def test_missing_table_is_empty_not_an_error(tmp_path, monkeypatch):
    path = tmp_path / "empty.db"
    sqlite3.connect(path).close()
    monkeypatch.setattr(
        admin_usage,
        "_SOURCES",
        (admin_usage.Source(str(path), "runs", "runs", "created_at", None),),
    )
    assert admin_usage.collect_usage() == []
