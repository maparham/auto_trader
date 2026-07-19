"""WfoStore: insert (sync + async), summary listing, budgeted fold tables."""
import asyncio

from auto_trader.core.wfo_store import WfoStore


def _rec(i: int, score: float, n_table_rows: int = 3):
    tables = {"s0/f0": [{"combo": {"param:fast": j}, "objective": float(j)}
                        for j in range(n_table_rows)]}
    return {
        "id": f"id{i}", "created_at": 1000 + i, "epic": "TEST",
        "timeframe": "HOUR", "name": None,
        "request": {"walkforward": {"combos": []}},
        "result": {"schemes": [{"robustness": {"robustness_score": score,
                                               "wfe_median": 0.5}}]},
        "fold_tables": tables,
    }


def test_roundtrip_and_summary(tmp_path):
    store = WfoStore(str(tmp_path / "wfo.db"), cap=10)
    store.insert_sync(_rec(1, 72.5))
    rows = asyncio.run(store.list())
    assert rows[0]["id"] == "id1"
    assert rows[0]["robustness_score"] == 72.5
    full = asyncio.run(store.get("id1"))
    assert full["result"]["schemes"]
    assert "fold_tables" not in full
    tables = asyncio.run(store.get_fold_tables("id1"))
    assert "s0/f0" in tables


def test_cap_prunes_oldest(tmp_path):
    store = WfoStore(str(tmp_path / "wfo.db"), cap=2)
    for i in range(4):
        store.insert_sync(_rec(i, 50.0))
    rows = asyncio.run(store.list())
    assert [r["id"] for r in rows] == ["id3", "id2"]


def test_fold_table_budget(tmp_path):
    store = WfoStore(str(tmp_path / "wfo.db"), cap=5)
    rec = _rec(1, 50.0, n_table_rows=60_000)
    store.insert_sync(rec)
    tables = asyncio.run(store.get_fold_tables("id1"))
    assert len(tables["s0/f0"]) == 200
    # Highest objective rows kept.
    assert tables["s0/f0"][0]["objective"] >= 59_800.0
    full = asyncio.run(store.get("id1"))
    assert full["result"]["truncated_tables"] is True
