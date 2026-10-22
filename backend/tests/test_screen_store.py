import asyncio

import pytest

from auto_trader.core.screen_store import ScreenStore

DATA = {"name": "Oversold", "broker": "yfinance", "resolution": "DAY",
        "symbols": ["AAPL", "MSFT"], "expression": "RSI(14) < 30",
        "columns": [{"name": "RSI", "expression": "RSI(14)"}]}


@pytest.fixture
def store(tmp_path):
    return ScreenStore(str(tmp_path / "screens.db"))


def test_create_get_list(store):
    row = asyncio.run(store.create("u1", DATA))
    assert row["id"] and row["symbols"] == ["AAPL", "MSFT"]
    assert asyncio.run(store.get("u1", row["id"]))["columns"] == DATA["columns"]
    assert [r["id"] for r in asyncio.run(store.list("u1"))] == [row["id"]]


def test_user_isolation(store):
    row = asyncio.run(store.create("u1", DATA))
    assert asyncio.run(store.get("u2", row["id"])) is None
    assert asyncio.run(store.list("u2")) == []
    assert asyncio.run(store.delete("u2", row["id"])) is False


def test_update_and_delete(store):
    row = asyncio.run(store.create("u1", DATA))
    upd = asyncio.run(store.update("u1", row["id"], {**DATA, "name": "Renamed"}))
    assert upd["name"] == "Renamed" and upd["updated_at"] >= row["updated_at"]
    assert asyncio.run(store.update("u1", "nope", DATA)) is None
    assert asyncio.run(store.delete("u1", row["id"])) is True
    assert asyncio.run(store.get("u1", row["id"])) is None
