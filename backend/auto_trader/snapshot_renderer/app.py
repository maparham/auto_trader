"""Standalone Playwright + Chromium renderer for Telegram alert chart
snapshots, run as its own systemd unit
(deploy/demo/chartkar-snapshot-renderer.service), isolated from
auto-trader-demo.service on purpose.

The Playwright driver subprocess that async_playwright().start() keeps alive
used to live inside the main API process. On 2026-10-20, under box memory
pressure, that driver died and a reconnect attempt forked again; the forked
child segfaulted before exec, and the WHOLE API stopped accepting
connections — not just chart-snapshot traffic — because CPython holds the
GIL across os.fork() (unlike I/O calls, it is not released), so a slow or
crashing fork blocks every unrelated coroutine in the process regardless of
which thread/task triggered it. Running a background thread or process pool
from the main API would not have closed this hole; it would only have made
the fork rarer. Keeping Playwright in its own always-on, independently
systemd-restarted process is the only way a renderer crash can never take
the main API down with it. `chart_snapshot.py` in the main API is now a thin
HTTP client to this service.

One browser per process, launched eagerly at startup (not lazily) so
/healthz reflects real readiness and so a launch failure crashes this
process immediately — systemd's Restart=always then gives a clean relaunch
in 3s instead of the service accumulating stale, half-dead Playwright state.
"""

from __future__ import annotations

import asyncio
import logging
import os

from fastapi import FastAPI
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

log = logging.getLogger(__name__)

_MAX_CONCURRENT = 2
# Scale 1, not 2: the hosted box is memory-tight and a 2x raster of a
# ~1668x866 viewport is a large chunk of Chromium's footprint; Telegram
# compresses photos anyway.
_DEVICE_SCALE = 1

_semaphore = asyncio.Semaphore(_MAX_CONCURRENT)
_browser = None  # playwright Browser
_pw = None  # playwright driver handle
_launch_lock = asyncio.Lock()


class _BrowserUnavailable(Exception):
    """The browser/driver itself could not be (re)established. Fatal for this
    process — the render loop crashes it rather than limping on with broken
    Playwright state; systemd restarts clean."""


async def _ensure_browser() -> None:
    global _browser, _pw
    try:
        from playwright.async_api import async_playwright
    except ImportError as exc:
        raise _BrowserUnavailable("playwright not installed") from exc
    async with _launch_lock:
        if _browser is not None and _browser.is_connected():
            return
        try:
            if _pw is None:
                _pw = await async_playwright().start()
            # --no-sandbox: this renderer only ever loads our own frontend
            # (never third-party/untrusted content), and the box runs as
            # root, where Chrome's sandbox refuses to start at all.
            _browser = await _pw.chromium.launch(headless=True, args=["--no-sandbox"])
        except Exception as exc:
            raise _BrowserUnavailable(repr(exc)) from exc


async def _drive_browser(url: str, width: int, height: int, timeout_s: float) -> bytes | None:
    """Open `url`, await __snapshotReady, screenshot the chart element.
    Raises _BrowserUnavailable if the browser itself is unusable; raises
    plain exceptions for a page-level failure (bad response, missing
    element, timeout) that should fail just this one render."""
    await _ensure_browser()
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


async def _startup() -> None:
    await _ensure_browser()


async def _shutdown() -> None:
    global _browser, _pw
    if _browser is not None:
        await _browser.close()
    if _pw is not None:
        await _pw.stop()


from contextlib import asynccontextmanager


@asynccontextmanager
async def _lifespan(app: FastAPI):
    await _startup()
    try:
        yield
    finally:
        await _shutdown()


app = FastAPI(title="Chartkar snapshot renderer", lifespan=_lifespan)


class RenderRequest(BaseModel):
    url: str
    width: int = 1280
    height: int = 640
    timeout_s: float = 30.0


@app.get("/healthz")
async def healthz():
    ok = _browser is not None and _browser.is_connected()
    return JSONResponse({"ok": ok}, status_code=200 if ok else 503)


@app.post("/render")
async def render(req: RenderRequest):
    async with _semaphore:
        try:
            png = await _drive_browser(req.url, req.width, req.height, req.timeout_s)
        except _BrowserUnavailable as exc:
            log.error(
                "snapshot renderer's browser is unusable, exiting for a clean restart: %r",
                exc,
            )
            # os._exit, not sys.exit/raise: this must actually kill the
            # process immediately so systemd's Restart=always relaunches a
            # fresh one rather than leaving a FastAPI route handler to turn
            # this into just another 500 response.
            os._exit(1)
        except Exception as exc:
            log.warning("snapshot render failed: %r", exc)
            return JSONResponse({"error": repr(exc)}, status_code=502)
    if png is None:
        return JSONResponse({"error": "no chart element"}, status_code=502)
    return Response(content=png, media_type="image/png")
