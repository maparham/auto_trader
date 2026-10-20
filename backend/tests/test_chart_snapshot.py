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


async def test_drive_browser_posts_to_renderer_and_returns_png(monkeypatch):
    import httpx

    seen = {}

    async def fake_post(self, url, json=None):
        seen.update(url=url, json=json)
        return httpx.Response(200, content=b"PNG-BYTES", request=httpx.Request("POST", url))

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)
    png = await cs._drive_browser("http://x/?snapshot=1", 1280, 640, 30.0)
    assert png == b"PNG-BYTES"
    assert seen["url"] == f"{cs._RENDERER_URL}/render"
    assert seen["json"] == {
        "url": "http://x/?snapshot=1", "width": 1280, "height": 640, "timeout_s": 30.0,
    }


async def test_drive_browser_raises_when_renderer_unreachable(monkeypatch):
    import httpx

    async def fake_post(self, url, json=None):
        raise httpx.ConnectError("refused")

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)
    with pytest.raises(httpx.ConnectError):
        await cs._drive_browser("http://x/?snapshot=1", 1280, 640, 30.0)


async def test_drive_browser_raises_on_renderer_error_status(monkeypatch):
    import httpx

    async def fake_post(self, url, json=None):
        return httpx.Response(
            502, json={"error": "no chart element"}, request=httpx.Request("POST", url)
        )

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)
    with pytest.raises(httpx.HTTPStatusError):
        await cs._drive_browser("http://x/?snapshot=1", 1280, 640, 30.0)


async def test_value_target_alert_skips_the_level_param(monkeypatch):
    # An RSI-70 alert's "level" is 70, not a price: the live snapshot must
    # not draw it as a horizontal price line (SnapshotApp.tsx's armReady
    # draws whatever `level` it's given, with no target-awareness).
    rows = {("u1", "auto-trader.b.capital.view.US100"): json.dumps(HEARTBEAT)}
    monkeypatch.setattr(cs, "_state_store", lambda: FakeStore(rows))
    seen = {}

    async def fake_drive(url, width, height, timeout_s):
        seen.update(url=url)
        return b"PNG"

    monkeypatch.setattr(cs, "_drive_browser", fake_drive)
    monkeypatch.setattr(cs, "_mint_token", lambda user_id: None)
    payload = {**PAYLOAD, "level": 70.0, "target": "value", "label": "RSI 14 (1H)"}
    await cs.render_live_chart("u1", payload)
    assert "level=" not in seen["url"]
