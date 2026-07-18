# EC2 Compute Host Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Fly.io compute host with an EC2 c8a.16xlarge that the user starts from the UI and that shuts itself down when idle.

**Architecture:** The remote host stays what it is today: the same backend image, token-gated, `COMPUTE_ONLY=1`, reached through the existing `forward()` proxy. What changes: (1) the box is an EC2 instance behind an Elastic IP with the security group locked to the user's IP; (2) the local backend gains two small lifecycle endpoints (start + state) backed by boto3; (3) the compute host gains an activity endpoint that an on-box systemd watchdog polls to `shutdown -h` after 15 idle minutes; (4) `scripts/` gains provision / deploy / allow-me shell scripts replacing `fly deploy`.

**Tech Stack:** FastAPI + boto3 (new backend dep), React/TS frontend, Docker + systemd on Amazon Linux 2023, AWS CLI for provisioning.

**Spec:** `docs/superpowers/specs/2026-07-18-ec2-compute-host-design.md`

## Global Constraints

- Instance: `c8a.16xlarge`, on-demand, region `eu-central-1`, AL2023 x86_64, 20 GB gp3 root volume.
- Transport: plain HTTP on port 8000; security group restricted to the user's public IP; no TLS, no domain.
- Idle watchdog: 15 min idle threshold, 10 min boot grace, never stops while a job runs. Lives on the instance, not in the local backend.
- Env names: `COMPUTE_HOST_URL`, `COMPUTE_HOST_TOKEN` (existing, unchanged), `COMPUTE_EC2_INSTANCE_ID`, `COMPUTE_EC2_REGION` (new, local backend only).
- Config is read per request via `pydantic_settings.BaseSettings` with `.env` fallback, matching `backend/auto_trader/api/routers/compute.py`.
- No dual-host support: Fly is destroyed at the end, `fly.toml` removed.
- Backend tests: `cd backend && uv run pytest`. Frontend tests: `cd frontend && npx vitest run <file>`.
- Commit directly to `main` after each task.

---

### Task 1: Compute-host activity endpoint + request tracking

The watchdog needs one signal: "is anything using this host?" That is (a) a running sweep job, (b) any recent API request (someone polling results or fetching prices counts as activity). Requests to the activity endpoint itself must NOT count, or the watchdog keeps the box alive forever.

**Files:**
- Create: `backend/auto_trader/api/activity.py`
- Modify: `backend/auto_trader/api/routers/compute.py` (add endpoint)
- Modify: `backend/auto_trader/api/app.py` (register middleware)
- Test: `backend/tests/test_api_compute_activity.py`

**Interfaces:**
- Produces: `GET /api/compute/activity` → `{"activeJobs": int, "idleSeconds": float}`. `idleSeconds` is seconds since the last non-activity request (0.0 right after any request). Consumed by the watchdog (Task 4) and the local `ready` probe (Task 2).
- Produces: `activity.touch()` / `activity.snapshot() -> tuple[int, float]` module functions.

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_api_compute_activity.py
"""Activity endpoint: idleSeconds resets on real requests but not on activity
polls; activeJobs mirrors sweep_jobs.JOBS."""
import time

from fastapi.testclient import TestClient

from auto_trader.api import activity
from auto_trader.api.app import app


def test_activity_reports_idle_and_jobs(monkeypatch):
    client = TestClient(app)
    # A real request marks the host active.
    client.get("/api/compute/status")
    body = client.get("/api/compute/activity").json()
    assert body["activeJobs"] == 0
    assert body["idleSeconds"] < 1.0

    # Polling /api/compute/activity does NOT reset the idle clock.
    activity._last_request = time.monotonic() - 100.0
    body = client.get("/api/compute/activity").json()
    assert body["idleSeconds"] > 99.0


def test_activity_counts_running_jobs(monkeypatch):
    from auto_trader.api import sweep_jobs

    class _Job:
        running = True

    monkeypatch.setattr(sweep_jobs.JOBS, "_jobs", {"x": _Job()}, raising=False)
    client = TestClient(app)
    body = client.get("/api/compute/activity").json()
    assert body["activeJobs"] == 1
