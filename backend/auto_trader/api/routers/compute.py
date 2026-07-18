"""Remote-compute proxy: status probe + a `forward` helper that relays a request
verbatim to the remote compute host.

The remote host is a second copy of this backend deployed on EC2 (see guard.py).
The local backend forwards sweep-job submit/poll/cancel to it when the frontend
passes `?target=remote`, so the heavy engine runs off the user's machine. The
forward is UNTOUCHED: no local validation, probe, or job creation happens on the
proxy path (the remote host does all of that).

Config is read PER REQUEST (matching guard.py) so tests can monkeypatch without
reloading the app; process env wins, with `.env` as the fallback source (the
backend never loads `.env` into os.environ, so reading it here is what lets the
documented "add COMPUTE_HOST_* to backend/.env" flow work):
- COMPUTE_HOST_URL   e.g. https://x.fly.dev  (trailing slash stripped)
- COMPUTE_HOST_TOKEN bearer token the remote host's guard expects
"""

from __future__ import annotations

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic_settings import BaseSettings, SettingsConfigDict

URL_ENV = "COMPUTE_HOST_URL"
TOKEN_ENV = "COMPUTE_HOST_TOKEN"

router = APIRouter()


class _ComputeHostSettings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    compute_host_url: str = ""
    compute_host_token: str = ""
    compute_ec2_instance_id: str = ""
    compute_ec2_region: str = "eu-central-1"


def _config() -> tuple[str, str]:
    """Read (url, token) at request time (process env beats .env); url has any
    trailing slash stripped so `f"{url}{path}"` never doubles the separator."""
    cfg = _ComputeHostSettings()
    return cfg.compute_host_url.rstrip("/"), cfg.compute_host_token


@router.get("/api/compute/status")
async def compute_status() -> dict:
    """Whether a remote compute host is configured (both url AND token set). The
    frontend hides the remote toggle when this is False."""
    url, token = _config()
    return {"remoteConfigured": bool(url and token)}


def _ec2_client(region: str):
    """Isolated for test patching; late import keeps boto3 off the hot path."""
    import boto3

    return boto3.client("ec2", region_name=region)


def _probe_activity(url: str, token: str) -> int | None:
    """Probe the app inside the instance. Returns its `activeJobs` count when it
    answers with our token (the instance is then `ready`), else None (still
    booting / unreachable)."""
    try:
        r = httpx.get(
            f"{url}/api/compute/activity",
            headers={"Authorization": f"Bearer {token}"},
            timeout=3.0,
        )
        if r.status_code != 200:
            return None
        return int(r.json().get("activeJobs", 0))
    except (httpx.HTTPError, ValueError):
        return None


def _host_state(start: bool = False, stop: bool = False) -> dict:
    cfg = _ComputeHostSettings()
    instance_id = cfg.compute_ec2_instance_id
    if not instance_id:
        return {"state": "unconfigured", "detail": None, "activeJobs": 0}
    try:
        ec2 = _ec2_client(cfg.compute_ec2_region)
        desc = ec2.describe_instances(InstanceIds=[instance_id])
        ec2_state = desc["Reservations"][0]["Instances"][0]["State"]["Name"]
        if start and ec2_state in ("stopped", "stopping"):
            ec2.start_instances(InstanceIds=[instance_id])
            return {"state": "booting", "detail": None, "activeJobs": 0}
        if stop and ec2_state in ("running", "pending"):
            # Read the state AWS reports back rather than assuming "stopped": the
            # instance is "stopping" now (terminal "stopped" is ~30-60s away), and
            # falling through to the mapping below returns that AWS-confirmed state.
            resp = ec2.stop_instances(InstanceIds=[instance_id])
            ec2_state = resp["StoppingInstances"][0]["CurrentState"]["Name"]
    except Exception as exc:  # boto3's error taxonomy is broad; surface verbatim
        raise HTTPException(502, f"EC2 error: {exc}") from None
    if ec2_state in ("stopped", "stopping"):
        return {"state": "stopped", "detail": None, "activeJobs": 0}
    if ec2_state == "pending":
        return {"state": "booting", "detail": None, "activeJobs": 0}
    if ec2_state == "running":
        url, token = _config()
        jobs = _probe_activity(url, token)
        ready = jobs is not None
        return {
            "state": "ready" if ready else "booting",
            "detail": None,
            "activeJobs": jobs or 0,
        }
    return {"state": "stopped", "detail": f"ec2 state: {ec2_state}", "activeJobs": 0}


@router.get("/api/compute/host")
def compute_host_state() -> dict:
    return _host_state()


@router.post("/api/compute/host/start")
def compute_host_start() -> dict:
    return _host_state(start=True)


@router.post("/api/compute/host/stop")
def compute_host_stop() -> dict:
    """Stop the instance if running (manual button). No job guard here: the
    frontend confirms and warns when a sweep is active; a deliberate stop wins."""
    return _host_state(stop=True)


@router.get("/api/compute/activity")
async def compute_activity() -> dict:
    """Idle signal for the on-box watchdog: running sweep jobs + seconds since
    the last real request. This endpoint itself never counts as activity."""
    from .. import activity
    from ..sweep_jobs import JOBS

    return {
        "activeJobs": JOBS.running_count(),
        "idleSeconds": round(activity.idle_seconds(), 1),
    }


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
