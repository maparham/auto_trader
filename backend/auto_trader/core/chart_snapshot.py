"""Alert-time live chart screenshot via a persistent headless Chromium.

At fire time this opens the frontend's snapshot boot mode
(/?snapshot=1&broker=..&epic=..&level=..&price=..&token=..) — which rebuilds
the user's last-seen view for the epic from mirrored state with LIVE data —
waits for window.__snapshotReady, and screenshots it. Every failure returns
None so the Telegram layer falls back to the matplotlib image (alert_chart.py)
and then text; nothing here may raise out of render_live_chart.

Playwright is OPTIONAL exactly like matplotlib: imported lazily, feature off
when missing. One browser per process, lazily launched, relaunched on death;
renders are capped at _MAX_CONCURRENT with queueing inside the caller's budget.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import urllib.parse

log = logging.getLogger(__name__)

_TIMEOUT_S = 10.0
_MAX_CONCURRENT = 2
_DEVICE_SCALE = 2  # crisp Telegram photo

_semaphore = asyncio.Semaphore(_MAX_CONCURRENT)
_browser = None  # playwright Browser, lazily launched
_pw = None       # playwright driver handle
_launch_lock = asyncio.Lock()


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
        if payload.get("level") is not None:
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
        log.warning("chart snapshot failed, falling back: %s", exc)
        return None


async def _render_guarded(url: str, width: int, height: int) -> bytes | None:
    async with _semaphore:
        return await _drive_browser(url, width, height, _TIMEOUT_S)


async def _drive_browser(url: str, width: int, height: int, timeout_s: float) -> bytes | None:
    """Open `url` in the persistent headless browser, await __snapshotReady,
    screenshot the chart element. Raises on failure (caller catches)."""
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        log.info("playwright not installed; live snapshot off")
        return None
    global _browser, _pw
    async with _launch_lock:
        if _browser is None or not _browser.is_connected():
            if _pw is None:
                _pw = await async_playwright().start()
            # --no-sandbox: the renderer only ever loads our own frontend
            # (never third-party/untrusted content), and containers run as
            # root, where Chrome's sandbox refuses to start at all.
            _browser = await _pw.chromium.launch(headless=True, args=["--no-sandbox"])
    context = await _browser.new_context(
        viewport={"width": width, "height": height},
        device_scale_factor=_DEVICE_SCALE,
    )
    try:
        page = await context.new_page()
        await page.goto(url, wait_until="domcontentloaded", timeout=timeout_s * 1000)
        await page.wait_for_function(
            "window.__snapshotReady === true || typeof window.__snapshotError === 'string'",
            timeout=timeout_s * 1000,
        )
        err = await page.evaluate("window.__snapshotError ?? null")
        if err is not None:
            raise RuntimeError(f"snapshot page reported: {err}")
        el = await page.query_selector("[data-snapshot-chart]")
        if el is None:
            raise RuntimeError("snapshot chart element missing")
        return await el.screenshot(type="png")
    finally:
        await context.close()