```

Note for the implementer: open `backend/auto_trader/api/sweep_jobs.py` and check the
actual name of the internal job dict on the `JOBS` registry (the test above assumes
`_jobs`; use the real attribute and, if there is already a public "count running"
helper, use that instead of monkeypatching internals).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/test_api_compute_activity.py -v`
Expected: FAIL (404 on `/api/compute/activity`)

- [ ] **Step 3: Implement**

```python
# backend/auto_trader/api/activity.py
"""Last-request tracking for the compute host's idle watchdog.

A tiny module-level clock updated by an http middleware; the watchdog decides
"idle" from (activeJobs == 0 and idleSeconds > threshold). Polls of the
activity endpoint itself are excluded in the middleware, not here."""
from __future__ import annotations

import time

_last_request: float = time.monotonic()


def touch() -> None:
    global _last_request
    _last_request = time.monotonic()


def idle_seconds() -> float:
    return time.monotonic() - _last_request
```

In `backend/auto_trader/api/routers/compute.py` add:

```python
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
```

If `sweep_jobs.JOBS` has no `running_count()`, add one next to its existing
methods (take its lock if it has one, count jobs with `running=True`):

```python
def running_count(self) -> int:
    with self._lock:
        return sum(1 for j in self._jobs.values() if j.running)
```

In `backend/auto_trader/api/app.py`, after the CORS middleware block:

```python
from . import activity


@app.middleware("http")
async def _track_activity(request, call_next):
    # Feed the compute host's idle watchdog. The activity poll itself is
    # excluded so the watchdog doesn't keep the box alive by watching it.
    if request.url.path != "/api/compute/activity":
        activity.touch()
    return await call_next(request)
```

- [ ] **Step 4: Run tests**

Run: `cd backend && uv run pytest tests/test_api_compute_activity.py tests/test_api_compute_proxy.py -v`
Expected: PASS (proxy tests prove no regression)

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/activity.py backend/auto_trader/api/routers/compute.py backend/auto_trader/api/app.py backend/tests/test_api_compute_activity.py
git commit -m "feat(compute): activity endpoint + request tracking for idle watchdog"
```

---

### Task 2: Local lifecycle endpoints (start + state) via boto3

**Files:**
- Modify: `backend/pyproject.toml` (add `boto3` dependency, then `uv lock`)
- Modify: `backend/auto_trader/api/routers/compute.py`
- Test: `backend/tests/test_api_compute_host.py`

**Interfaces:**
- Consumes: `GET /api/compute/activity` on the remote host (Task 1) as the readiness probe, via the existing `_config()` url+token.
- Produces: `GET /api/compute/host` → `{"state": "unconfigured"|"stopped"|"booting"|"ready", "detail": str|None}`; `POST /api/compute/host/start` → `{"state": ...}` (starts the instance if stopped, no-op otherwise). Consumed by frontend Task 3.

State mapping: no `COMPUTE_EC2_INSTANCE_ID` → `unconfigured`. EC2 `stopped`/`stopping` → `stopped`. EC2 `pending`, or `running` but the HTTP probe fails → `booting`. `running` + probe OK → `ready`. boto3/credential errors → HTTP 502 with the AWS message as detail.

- [ ] **Step 1: Add boto3**

```bash
cd backend && uv add boto3 && uv lock
```

- [ ] **Step 2: Write the failing tests**

```python
# backend/tests/test_api_compute_host.py
"""Lifecycle endpoints: state mapping from mocked boto3 + probe, start call."""
from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient

from auto_trader.api.app import app

client = TestClient(app)


def _ec2_state(state: str) -> MagicMock:
    ec2 = MagicMock()
    ec2.describe_instances.return_value = {
        "Reservations": [{"Instances": [{"State": {"Name": state}}]}]
    }
    return ec2


def test_host_unconfigured(monkeypatch):
    monkeypatch.delenv("COMPUTE_EC2_INSTANCE_ID", raising=False)
    assert client.get("/api/compute/host").json()["state"] == "unconfigured"


def test_host_stopped(monkeypatch):
    monkeypatch.setenv("COMPUTE_EC2_INSTANCE_ID", "i-abc")
    monkeypatch.setenv("COMPUTE_EC2_REGION", "eu-central-1")
    with patch("auto_trader.api.routers.compute._ec2_client", return_value=_ec2_state("stopped")):
        assert client.get("/api/compute/host").json()["state"] == "stopped"


