import asyncio
import sqlite3

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


IND = {"RSI": {"type": "RSI", "calcParams": [14], "extendData": {}}}


def test_indicators_roundtrip(store):
    row = asyncio.run(store.create("u1", {**DATA, "indicators": IND}))
    assert row["indicators"] == IND
    upd = asyncio.run(store.update("u1", row["id"], {**DATA, "indicators": {}}))
    assert upd["indicators"] == {}


def test_missing_indicators_key_stores_empty(store):
    row = asyncio.run(store.create("u1", DATA))
    assert row["indicators"] == {}


def test_source_roundtrip_and_default(store):
    row = asyncio.run(store.create("u1", {**DATA, "source": "allTabs"}))
    assert row["source"] == "allTabs"
    upd = asyncio.run(store.update("u1", row["id"], DATA))
    assert upd["source"] == "list"


def test_old_table_is_migrated(tmp_path):
    path = str(tmp_path / "old.db")
    conn = sqlite3.connect(path)
    conn.executescript("""
    CREATE TABLE screens (
      user_id TEXT NOT NULL, id TEXT NOT NULL,
      name TEXT NOT NULL, broker TEXT NOT NULL, resolution TEXT NOT NULL,
      symbols TEXT NOT NULL, expression TEXT NOT NULL, columns TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, id));
    INSERT INTO screens VALUES ('u1','s1','Old','yfinance','DAY','["AAPL"]','candle.close > 0','[]',1,1);
    """)
    conn.commit()
    conn.close()
    s = ScreenStore(path)
    rows = asyncio.run(s.list("u1"))
    assert rows[0]["id"] == "s1" and rows[0]["indicators"] == {}
    assert rows[0]["source"] == "list" and rows[0]["includeOpenBar"] is False
    upd = asyncio.run(s.update("u1", "s1", {**DATA, "indicators": IND, "source": "allTabs"}))
    assert upd["indicators"] == IND and upd["source"] == "allTabs"
    assert asyncio.run(s.create("u1", DATA))["indicators"] == {}


def test_include_open_bar_roundtrip_and_default(store):
    row = asyncio.run(store.create("u1", {**DATA, "includeOpenBar": True}))
    assert row["includeOpenBar"] is True
    assert asyncio.run(store.update("u1", row["id"], DATA))["includeOpenBar"] is False


LINES = {"L1": {"epic": "AAA", "broker": "b", "timeframe": "HOUR", "t1": 0, "p1": 0.0,
                "t2": 1000, "p2": 10.0, "slope": 0.0, "tRef": 1000, "pRef": 10.0}}


def test_lines_roundtrip(store):
    row = asyncio.run(store.create("u1", {**DATA, "lines": LINES}))
    assert row["lines"] == LINES
    upd = asyncio.run(store.update("u1", row["id"], {**DATA, "lines": {}}))
    assert upd["lines"] == {}


def test_missing_lines_key_stores_empty(store):
    row = asyncio.run(store.create("u1", DATA))
    assert row["lines"] == {}
