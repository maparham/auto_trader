import asyncio

import pytest

from auto_trader.core.cost_profiles import CostProfileStore


@pytest.fixture
def store(tmp_path):
    return CostProfileStore(str(tmp_path / "costs.db"))


def test_roundtrip(store):
    profile = {"spread": 0.8, "slippage": {"kind": "fixed", "value": 0.1, "atrMult": 0},
               "finLongDailyPct": -0.0026, "finShortDailyPct": 0.001,
               "source": "broker"}
    asyncio.run(store.upsert("US100", profile))
    got = asyncio.run(store.get("US100"))
    assert got["spread"] == 0.8 and got["source"] == "broker"
    assert got["slippage"]["kind"] == "fixed"
    assert got["epic"] == "US100" and got["updatedAt"] > 0


def test_missing_epic_is_none(store):
    assert asyncio.run(store.get("NOPE")) is None


def test_upsert_overwrites(store):
    asyncio.run(store.upsert("EURUSD", {"spread": 1.0, "source": "broker"}))
    asyncio.run(store.upsert("EURUSD", {"spread": 2.0, "source": "manual"}))
    got = asyncio.run(store.get("EURUSD"))
    assert got["spread"] == 2.0 and got["source"] == "manual"


def test_corrupt_slippage_json_returns_defaults(store):
    # Write a row with broken slippage_json directly, get() must not raise.
    import sqlite3
    asyncio.run(store.upsert("BAD", {"spread": 1.0, "source": "manual"}))
    with sqlite3.connect(store.db_path) as con:
        con.execute("UPDATE cost_profiles SET slippage_json='{oops' WHERE epic='BAD'")
    got = asyncio.run(store.get("BAD"))
    assert got["slippage"] == {"kind": "fixed", "value": 0.0, "atrMult": 0.0}