def test_host_running_probe_fails_is_booting(monkeypatch):
    monkeypatch.setenv("COMPUTE_EC2_INSTANCE_ID", "i-abc")
    monkeypatch.setenv("COMPUTE_EC2_REGION", "eu-central-1")
    monkeypatch.setenv("COMPUTE_HOST_URL", "http://192.0.2.1:8000")
    monkeypatch.setenv("COMPUTE_HOST_TOKEN", "t")
    with patch("auto_trader.api.routers.compute._ec2_client", return_value=_ec2_state("running")), \
         patch("auto_trader.api.routers.compute._probe_ready", return_value=False):
        assert client.get("/api/compute/host").json()["state"] == "booting"


def test_host_ready(monkeypatch):
    monkeypatch.setenv("COMPUTE_EC2_INSTANCE_ID", "i-abc")
    monkeypatch.setenv("COMPUTE_EC2_REGION", "eu-central-1")
    with patch("auto_trader.api.routers.compute._ec2_client", return_value=_ec2_state("running")), \
         patch("auto_trader.api.routers.compute._probe_ready", return_value=True):
        assert client.get("/api/compute/host").json()["state"] == "ready"


def test_start_calls_boto(monkeypatch):
    monkeypatch.setenv("COMPUTE_EC2_INSTANCE_ID", "i-abc")
    monkeypatch.setenv("COMPUTE_EC2_REGION", "eu-central-1")
    ec2 = _ec2_state("stopped")
    with patch("auto_trader.api.routers.compute._ec2_client", return_value=ec2):
        body = client.post("/api/compute/host/start").json()
    ec2.start_instances.assert_called_once_with(InstanceIds=["i-abc"])
    assert body["state"] == "booting"
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_api_compute_host.py -v`
Expected: FAIL (404)

- [ ] **Step 4: Implement in `routers/compute.py`**

Extend `_ComputeHostSettings` with the two new fields:

```python
    compute_ec2_instance_id: str = ""
    compute_ec2_region: str = "eu-central-1"
```

Add below `compute_status`:

```python
def _ec2_client(region: str):
    """Isolated for test patching; late import keeps boto3 off the hot path."""
    import boto3

    return boto3.client("ec2", region_name=region)


def _probe_ready(url: str, token: str) -> bool:
    """The instance is `ready` once the app inside answers with our token."""
    try:
        r = httpx.get(
            f"{url}/api/compute/activity",
            headers={"Authorization": f"Bearer {token}"},
            timeout=3.0,
        )
        return r.status_code == 200
    except httpx.HTTPError:
        return False


def _host_state(start: bool = False) -> dict:
    cfg = _ComputeHostSettings()
    instance_id = cfg.compute_ec2_instance_id
    if not instance_id:
        return {"state": "unconfigured", "detail": None}
    try:
        ec2 = _ec2_client(cfg.compute_ec2_region)
        desc = ec2.describe_instances(InstanceIds=[instance_id])
        ec2_state = desc["Reservations"][0]["Instances"][0]["State"]["Name"]
        if start and ec2_state in ("stopped", "stopping"):
            ec2.start_instances(InstanceIds=[instance_id])
            return {"state": "booting", "detail": None}
    except Exception as exc:  # boto3's error taxonomy is broad; surface verbatim
        raise HTTPException(502, f"EC2 error: {exc}") from None
    if ec2_state in ("stopped", "stopping"):
        return {"state": "stopped", "detail": None}
    if ec2_state == "pending":
        return {"state": "booting", "detail": None}
    if ec2_state == "running":
        url, token = _config()
        ready = _probe_ready(url, token)
        return {"state": "ready" if ready else "booting", "detail": None}
    return {"state": "stopped", "detail": f"ec2 state: {ec2_state}"}


@router.get("/api/compute/host")
async def compute_host_state() -> dict:
    return _host_state()


@router.post("/api/compute/host/start")
async def compute_host_start() -> dict:
    return _host_state(start=True)
