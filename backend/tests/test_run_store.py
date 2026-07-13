"""Run store: insert/list/get/delete round-trip + cap pruning, on a temp db."""

import asyncio

from auto_trader.core.run_store import RunStore


def _rec(i, epic="EURUSD"):
    return {
        "id": f"run-{i:03d}", "created_at": 1_000_000 + i,
        "epic": epic, "timeframe": "HOUR",
        "range_from": 1, "range_to": 2,
        "strategy_kind": "rules", "strategy_name": None,
        "request": {"longEntry": {"combine": "AND", "rules": []}},
        "summary": {"net_pnl": float(i), "n_trades": i},
        "trades": [{"pnl": 1.0, "leg": "long"}],
    }


def test_round_trip(tmp_path):
    store = RunStore(str(tmp_path / "runs.db"))
    asyncio.run(store.insert(_rec(1)))

    listed = asyncio.run(store.list())
    assert len(listed) == 1
    assert listed[0]["id"] == "run-001"
    assert listed[0]["summary"]["n_trades"] == 1
    assert "trades" not in listed[0] and "request" not in listed[0]

    full = asyncio.run(store.get("run-001"))
    assert full["trades"] == [{"pnl": 1.0, "leg": "long"}]
    assert full["request"]["longEntry"]["combine"] == "AND"

    asyncio.run(store.delete("run-001"))
    assert asyncio.run(store.get("run-001")) is None
    asyncio.run(store.delete("run-001"))  # idempotent


def test_list_filters_and_orders(tmp_path):
    store = RunStore(str(tmp_path / "runs.db"))
    asyncio.run(store.insert(_rec(1, epic="EURUSD")))
    asyncio.run(store.insert(_rec(2, epic="GBPUSD")))
    asyncio.run(store.insert(_rec(3, epic="EURUSD")))

    eur = asyncio.run(store.list(epic="EURUSD"))
    assert [r["id"] for r in eur] == ["run-003", "run-001"]  # newest first
    assert len(asyncio.run(store.list(limit=2))) == 2


def test_cap_prunes_oldest(tmp_path):
    store = RunStore(str(tmp_path / "runs.db"), cap=3)
    for i in range(5):
        asyncio.run(store.insert(_rec(i)))
    listed = asyncio.run(store.list(limit=10))
    assert [r["id"] for r in listed] == ["run-004", "run-003", "run-002"]
