"""User pattern presets: saved selections, one sqlite home per user."""
import asyncio

import pytest

from auto_trader.core.pattern_preset_store import PatternPresetStore

BARS = [{"ts": 1000 + i * 60, "o": 1.0, "h": 2.0, "l": 0.5, "c": 1.5} for i in range(20)]


@pytest.fixture
def store(tmp_path):
    return PatternPresetStore(str(tmp_path / "presets.db"))


def test_create_and_list_roundtrip(store):
    row = asyncio.run(store.create("u1", "my flag", "US100", "MINUTE_5", BARS))
    assert row["id"] and row["name"] == "my flag"
    rows = asyncio.run(store.list("u1"))
    assert len(rows) == 1 and rows[0]["bars"] == BARS
    assert rows[0]["epic"] == "US100"


def test_user_isolation(store):
    asyncio.run(store.create("u1", "a", "US100", "DAY", BARS))
    assert asyncio.run(store.list("u2")) == []


def test_rename_and_delete(store):
    row = asyncio.run(store.create("u1", "a", "US100", "DAY", BARS))
    assert asyncio.run(store.rename("u1", row["id"], "b"))
    assert (asyncio.run(store.get("u1", row["id"])))["name"] == "b"
    assert asyncio.run(store.delete("u1", row["id"]))
    assert asyncio.run(store.get("u1", row["id"])) is None
    assert not asyncio.run(store.delete("u1", "missing"))
