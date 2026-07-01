import asyncio

from auto_trader.core.tick_store import TickStore


def test_record_and_latest_are_broker_isolated(tmp_path):
    ts = TickStore(str(tmp_path / "t.db"))
    ts.record("capital", "GOLD", 1000, 100.0)
    ts.record("capital-live", "GOLD", 1000, 200.0)
    assert ts.latest("capital", "GOLD") == (1000, 100.0)
    assert ts.latest("capital-live", "GOLD") == (1000, 200.0)
    assert ts.latest("capital", "SILVER") is None


def test_bars_are_broker_isolated(tmp_path):
    ts = TickStore(str(tmp_path / "t.db"))
    for i in range(3):
        ts.record("capital", "GOLD", 1000 + i * 1000, 100.0 + i)
        ts.record("capital-live", "GOLD", 1000 + i * 1000, 200.0 + i)
    asyncio.run(ts.flush())
    demo = asyncio.run(ts.bars("capital", "GOLD", 1, 10))
    live = asyncio.run(ts.bars("capital-live", "GOLD", 1, 10))
    assert all(b.close < 150 for b in demo)
    assert all(b.close > 150 for b in live)