```

- [ ] **Step 5: Run tests**

Run: `cd backend && uv run pytest tests/test_api_compute_host.py tests/test_api_compute_activity.py -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add backend/pyproject.toml backend/uv.lock backend/auto_trader/api/routers/compute.py backend/tests/test_api_compute_host.py
git commit -m "feat(compute): EC2 host lifecycle endpoints (state + start)"
```

---

### Task 3: Frontend Start-host button + status chip

**Files:**
- Modify: `frontend/src/api.ts` (two fetch helpers next to `computeStatus`, ~line 559)
- Modify: `frontend/src/lib/signals.ts` (host-state signal next to `sweepTargetSignal`, ~line 508)
- Modify: `frontend/src/BacktestSettingsModal.tsx` (chip + button next to the Compute toggle, rendered near line 2676; polling effect near the `computeStatus` effect at line 835)
- Modify: `frontend/src/BacktestButton.tsx` (block remote submit while host not ready)
- Test: `frontend/src/ComputeHostChip.test.tsx` if extracted, otherwise extend `frontend/src/BacktestSettingsModal.test.tsx`

**Interfaces:**
- Consumes: `GET /api/compute/host`, `POST /api/compute/host/start` (Task 2).
- Produces: `computeHostStateSignal: Signal<"unknown"|"unconfigured"|"stopped"|"booting"|"ready">` in `signals.ts`, read by `BacktestButton` at submit time.

Behavior:
- When the sweep target is `remote` and `remoteConfigured` is true, the modal polls `GET /api/compute/host` every 5s (only while the modal is open; stop polling when state is `unconfigured`).
- Chip copy: `stopped` → "Host stopped" + a Start button; `booting` → "Starting… (~40s)" with spinner; `ready` → "Host ready" (green dot). `unconfigured` renders nothing (Fly-era installs without EC2 env vars see no new UI).
- Start button calls `POST /api/compute/host/start`, then keeps polling; AWS errors (502 detail) surface in the existing toast mechanism.
- `BacktestButton`: if target is remote and `computeHostStateSignal.value` is `stopped` or `booting`, show toast "Compute host is not ready yet. Start it from the sweep settings." and do not submit. `unknown`/`unconfigured` submit as today (plain remote hosts without EC2 lifecycle keep working).

- [ ] **Step 1: api.ts helpers**

```ts
export type ComputeHostState = "unconfigured" | "stopped" | "booting" | "ready";

export async function computeHostState(): Promise<{ state: ComputeHostState; detail: string | null }> {
  const res = await fetch(`${API_BASE}/api/compute/host`);
  if (!res.ok) throw new Error(`host state: ${res.status}`);
  return res.json();
}

export async function startComputeHost(): Promise<{ state: ComputeHostState }> {
  const res = await fetch(`${API_BASE}/api/compute/host/start`, { method: "POST" });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.detail ?? `start: ${res.status}`);
  return res.json();
}
```

(Match the surrounding file's fetch style — if existing helpers use a shared wrapper instead of raw `fetch`, use that.)

- [ ] **Step 2: signal**

```ts
export type ComputeHostUiState = "unknown" | "unconfigured" | "stopped" | "booting" | "ready";
export const computeHostStateSignal = new Signal<ComputeHostUiState>("unknown");
```

- [ ] **Step 3: failing component test** (extend `BacktestSettingsModal.test.tsx`, follow its existing mock setup): mock `computeHostState` to return `stopped`, open the modal in sweep mode with remote target, assert "Host stopped" and a "Start" button render; click Start, assert `startComputeHost` was called.

- [ ] **Step 4: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/BacktestSettingsModal.test.tsx`
Expected: FAIL

- [ ] **Step 5: Implement modal chip + polling + BacktestButton gate** as described in Behavior. Follow the existing effect pattern at `BacktestSettingsModal.tsx:835` for fetching, and reuse the shared `Tooltip` component for any hover copy (per CLAUDE.md, no native `title=`).

- [ ] **Step 6: Run tests**

