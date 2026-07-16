"""Remote-compute proxy: status probe + a `forward` helper that relays a request
verbatim to the remote compute host.

The remote host is a second copy of this backend deployed on Fly (see guard.py).
The local backend forwards sweep-job submit/poll/cancel to it when the frontend
passes `?target=remote`, so the heavy engine runs off the user's machine. The
forward is UNTOUCHED: no local validation, probe, or job creation happens on the
proxy path (the remote host does all of that).

Env is read PER REQUEST (matching guard.py) so tests can monkeypatch without
reloading the app:
- COMPUTE_HOST_URL   e.g. https://x.fly.dev  (trailing slash stripped)
- COMPUTE_HOST_TOKEN bearer token the remote host's guard expects
"""

from __future__ import annotations

import os

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

URL_ENV = "COMPUTE_HOST_URL"
TOKEN_ENV = "COMPUTE_HOST_TOKEN"

router = APIRouter()


def _config() -> tuple[str, str]:
    """Read (url, token) from env at request time; url has any trailing slash
    stripped so `f"{url}{path}"` never doubles the separator."""
    url = os.environ.get(URL_ENV, "").rstrip("/")
    token = os.environ.get(TOKEN_ENV, "")
    return url, token


@router.get("/api/compute/status")
async def compute_status() -> dict:
    """Whether a remote compute host is configured (both url AND token set). The
    frontend hides the remote toggle when this is False."""
    url, token = _config()
    return {"remoteConfigured": bool(url and token)}


async def forward(
    method: str,
    path: str,
    *,
    json_body: dict | None = None,
    params: dict | None = None,
) -> JSONResponse:
    """Relay one request to the remote compute host and pass its status code +
    JSON body back verbatim.

    The connect timeout is generous (30s) to absorb a Fly cold start; read/write
    are 120s for a long-running submit. Any transport failure (connect refused,
    connect/read/write timeout, network drop) maps to 502 (the host is
    unreachable), a non-JSON upstream body to 502, and an unconfigured host to
    422 (the caller asked for remote but none is set up)."""
    url, token = _config()
    if not (url and token):
        raise HTTPException(422, "remote compute host not configured")

    headers = {"Authorization": f"Bearer {token}"}
    timeout = httpx.Timeout(connect=30.0, read=120.0, write=120.0, pool=30.0)
    try:
        async with httpx.AsyncClient(timeout=timeout) as http:
            upstream = await http.request(
                method, f"{url}{path}", json=json_body, params=params, headers=headers,
            )
    except (httpx.TimeoutException, httpx.TransportError):
        raise HTTPException(502, "remote compute host unreachable") from None

    try:
        content = upstream.json()
    except ValueError:
        raise HTTPException(502, "remote compute host returned a non-JSON response") from None
    return JSONResponse(status_code=upstream.status_code, content=content)
