"""StateStore: key-value round-trip, overwrite, delete, persistence across reopen.

The store is the backend mirror of the frontend's localStorage (one global,
single-user document). Values are stored OPAQUELY as raw strings — these tests use
JSON-ish strings the way the API layer (json.dumps) feeds it, but the store itself
never parses them.
"""

from __future__ import annotations

import asyncio

from auto_trader.core.state_store import StateStore


def test_set_and_get_all(tmp_path):
    store = StateStore(str(tmp_path / "s.db"))
    asyncio.run(store.set("auto-trader.tabs", '[{"id":"t1"}]'))
    asyncio.run(store.set("auto-trader.activeTab", '"t1"'))
    assert asyncio.run(store.get_all()) == {
        "auto-trader.tabs": '[{"id":"t1"}]',
        "auto-trader.activeTab": '"t1"',
    }


def test_empty_store_is_empty_map(tmp_path):
    store = StateStore(str(tmp_path / "s.db"))
    assert asyncio.run(store.get_all()) == {}


def test_set_overwrites_existing_key(tmp_path):
    store = StateStore(str(tmp_path / "s.db"))
    asyncio.run(store.set("k", '"old"'))
    asyncio.run(store.set("k", '"new"'))
    assert asyncio.run(store.get_all()) == {"k": '"new"'}


def test_delete_removes_key(tmp_path):
    store = StateStore(str(tmp_path / "s.db"))
    asyncio.run(store.set("k", '"v"'))
    asyncio.run(store.delete("k"))
    assert asyncio.run(store.get_all()) == {}


def test_delete_missing_key_is_noop(tmp_path):
    store = StateStore(str(tmp_path / "s.db"))
    asyncio.run(store.delete("nope"))  # must not raise
    assert asyncio.run(store.get_all()) == {}


def test_state_survives_reopen(tmp_path):
    path = str(tmp_path / "s.db")
    store = StateStore(path)
    asyncio.run(store.set("auto-trader.tabs", '[{"id":"t1"}]'))
    reopened = StateStore(path)
    assert asyncio.run(reopened.get_all()) == {"auto-trader.tabs": '[{"id":"t1"}]'}
