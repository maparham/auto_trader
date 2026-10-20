"""Standalone Playwright + Chromium renderer for Telegram alert chart
snapshots, run as its own systemd unit
(deploy/demo/chartkar-snapshot-renderer.service), isolated from
auto-trader-demo.service on purpose.

The Playwright driver subprocess used to live inside the main API process.
On 2026-10-20, under box memory pressure, that driver died and a reconnect
attempt forked again; the forked child segfaulted before exec, and the WHOLE
API stopped accepting connections, because CPython holds the GIL across
os.fork(), so one bad fork blocks every unrelated request in the process.
Keeping Playwright in its own process means a renderer crash can never take
the main API down with it. `chart_snapshot.py` is a thin HTTP client to this.

Driver and browser are started per render and torn down after it, never
kept resident. Renders only happen when an alert fires, and a resident
Chromium held ~470MB on a 1GB box, pushing the API into swap so every chart
load crawled. Per-render launch costs a couple of seconds inside a 30s budget
and leaves no long-lived Playwright state to go stale.
"""

from __future__ import annotations

import asyncio
import logging

from fastapi import FastAPI
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

log = logging.getLogger(__name__)

# One at a time: each render now launches its own Chromium, and two at once
# on this box would double the peak footprint.
_MAX_CONCURRENT = 1
# Scale 1, not 2: the hosted box is memory-tight and a 2x raster of a
# ~1668x866 viewport is a large chunk of Chromium's footprint; Telegram
# compresses photos anyway.
_DEVICE_SCALE = 1
# --no-sandbox: this renderer only ever loads our own frontend. --disable-gpu:
# the chart is canvas 2D, and the swiftshader GPU process alone held ~150MB.
_LAUNCH_ARGS = ["--no-sandbox", "--disable-gpu"]

_semaphore = asyncio.Semaphore(_MAX_CONCURRENT)


async def _drive_browser(url: str, width: int, height: int, timeout_s: float) -> bytes | None:
    """Launch a browser, open `url`, await __snapshotReady, screenshot the
    chart element, close everything. Raises on failure."""
    from playwright.async_api import async_playwright

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True, args=_LAUNCH_ARGS)
        try:
            page = await browser.new_page(
                viewport={"width": width, "height": height},
                device_scale_factor=_DEVICE_SCALE,
            )
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
            await browser.close()


app = FastAPI(title="Chartkar snapshot renderer")


class RenderRequest(BaseModel):
    url: str
    width: int = 1280
    height: int = 640
    timeout_s: float = 30.0


@app.get("/healthz")
async def healthz():
    return {"ok": True}


@app.post("/render")
async def render(req: RenderRequest):
    async with _semaphore:
        try:
            png = await _drive_browser(req.url, req.width, req.height, req.timeout_s)
        except Exception as exc:
            log.warning("snapshot render failed: %r", exc)
            return JSONResponse({"error": repr(exc)}, status_code=502)
    if png is None:
        return JSONResponse({"error": "no chart element"}, status_code=502)
    return Response(content=png, media_type="image/png")
