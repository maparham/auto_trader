import asyncio

from auto_trader.core.demo_store import DemoStore


def test_publish_and_latest(tmp_path):
    store = DemoStore(str(tmp_path / "demo.db"))
    assert asyncio.run(store.latest()) is None
    v1 = asyncio.run(store.publish('{"layout": 1}', "admin@x"))
    v2 = asyncio.run(store.publish('{"layout": 2}', "admin@x"))
    assert (v1, v2) == (1, 2)
    assert asyncio.run(store.latest()) == (2, '{"layout": 2}')


def test_versions_and_get(tmp_path):
    store = DemoStore(str(tmp_path / "demo.db"))
    asyncio.run(store.publish('{"a": 1}', "admin@x"))
    asyncio.run(store.publish('{"a": 2}', "other@x"))
    vs = store.versions_sync()
    assert [v["version"] for v in vs] == [2, 1]
    assert vs[0]["publishedBy"] == "other@x"
    assert asyncio.run(store.get(1)) == '{"a": 1}'
    assert asyncio.run(store.get(99)) is None