Run: `cd frontend && npx vitest run src/BacktestSettingsModal.test.tsx`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add frontend/src/api.ts frontend/src/lib/signals.ts frontend/src/BacktestSettingsModal.tsx frontend/src/BacktestButton.tsx frontend/src/BacktestSettingsModal.test.tsx
git commit -m "feat(sweep): compute-host start button + status chip"
```

---

### Task 4: Instance assets (systemd units, watchdog, env template)

All files that live ON the instance, committed under `deploy/ec2/` and rsynced by `deploy-ec2.sh` (Task 5). No unit tests; verification is on-box in Task 6.

**Files:**
- Create: `deploy/ec2/auto-trader-compute.service`
- Create: `deploy/ec2/auto-trader-idle-stop.service`
- Create: `deploy/ec2/auto-trader-idle-stop.timer`
- Create: `deploy/ec2/idle-stop.sh`
- Create: `deploy/ec2/compute.env.example`

**Interfaces:**
- Consumes: `GET localhost:8000/api/compute/activity` with bearer token (Task 1).
- Produces: paths Task 5's deploy script installs: units to `/etc/systemd/system/`, `idle-stop.sh` to `/usr/local/bin/`, env at `/etc/auto-trader/compute.env`.

- [ ] **Step 1: Write the container unit**

```ini
# deploy/ec2/auto-trader-compute.service
# Runs the compute-host container. Installed to /etc/systemd/system/ by
# scripts/deploy-ec2.sh; image is built on the box from the rsynced source.
[Unit]
Description=auto-trader compute host container
After=docker.service network-online.target
Requires=docker.service

[Service]
Restart=always
RestartSec=3
ExecStartPre=-/usr/bin/docker rm -f auto-trader-compute
ExecStart=/usr/bin/docker run --rm --name auto-trader-compute \
  --env-file /etc/auto-trader/compute.env \
  -v /data:/data -p 8000:8000 auto-trader-compute:latest
ExecStop=/usr/bin/docker stop auto-trader-compute

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: Write the watchdog script**

```bash
# deploy/ec2/idle-stop.sh
#!/usr/bin/env bash
# Stop the instance when the compute app reports no jobs and >IDLE_LIMIT
# seconds since the last real request. Run every minute by the systemd timer.
# Instance-initiated `shutdown -h` STOPS an EBS-backed instance (billing ends,
# disk persists) because the instance's shutdown behavior is `stop`.
set -euo pipefail

IDLE_LIMIT=900          # 15 min
BOOT_GRACE=600          # never stop in the first 10 min after boot

UPTIME=$(awk '{print int($1)}' /proc/uptime)
[ "$UPTIME" -lt "$BOOT_GRACE" ] && exit 0

source /etc/auto-trader/compute.env   # for API_TOKEN

# App unreachable (deploy in progress, container restarting): do nothing.
BODY=$(curl -sf -m 5 -H "Authorization: Bearer ${API_TOKEN}" \
  http://localhost:8000/api/compute/activity) || exit 0

ACTIVE=$(echo "$BODY" | python3 -c 'import json,sys; print(json.load(sys.stdin)["activeJobs"])')
IDLE=$(echo "$BODY" | python3 -c 'import json,sys; print(int(json.load(sys.stdin)["idleSeconds"]))')

if [ "$ACTIVE" -eq 0 ] && [ "$IDLE" -gt "$IDLE_LIMIT" ]; then
  logger -t auto-trader-idle-stop "idle ${IDLE}s with 0 jobs; stopping instance"
  shutdown -h now
fi
```

- [ ] **Step 3: Write the watchdog units**

```ini
# deploy/ec2/auto-trader-idle-stop.service
[Unit]
Description=auto-trader idle shutdown check

[Service]
Type=oneshot
ExecStart=/usr/local/bin/idle-stop.sh
```

```ini
# deploy/ec2/auto-trader-idle-stop.timer
[Unit]
Description=auto-trader idle shutdown timer (1 min cadence)

[Timer]
OnBootSec=2min
OnUnitActiveSec=1min

[Install]
WantedBy=timers.target
```

- [ ] **Step 4: Env template**

```bash
# deploy/ec2/compute.env.example
# Copy to /etc/auto-trader/compute.env on the instance and fill in. Never commit
# the filled file. Same variables the Fly host had as secrets (docs/deploy-compute.md).
REQUIRE_API_TOKEN=1
COMPUTE_ONLY=1
API_TOKEN=change-me
# Broker credentials (same names as backend/.env) go here too:
# CAPITAL_API_KEY=...
```

- [ ] **Step 5: Commit**

```bash
chmod +x deploy/ec2/idle-stop.sh
git add deploy/ec2
git commit -m "feat(compute): EC2 instance assets (systemd units + idle watchdog)"
```

---

