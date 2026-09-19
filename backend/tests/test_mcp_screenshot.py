import base64

import pytest

from auto_trader.api import mcp_server


class FakeHub:
    def __init__(self, result=None, exc=None):
        self.result = result
        self.exc = exc
        self.calls = []

    async def request(self, kind, payload, session_id=None):
        self.calls.append((kind, payload, session_id))
        if self.exc:
            raise self.exc
        return self.result

    def title_of(self, session_id=None):
        # The title gate runs before the request; a missing tab surfaces here.
        from auto_trader.api.agent_bridge import NoTabError
        if isinstance(self.exc, NoTabError):
            raise self.exc
        return "🤖 test"


@pytest.mark.anyio
async def test_ui_screenshot_returns_image_block(monkeypatch):
    png = base64.b64encode(b"\x89PNG fake").decode()
    hub = FakeHub(result={
        "epic": "US100", "cellId": "c1", "resolution": "HOUR",
        "mime": "image/png", "image_base64": png, "via": "extension",
    })
    monkeypatch.setattr(mcp_server, "HUB", hub)
    blocks = await mcp_server.ui_screenshot()
    image = next(b for b in blocks if getattr(b, "type", "") == "image")
    text = next(b for b in blocks if getattr(b, "type", "") == "text")
    assert image.data == png
    assert image.mime_type == "image/png"
    assert "US100" in text.text and "HOUR" in text.text
    assert "via extension" in text.text
    # It must go through the readOnly invoke path:
    kind, payload, _ = hub.calls[0]
    assert kind == "invoke"
    assert payload == {"action": "chart.screenshot", "args": {}, "readOnly": True}


@pytest.mark.anyio
async def test_ui_screenshot_no_tab_is_friendly(monkeypatch):
    from auto_trader.api.agent_bridge import NoTabError
    monkeypatch.setattr(mcp_server, "HUB", FakeHub(exc=NoTabError("no UI session connected")))
    with pytest.raises(RuntimeError, match="no UI session"):
        await mcp_server.ui_screenshot()
