"""chart_snapshot tests — the Playwright drive itself is stubbed (probe covers it)."""
import json

import pytest

from auto_trader.core import chart_snapshot as cs

pytestmark = pytest.mark.anyio


class FakeStore:
    def __init__(self, rows):  # rows: {(user, key): value-json-str}
        self.rows = rows

    async def get(self, user_id, key):
        return self.rows.get((user_id, key))


HEARTBEAT = {
    "scope": "tab.t1.cell.c1", "epic": "US100", "broker": "capital",
    "resolution": "MINUTE_5", "symbol": {"epic": "US100", "name": "US 100", "status": None},
    "barSpace": 8, "width": 1280, "height": 640, "updatedAt": 1,
}
PAYLOAD = {"broker": "capital", "epic": "US100", "level": 20000.5, "price": 20001.0}


async def test_no_heartbeat_returns_none(monkeypatch):
    monkeypatch.setattr(cs, "_state_store", lambda: FakeStore({}))
    assert await cs.render_live_chart("u1", PAYLOAD) is None


async def test_malformed_heartbeat_returns_none(monkeypatch):
    rows = {("u1", "auto-trader.b.capital.view.US100"): '{"nope": 1}'}
    monkeypatch.setattr(cs, "_state_store", lambda: FakeStore(rows))
    assert await cs.render_live_chart("u1", PAYLOAD) is None


async def test_disabled_by_env(monkeypatch):
    monkeypatch.setenv("SNAPSHOT_DISABLED", "1")
    assert await cs.render_live_chart("u1", PAYLOAD) is None


async def test_happy_path_drives_browser(monkeypatch):
    rows = {("u1", "auto-trader.b.capital.view.US100"): json.dumps(HEARTBEAT)}
    monkeypatch.setattr(cs, "_state_store", lambda: FakeStore(rows))
    seen = {}

    async def fake_drive(url, width, height, timeout_s):
        seen.update(url=url, width=width, height=height)
        return b"PNG"

    monkeypatch.setattr(cs, "_drive_browser", fake_drive)
    monkeypatch.setattr(cs, "_mint_token", lambda user_id: "tok" if user_id == "u1" else None)
    png = await cs.render_live_chart("u1", PAYLOAD)
    assert png == b"PNG"
    assert seen["width"] == 1280 and seen["height"] == 640
    assert "snapshot=1" in seen["url"] and "epic=US100" in seen["url"]
    assert "level=20000.5" in seen["url"] and "token=tok" in seen["url"]


async def test_drive_failure_returns_none(monkeypatch):
    rows = {("u1", "auto-trader.b.capital.view.US100"): json.dumps(HEARTBEAT)}
    monkeypatch.setattr(cs, "_state_store", lambda: FakeStore(rows))

    async def boom(url, width, height, timeout_s):
        raise RuntimeError("browser died")

    monkeypatch.setattr(cs, "_drive_browser", boom)
    assert await cs.render_live_chart("u1", PAYLOAD) is None
