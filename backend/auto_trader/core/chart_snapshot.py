"""Alert-time live chart screenshot, rendered by the standalone
snapshot-renderer service (auto_trader.snapshot_renderer, its own systemd
unit: deploy/demo/chartkar-snapshot-renderer.service).

At fire time this opens the frontend's snapshot boot mode
(/?snapshot=1&broker=..&epic=..&level=..&price=..&token=..) — which rebuilds
the user's last-seen view for the epic from mirrored state with LIVE data —
and asks the renderer to screenshot it. Every failure returns None so the
Telegram layer falls back to the matplotlib image (alert_chart.py) and then
text; nothing here may raise out of render_live_chart.

This module used to run Playwright in-process. On 2026-10-20 the in-process
driver died under memory pressure, a forked child of the API segfaulted, and
the whole API stopped answering; see auto_trader/snapshot_renderer/app.py.
This module is now an HTTP client with a hard timeout, so an unreachable or
hung renderer degrades to "return None" like any other failure here.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import urllib.parse

log = logging.getLogger(__name__)

# Whole-render budget: renderer call (browser/page work) + its own network
# round-trip. Cold capital-live fetches on the hosted box routinely exceed
# 10s, which made every live snapshot time out and fall back to matplotlib;
# the page's own data wait (SnapshotApp) gives up at 25s, inside this cap.
_TIMEOUT_S = 30.0

_RENDERER_URL = os.environ.get("SNAPSHOT_RENDERER_URL", "http://127.0.0.1:9223").rstrip("/")


def _frontend_url() -> str:
    return os.environ.get("FRONTEND_URL", "http://localhost:5173").rstrip("/")


def _state_store():
    # Indirection (not a top-level import of the singleton) so tests swap it.
    from auto_trader.core.state_store import STATE_STORE

    return STATE_STORE


def _mint_token(user_id: str) -> str | None:
    """Render token in hosted mode; None in local dev (auth off, no token needed)."""
    from auto_trader.api.auth import auth_enabled, mint_render_token

    return mint_render_token(user_id) if auth_enabled() else None


async def render_live_chart(user_id: str, payload: dict) -> bytes | None:
    """PNG of the user's live chart for a firing, or None on ANY failure."""
    if os.environ.get("SNAPSHOT_DISABLED"):
        return None
    try:
        broker, epic = payload["broker"], payload["epic"]
        raw = await _state_store().get(user_id, f"auto-trader.b.{broker}.view.{epic}")
        if raw is None:
            return None
        desc = json.loads(raw)
        if not isinstance(desc, dict) or not desc.get("scope"):
            return None
        width = int(desc.get("width") or 1280)
        height = int(desc.get("height") or 640)
        q: dict[str, str] = {"snapshot": "1", "broker": broker, "epic": epic}
        if payload.get("level") is not None and payload.get("target") != "value":
            q["level"] = str(payload["level"])
        if payload.get("price") is not None:
            q["price"] = str(payload["price"])
        token = _mint_token(user_id)
        if token:
            q["token"] = token
        url = f"{_frontend_url()}/?{urllib.parse.urlencode(q)}"
        return await asyncio.wait_for(
            _render_guarded(url, width, height), timeout=_TIMEOUT_S
        )
    except Exception as exc:
        # repr, not str: asyncio.TimeoutError stringifies to "" and the line
        # used to read "falling back: " with no cause at all.
        log.warning("chart snapshot failed, falling back: %r", exc)
        return None


async def _render_guarded(url: str, width: int, height: int) -> bytes | None:
    return await _drive_browser(url, width, height, _TIMEOUT_S)


async def _drive_browser(url: str, width: int, height: int, timeout_s: float) -> bytes | None:
    """Ask the standalone snapshot-renderer service to screenshot `url`.
    Raises on failure (caller catches) exactly like the old in-process
    implementation did, so render_live_chart's contract is unchanged."""
    import httpx

    async with httpx.AsyncClient(timeout=timeout_s + 5) as client:
        resp = await client.post(
            f"{_RENDERER_URL}/render",
            json={"url": url, "width": width, "height": height, "timeout_s": timeout_s},
        )
    resp.raise_for_status()
    return resp.content