### Task 5: Provision / deploy / allow-me scripts

**Files:**
- Create: `scripts/ec2-provision.sh`
- Create: `scripts/ec2-allow-me.sh`
- Create: `scripts/deploy-ec2.sh`

**Interfaces:**
- Consumes: `deploy/ec2/*` assets (Task 4), existing `backend/Dockerfile` (build context = repo root, unchanged).
- Produces: a running instance whose ID/IP the user puts into `backend/.env` as `COMPUTE_EC2_INSTANCE_ID` / `COMPUTE_HOST_URL`.

All three scripts share conventions: `set -euo pipefail`, `REGION=eu-central-1`, resources tagged/named `auto-trader-compute`, and they print what they created. They are idempotent where cheap (look up existing resource by name before creating).

- [ ] **Step 1: Write `scripts/ec2-provision.sh`**

```bash
#!/usr/bin/env bash
# One-time provisioning of the auto-trader EC2 compute host.
# Prereqs: aws CLI v2 authenticated; 64-vCPU on-demand quota in eu-central-1
# (check: aws service-quotas get-service-quota --service-code ec2 \
#   --quota-code L-1216C47A --region eu-central-1  → Value >= 64).
set -euo pipefail

REGION=eu-central-1
NAME=auto-trader-compute
TYPE=c8a.16xlarge
KEY=~/.ssh/${NAME}.pem

MY_IP=$(curl -sf https://checkip.amazonaws.com)/32
echo "allowing ${MY_IP}"

# Key pair (skip if the pem already exists locally).
if [ ! -f "$KEY" ]; then
  aws ec2 create-key-pair --region $REGION --key-name $NAME \
    --query 'KeyMaterial' --output text > "$KEY"
  chmod 600 "$KEY"
fi

# Security group: SSH + app port, this IP only.
SG=$(aws ec2 describe-security-groups --region $REGION \
  --filters Name=group-name,Values=$NAME \
  --query 'SecurityGroups[0].GroupId' --output text)
if [ "$SG" = "None" ]; then
  SG=$(aws ec2 create-security-group --region $REGION --group-name $NAME \
    --description "auto-trader compute host" --query 'GroupId' --output text)
  aws ec2 authorize-security-group-ingress --region $REGION --group-id $SG \
    --protocol tcp --port 22 --cidr "$MY_IP"
  aws ec2 authorize-security-group-ingress --region $REGION --group-id $SG \
    --protocol tcp --port 8000 --cidr "$MY_IP"
fi

# Latest AL2023 x86_64 AMI via the public SSM parameter.
AMI=$(aws ssm get-parameter --region $REGION \
  --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \
  --query 'Parameter.Value' --output text)

# Instance: 20 GB gp3, docker via user-data, shutdown-behavior=stop (that is
# what turns the watchdog's `shutdown -h` into a billing stop, not a terminate).
ID=$(aws ec2 run-instances --region $REGION \
  --image-id "$AMI" --instance-type $TYPE --key-name $NAME \
  --security-group-ids "$SG" \
  --instance-initiated-shutdown-behavior stop \
  --block-device-mappings '[{"DeviceName":"/dev/xvda","Ebs":{"VolumeSize":20,"VolumeType":"gp3"}}]' \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME}]" \
  --user-data '#!/bin/bash
dnf install -y docker rsync
systemctl enable --now docker
mkdir -p /data /etc/auto-trader' \
  --query 'Instances[0].InstanceId' --output text)
echo "instance: $ID"
aws ec2 wait instance-running --region $REGION --instance-ids "$ID"

# Elastic IP so COMPUTE_HOST_URL survives stop/start.
EIP=$(aws ec2 allocate-address --region $REGION \
  --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Name,Value=$NAME}]" \
  --query 'AllocationId' --output text)
aws ec2 associate-address --region $REGION --instance-id "$ID" --allocation-id "$EIP"
IP=$(aws ec2 describe-addresses --region $REGION --allocation-ids "$EIP" \
  --query 'Addresses[0].PublicIp' --output text)

cat <<EOF

Provisioned. Add to backend/.env:
  COMPUTE_HOST_URL=http://${IP}:8000
  COMPUTE_HOST_TOKEN=<same API_TOKEN you will put in /etc/auto-trader/compute.env>
  COMPUTE_EC2_INSTANCE_ID=${ID}
  COMPUTE_EC2_REGION=${REGION}

Next: fill /etc/auto-trader/compute.env on the box (template deploy/ec2/compute.env.example),
then run scripts/deploy-ec2.sh
EOF
```

