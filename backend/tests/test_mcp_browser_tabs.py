"""Browser tab control MCP tools (ui_focus_tab / ui_open_tab / ui_close_tab).

The AppleScript layer is faked: tests monkeypatch mcp_server._osascript and
assert on the parsed results and the guards, not on real Chrome.
"""
import pytest

from auto_trader.api import mcp_server

URL = "http://localhost:5173"


def fake_osascript(*replies):
    calls = []

    async def run(script: str) -> str:
        calls.append(script)
        return replies[min(len(calls) - 1, len(replies) - 1)]

    run.calls = calls
    return run


@pytest.fixture(autouse=True)
def _macos(monkeypatch):
    monkeypatch.setattr(mcp_server, "_IS_MACOS", True)
    monkeypatch.delenv("CLERK_JWKS_URL", raising=False)
    monkeypatch.delenv("FRONTEND_URL", raising=False)


@pytest.mark.anyio
async def test_focus_tab_found(monkeypatch):
    monkeypatch.setattr(mcp_server, "_osascript", fake_osascript(f"FOCUSED:{URL}/"))
    res = await mcp_server.ui_focus_tab()
    assert res == {"focused": f"{URL}/"}


@pytest.mark.anyio
async def test_focus_tab_missing_points_at_open(monkeypatch):
    monkeypatch.setattr(mcp_server, "_osascript", fake_osascript("NONE"))
    with pytest.raises(RuntimeError, match="ui_open_tab"):
        await mcp_server.ui_focus_tab()


@pytest.mark.anyio
async def test_open_tab_is_idempotent_when_tab_exists(monkeypatch):
    run = fake_osascript(f"FOCUSED:{URL}/")
    monkeypatch.setattr(mcp_server, "_osascript", run)
    res = await mcp_server.ui_open_tab()
    assert res == {"focused": f"{URL}/"}
    assert len(run.calls) == 1  # never reached the open script


@pytest.mark.anyio
async def test_open_tab_opens_when_missing(monkeypatch):
    run = fake_osascript("NONE", "OPENED")
    monkeypatch.setattr(mcp_server, "_osascript", run)
    res = await mcp_server.ui_open_tab()
    assert res == {"opened": URL}
    assert len(run.calls) == 2


@pytest.mark.anyio
async def test_close_tab_single(monkeypatch):
    monkeypatch.setattr(mcp_server, "_osascript", fake_osascript("CLOSED"))
    res = await mcp_server.ui_close_tab()
    assert res == {"closed": URL}


@pytest.mark.anyio
async def test_close_tab_refuses_zero_and_many(monkeypatch):
    monkeypatch.setattr(mcp_server, "_osascript", fake_osascript("NONE"))
    with pytest.raises(RuntimeError, match="no Chartkar tab"):
        await mcp_server.ui_close_tab()
    monkeypatch.setattr(mcp_server, "_osascript", fake_osascript("MANY:3"))
    with pytest.raises(RuntimeError, match="3"):
        await mcp_server.ui_close_tab()


@pytest.mark.anyio
async def test_requires_macos(monkeypatch):
    monkeypatch.setattr(mcp_server, "_IS_MACOS", False)
    with pytest.raises(RuntimeError, match="macOS"):
        await mcp_server.ui_focus_tab()


@pytest.mark.anyio
async def test_refused_in_hosted_mode(monkeypatch):
    monkeypatch.setenv("CLERK_JWKS_URL", "https://clerk.example/jwks")
    with pytest.raises(RuntimeError, match="local"):
        await mcp_server.ui_focus_tab()


@pytest.mark.anyio
async def test_rejects_unsafe_frontend_url(monkeypatch):
    monkeypatch.setenv("FRONTEND_URL", 'http://x" & do shell script "echo pwn')
    monkeypatch.setattr(mcp_server, "_osascript", fake_osascript("NONE"))
    with pytest.raises(RuntimeError, match="FRONTEND_URL"):
        await mcp_server.ui_focus_tab()
