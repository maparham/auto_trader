"""Browser tab control MCP tools (ui_focus_tab / ui_open_tab / ui_close_tab).

The AppleScript layer is faked: tests monkeypatch mcp_server._osascript and
assert on the parsed results and the guards, not on real Chrome.
"""
import pytest

from auto_trader.api import mcp_server
from auto_trader.api.agent_bridge import ActionFailedError, NoTabError

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


class _Hub:
    def __init__(self, result=None, exc=None):
        self.result, self.exc, self.calls = result, exc, []

    async def request(self, kind, payload, session_id=None):
        self.calls.append((kind, payload))
        if self.exc:
            raise self.exc
        return self.result


@pytest.mark.anyio
async def test_focus_tab_prefers_the_extension(monkeypatch):
    hub = _Hub(result={"focused": True})
    monkeypatch.setattr(mcp_server, "HUB", hub)
    run = fake_osascript("FOCUSED:should-not-run")
    monkeypatch.setattr(mcp_server, "_osascript", run)
    res = await mcp_server.ui_focus_tab()
    assert res == {"focused": "extension"}
    assert hub.calls == [("invoke", {"action": "tab.focus", "args": {}})]
    assert run.calls == []


@pytest.mark.anyio
async def test_focus_tab_falls_back_to_applescript_without_extension(monkeypatch):
    monkeypatch.setattr(mcp_server, "HUB", _Hub(exc=ActionFailedError("NO_EXTENSION", "not installed")))
    monkeypatch.setattr(mcp_server, "_osascript", fake_osascript(f"FOCUSED:{URL}/"))
    res = await mcp_server.ui_focus_tab()
    assert res == {"focused": f"{URL}/"}


@pytest.mark.anyio
async def test_focus_tab_falls_back_to_applescript_with_no_tab(monkeypatch):
    monkeypatch.setattr(mcp_server, "HUB", _Hub(exc=NoTabError()))
    monkeypatch.setattr(mcp_server, "_osascript", fake_osascript("NONE"))
    with pytest.raises(RuntimeError, match="ui_open_tab"):
        await mcp_server.ui_focus_tab()


@pytest.mark.anyio
async def test_focus_tab_off_macos_without_extension_names_it(monkeypatch):
    monkeypatch.setattr(mcp_server, "_IS_MACOS", False)
    monkeypatch.setattr(mcp_server, "HUB", _Hub(exc=ActionFailedError("NO_EXTENSION", "not installed")))
    with pytest.raises(RuntimeError, match="Tab Bridge extension"):
        await mcp_server.ui_focus_tab()