- [ ] **Step 2: Write `scripts/ec2-allow-me.sh`** (revoke all current rules on ports 22/8000, authorize the caller's current IP; used when the home IP changes)

```bash
#!/usr/bin/env bash
set -euo pipefail
REGION=eu-central-1
NAME=auto-trader-compute
MY_IP=$(curl -sf https://checkip.amazonaws.com)/32
SG=$(aws ec2 describe-security-groups --region $REGION \
  --filters Name=group-name,Values=$NAME --query 'SecurityGroups[0].GroupId' --output text)
for PORT in 22 8000; do
  # Drop every existing rule for this port, then add the current IP.
  EXISTING=$(aws ec2 describe-security-groups --region $REGION --group-ids "$SG" \
    --query "SecurityGroups[0].IpPermissions[?FromPort==\`$PORT\`].IpRanges[].CidrIp" --output text)
  for CIDR in $EXISTING; do
    aws ec2 revoke-security-group-ingress --region $REGION --group-id "$SG" \
      --protocol tcp --port "$PORT" --cidr "$CIDR"
  done
  aws ec2 authorize-security-group-ingress --region $REGION --group-id "$SG" \
    --protocol tcp --port "$PORT" --cidr "$MY_IP"
done
echo "security group $SG now allows $MY_IP on 22/8000"
```

- [ ] **Step 3: Write `scripts/deploy-ec2.sh`** (replaces `fly deploy`)

```bash
#!/usr/bin/env bash
# Deploy the backend to the EC2 compute host: start it if stopped, rsync
# source + instance assets, build the image on the box, (re)install units,
# restart. Run from the repo root.
set -euo pipefail

REGION=eu-central-1
NAME=auto-trader-compute
KEY=~/.ssh/${NAME}.pem

ID=$(aws ec2 describe-instances --region $REGION \
  --filters Name=tag:Name,Values=$NAME Name=instance-state-name,Values=pending,running,stopping,stopped \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)
STATE=$(aws ec2 describe-instances --region $REGION --instance-ids "$ID" \
  --query 'Reservations[0].Instances[0].State.Name' --output text)
if [ "$STATE" != "running" ]; then
  aws ec2 start-instances --region $REGION --instance-ids "$ID" >/dev/null
  aws ec2 wait instance-running --region $REGION --instance-ids "$ID"
fi
IP=$(aws ec2 describe-instances --region $REGION --instance-ids "$ID" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
SSH="ssh -i $KEY -o StrictHostKeyChecking=accept-new ec2-user@$IP"

# Source + assets. The Dockerfile expects repo-root context with backend/ prefix.
rsync -az --delete -e "ssh -i $KEY -o StrictHostKeyChecking=accept-new" \
  backend/Dockerfile backend/pyproject.toml backend/uv.lock \
  backend/auto_trader backend/strategies "ec2-user@$IP:/home/ec2-user/src/backend/"
rsync -az -e "ssh -i $KEY -o StrictHostKeyChecking=accept-new" \
  deploy/ec2/ "ec2-user@$IP:/home/ec2-user/deploy/"

$SSH sudo bash -s <<'REMOTE'
set -euo pipefail
install -m 755 /home/ec2-user/deploy/idle-stop.sh /usr/local/bin/idle-stop.sh
install -m 644 /home/ec2-user/deploy/auto-trader-compute.service \
               /home/ec2-user/deploy/auto-trader-idle-stop.service \
               /home/ec2-user/deploy/auto-trader-idle-stop.timer \
               /etc/systemd/system/
[ -f /etc/auto-trader/compute.env ] || { echo "FILL /etc/auto-trader/compute.env first (see deploy/compute.env.example)"; exit 1; }
cd /home/ec2-user/src
docker build -f backend/Dockerfile -t auto-trader-compute:latest .
systemctl daemon-reload
systemctl enable --now auto-trader-compute.service auto-trader-idle-stop.timer
systemctl restart auto-trader-compute.service
REMOTE

echo "deployed to http://$IP:8000"
```

- [ ] **Step 4: Syntax-check and commit**

Run: `bash -n scripts/ec2-provision.sh scripts/ec2-allow-me.sh scripts/deploy-ec2.sh && chmod +x scripts/ec2-*.sh scripts/deploy-ec2.sh`
Expected: no output, exit 0

```bash
git add scripts/ec2-provision.sh scripts/ec2-allow-me.sh scripts/deploy-ec2.sh
git commit -m "feat(compute): EC2 provision/deploy/allow-me scripts"
```

---

### Task 6: Provision, first deploy, on-box verification (manual, with user)

No code. Requires the user's AWS credentials; pause and coordinate.

- [ ] **Step 1:** Verify quota: `aws service-quotas get-service-quota --service-code ec2 --quota-code L-1216C47A --region eu-central-1` shows Value >= 64. If not, request the increase and stop here until granted.
- [ ] **Step 2:** Run `scripts/ec2-provision.sh`. Record instance ID + Elastic IP.
- [ ] **Step 3:** SSH in, copy `compute.env.example` to `/etc/auto-trader/compute.env`, fill `API_TOKEN` (reuse the Fly token) and broker credentials (copy values from `fly secrets list` names / local `.env`).
- [ ] **Step 4:** Run `scripts/deploy-ec2.sh`.
- [ ] **Step 5:** Verify from the Mac:

```bash
IP=<elastic-ip>; TOKEN=<token>
curl -s -H "Authorization: Bearer $TOKEN" http://$IP:8000/api/compute/activity
# → {"activeJobs":0,"idleSeconds":...}
curl -s -o /dev/null -w '%{http_code}\n' http://$IP:8000/api/compute/activity  # no token
# → 401/403 (guard active)
```

- [ ] **Step 6:** Add the four env lines from the provision output to `backend/.env`; restart the local backend; `curl localhost:8000/api/compute/host` → `{"state":"ready",...}`.
- [ ] **Step 7:** Watchdog dry-run: on the box, `sudo systemctl list-timers | grep idle`, then wait 15+ min without traffic and confirm the instance reaches `stopped` in `aws ec2 describe-instances`. Start it again via `curl -X POST localhost:8000/api/compute/host/start` and confirm it comes back to `ready`.

---

### Task 7: End-to-end sweep + timing comparison (manual, with user)

- [ ] **Step 1:** In the UI: open sweep settings, target Remote, confirm the chip shows Host ready (or Start it).
- [ ] **Step 2:** Run the same sweep three ways (local, EC2) that was previously benchmarked on Fly; record wall-clock each way.
- [ ] **Step 3:** Confirm results land identically (same rows/metrics as a local run of the same grid).
- [ ] **Step 4:** Confirm process-pool saturation on the box during the sweep: `ssh … top -b -n1 | head -20` shows ~64 busy cores. If the pool caps below 64, find the worker-count derivation in `backend/auto_trader` (`os.cpu_count()` vs a hardcoded cap) and fix it.
- [ ] **Step 5:** After 15 idle minutes, confirm the instance stopped itself.

---

### Task 8: Fly teardown + docs + memory

Only after Task 7 passes.

**Files:**
- Delete: `fly.toml`
- Modify: `docs/deploy-compute.md` (rewrite for EC2: provisioning, env, deploy, allow-me, costs, teardown)
- Modify: `backend/auto_trader/api/routers/compute.py:5` and `backend/Dockerfile:1` (docstring/comment references to Fly → EC2)

- [ ] **Step 1:** `fly apps destroy auto-trader-compute` (confirm with the user first; this deletes the Fly volume and its candle cache).
- [ ] **Step 2:** Rewrite `docs/deploy-compute.md` for the EC2 flow; delete `fly.toml`; update the two Fly comment references.
- [ ] **Step 3:** Run full backend + frontend test suites.

Run: `cd backend && uv run pytest && cd ../frontend && npx vitest run`
Expected: PASS

- [ ] **Step 4:** Commit.

```bash
git add -A
git commit -m "chore(compute): retire Fly host, docs for EC2 flow"
```

- [ ] **Step 5:** Update the `sweep-jobs-remote-compute` memory file: host is now EC2 c8a.16xlarge (64 cores), started from UI, self-stops when idle; Fly retired.
