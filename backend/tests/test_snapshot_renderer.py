"""snapshot_renderer tests. The Playwright drive itself is stubbed, same
convention as test_chart_snapshot.py (snapshot_probe covers the real browser)."""
from fastapi.testclient import TestClient

from auto_trader.snapshot_renderer import app as renderer

client = TestClient(renderer.app)


def test_render_returns_png_on_success(monkeypatch):
    async def fake_drive(url, width, height, timeout_s):
        assert url == "http://x/?snapshot=1"
        assert (width, height, timeout_s) == (1280, 640, 30.0)
        return b"PNG-BYTES"

    monkeypatch.setattr(renderer, "_drive_browser", fake_drive)
    resp = client.post(
        "/render",
        json={"url": "http://x/?snapshot=1", "width": 1280, "height": 640, "timeout_s": 30.0},
    )
    assert resp.status_code == 200
    assert resp.content == b"PNG-BYTES"
    assert resp.headers["content-type"] == "image/png"


def test_render_returns_502_on_failure(monkeypatch):
    async def fake_drive(url, width, height, timeout_s):
        raise RuntimeError("snapshot page reported: boom")

    monkeypatch.setattr(renderer, "_drive_browser", fake_drive)
    resp = client.post("/render", json={"url": "http://x/"})
    assert resp.status_code == 502
    assert "boom" in resp.json()["error"]


def test_render_returns_502_when_chart_missing(monkeypatch):
    async def fake_drive(url, width, height, timeout_s):
        return None

    monkeypatch.setattr(renderer, "_drive_browser", fake_drive)
    resp = client.post("/render", json={"url": "http://x/"})
    assert resp.status_code == 502


def test_render_gives_up_at_the_deadline(monkeypatch):
    import asyncio

    async def slow_drive(url, width, height, timeout_s):
        await asyncio.sleep(5)
        return b"PNG"

    monkeypatch.setattr(renderer, "_drive_browser", slow_drive)
    resp = client.post("/render", json={"url": "http://x/", "timeout_s": 0.1})
    assert resp.status_code == 502
    assert "TimeoutError" in resp.json()["error"]


def test_healthz():
    resp = client.get("/healthz")
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}
