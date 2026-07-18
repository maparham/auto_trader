# EC2 Compute Host Migration (replaces Fly.io)

Date: 2026-07-18
Status: approved

## Goal

Move the remote sweep/backtest compute host from Fly.io `performance-16x` (16 slow
EPYC cores, capped at that size) to an AWS EC2 `c8a.16xlarge` (64 EPYC Turin
cores, ~4.5 GHz, no SMT). Expected ~8-10x throughput vs the M2 Air and ~4-5x vs
the Fly host. Fly app is destroyed once EC2 is verified; no dual-host support.

## Decisions (user-confirmed)

- Replace Fly entirely; single remote host.
- AWS account exists with working credentials/CLI.
- Instance type: `c8a.16xlarge`, on-demand (no spot), region `eu-central-1`.
- Lifecycle: manual Start button in the UI; the instance shuts itself down when
  idle (watchdog inside the instance, not backend-driven).
- Transport: plain HTTP on port 8000, security group restricted to the user's
  current public IP. No TLS, no domain.

## Architecture

### Infrastructure

- `c8a.16xlarge`, on-demand, `eu-central-1`, Amazon Linux 2023 x86_64.
- 20 GB gp3 EBS root volume; persists across stops and holds the candle cache
  at `/data` (same role as the Fly volume `candle_cache`).
- Elastic IP so `COMPUTE_HOST_URL` never changes across stop/start cycles.
- Security group `auto-trader-compute`: inbound TCP 8000 from the user's
  public IP only (plus SSH 22 from same IP). Helper script
  `scripts/ec2-allow-me.sh` replaces the rule with the caller's current IP.
- Instance-initiated shutdown behavior = `stop` (default for EBS-backed), so
  `shutdown -h now` stops billing but keeps the disk.

### On the instance

- Docker container built from the existing `backend/Dockerfile` (unchanged).
- Env identical to Fly: `REQUIRE_API_TOKEN=1`, `COMPUTE_ONLY=1`, `API_TOKEN`
  and broker credentials in `/etc/auto-trader/compute.env` (never committed).
- systemd unit `auto-trader-compute.service`: starts the container on boot,
  restarts on crash, mounts `/data` into the container.
- Idle watchdog `auto-trader-idle-stop`: script + systemd timer (1 min cadence)
  that queries the app for activity (active jobs and a last-request timestamp
  endpoint). After 15 consecutive idle minutes it runs `shutdown -h now`.
  Boot grace period of 10 minutes so the box is not killed before the first
  sweep is submitted.

### App changes

- Backend: new compute-host lifecycle endpoints (start + status) that call
  `ec2 start-instances` / `describe-instances` via boto3 using local AWS
  credentials. Status maps to stopped | booting | ready (ready = app answers
  its health endpoint through the proxy).
- Backend: expose the activity signal the watchdog needs (active job count and
  last compute-request timestamp) on the compute host itself.
- Frontend: Start host button + status chip (stopped / booting ~40s / ready) in
  the sweep panel next to the existing Local/Remote host picker. Submitting a
  remote sweep while stopped prompts to start the host first.
- Config: `COMPUTE_HOST_URL=http://<elastic-ip>:8000`; `COMPUTE_HOST_TOKEN`
  unchanged. New: `COMPUTE_EC2_INSTANCE_ID`, `COMPUTE_EC2_REGION` for the
  lifecycle endpoints.

### Deploy/update flow

- `scripts/deploy-ec2.sh`: rsync backend source to the instance, `docker build`
  on the box (fast on 64 cores), restart the systemd unit. Replaces `fly deploy`.
- `docs/deploy-compute.md` rewritten for EC2 (provisioning, secrets, deploy,
  IP allowlist, teardown of Fly).

## Rollout

1. Provision: instance, EIP, security group, EBS, systemd units, first deploy;
   verify manually with curl + a token.
2. App wiring: lifecycle endpoints + UI button/status.
3. End-to-end: run a real sweep from the UI, compare wall-clock vs Fly and
   local; verify idle watchdog stops the instance afterwards.
4. Teardown: `fly apps destroy auto-trader-compute`; remove fly.toml.

## Costs

- Running: ~$3.46/hr on-demand.
- Stopped: EBS ~$2/mo + unattached-EIP-while-stopped ~$3.6/mo. (EIP is free
  while the instance runs.)

## Error handling

- Start button surfaces AWS errors (quota, credentials) verbatim in a toast.
- Sweep submission to a stopped/booting host returns a clear 503 with state,
  not a timeout.
- Watchdog never shuts down while a job is active or within the boot grace
  window.

## Testing

- Unit: lifecycle endpoint state mapping (mock boto3); activity endpoint.
- Manual: full sweep on EC2, watchdog shutdown observed, restart cycle, IP
  change + allow-me script.
