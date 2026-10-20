"""snapshot_renderer tests — the Playwright drive itself is stubbed, same
convention as test_chart_snapshot.py (the real browser is covered by the
snapshot_probe script, not unit tests)."""
import pytest
from fastapi.testclient import TestClient

from auto_trader.snapshot_renderer import app as renderer


def _client(monkeypatch):
    # Skip the real startup browser launch; individual tests stub _drive_browser.
    monkeypatch.setattr(renderer, "_startup", _noop)
    monkeypatch.setattr(renderer, "_shutdown", _noop)
    return TestClient(renderer.app)


async def _noop():
    return None


def test_render_returns_png_on_success(monkeypatch):
    async def fake_drive(url, width, height, timeout_s):
        assert url == "http://x/?snapshot=1"
        assert (width, height, timeout_s) == (1280, 640, 30.0)
        return b"PNG-BYTES"

    monkeypatch.setattr(renderer, "_drive_browser", fake_drive)
    with _client(monkeypatch) as c:
        resp = c.post(
            "/render",
            json={"url": "http://x/?snapshot=1", "width": 1280, "height": 640,
                  "timeout_s": 30.0},
        )
    assert resp.status_code == 200
    assert resp.content == b"PNG-BYTES"
    assert resp.headers["content-type"] == "image/png"


def test_render_returns_502_on_page_level_failure(monkeypatch):
    async def fake_drive(url, width, height, timeout_s):
        raise RuntimeError("snapshot page reported: boom")

    monkeypatch.setattr(renderer, "_drive_browser", fake_drive)
    with _client(monkeypatch) as c:
        resp = c.post("/render", json={"url": "http://x/"})
    assert resp.status_code == 502
    assert "boom" in resp.json()["error"]


@pytest.mark.anyio
async def test_render_exits_process_on_browser_unavailable(monkeypatch):
    # Calls the route function directly rather than through TestClient: the
    # ASGI/anyio machinery can't survive os._exit firing mid-request, which
    # is exactly the point of this path (a clean process kill), so there's
    # nothing meaningful to assert about the HTTP response here.
    async def fake_drive(url, width, height, timeout_s):
        raise renderer._BrowserUnavailable("driver died")

    exits = []

    def fake_exit(code):
        exits.append(code)
        raise SystemExit(code)  # os._exit never returns; model that for the test

    monkeypatch.setattr(renderer, "_drive_browser", fake_drive)
    monkeypatch.setattr(renderer.os, "_exit", fake_exit)
    with pytest.raises(SystemExit):
        await renderer.render(renderer.RenderRequest(url="http://x/"))
    assert exits == [1]


def test_healthz_reports_not_ok_before_browser_launch(monkeypatch):
    monkeypatch.setattr(renderer, "_browser", None)
    with _client(monkeypatch) as c:
        resp = c.get("/healthz")
    assert resp.status_code == 503
    assert resp.json() == {"ok": False}


def test_healthz_reports_ok_once_connected(monkeypatch):
    class FakeBrowser:
        def is_connected(self):
            return True

    monkeypatch.setattr(renderer, "_browser", FakeBrowser())
    with _client(monkeypatch) as c:
        resp = c.get("/healthz")
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}
