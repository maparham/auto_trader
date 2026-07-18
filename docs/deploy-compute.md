# Deploy the remote compute host (AWS EC2)

The compute host is a headless copy of the backend that runs backtests and
sweeps off your machine. It has dealing disabled (`COMPUTE_ONLY=1`) and requires
a bearer token on every request (`REQUIRE_API_TOKEN=1`). The local backend
proxies sweep jobs to it when you pick "Remote" in the sweep footer.

It runs on an EC2 `c8a.16xlarge` (64 Turin cores, `eu-central-1`) behind an
Elastic IP, with the security group locked to your public IP. You start it from
the UI (or `POST /api/compute/host/start`); an on-box systemd watchdog stops the
instance after 15 idle minutes so you only pay for active compute.

All commands run from the repo root. The build context is the repo root, so the
`backend/`-prefixed COPY paths in `backend/Dockerfile` resolve.

## Prerequisites

- AWS CLI v2, authenticated (`aws sts get-caller-identity` works).
- A 64-vCPU on-demand quota for Standard instances in `eu-central-1`:
  ```
  aws service-quotas get-service-quota --service-code ec2 \
    --quota-code L-1216C47A --region eu-central-1 --query 'Quota.Value'
  ```
  If it is below 64, request an increase and wait for it to be granted.
- `flyctl` is no longer needed; the old Fly host has been retired.

## 1. Provision (one time)

```
scripts/ec2-provision.sh
```

Idempotent: it reuses an existing key pair, security group, instance, and
Elastic IP if they are already tagged `auto-trader-compute`. It creates:

- a `c8a.16xlarge` (AL2023 x86_64, 20 GB gp3), shutdown behavior `stop` (so the
  watchdog's `shutdown -h` stops the instance and preserves the disk instead of
  terminating it);
- a security group opening ports 22 and 8000 to your current public IP only;
- an Elastic IP so `COMPUTE_HOST_URL` survives stop/start;
- user-data that installs docker + rsync and creates `/data` and
  `/etc/auto-trader`.

It prints the four lines to add to `backend/.env` (see step 4). The SSH key is
written to `~/.ssh/auto-trader-compute.pem`.

## 2. Fill the on-box env file

The host reads `/etc/auto-trader/compute.env`. Create it from the template and
set the shared token:

```
ssh -i ~/.ssh/auto-trader-compute.pem ec2-user@<elastic-ip>
sudo tee /etc/auto-trader/compute.env >/dev/null <<'EOF'
REQUIRE_API_TOKEN=1
COMPUTE_ONLY=1
API_TOKEN=<a value: openssl rand -hex 32>
EOF
sudo chmod 600 /etc/auto-trader/compute.env
```

Use the SAME `API_TOKEN` value in `backend/.env` as `COMPUTE_HOST_TOKEN`
(step 4). Values must be unquoted and use only alphanumerics/dashes/underscores:
this file is read by both `docker --env-file` (raw values) and the watchdog's
`source` (which strips quotes and interprets metacharacters), so a quoted or
metacharacter-laden token would leave the container and watchdog disagreeing and
the box would never self-stop.

Broker credentials are NOT required: sweeps ship their bars to the host, so it
never fetches from a broker (`COMPUTE_ONLY`). If you ever add a code path that
does fetch on the host, add the same `CAPITAL_*` / `IG_*` / `METAAPI_*` names
you use in `backend/.env`.

## 3. Deploy

```
scripts/deploy-ec2.sh
```

Starts the instance if stopped, waits for sshd, rsyncs `backend/` source +
`deploy/ec2/` assets, builds the image on the box, installs the systemd units,
and (re)starts the compute service and idle-stop timer. Refuses to proceed if
`/etc/auto-trader/compute.env` is missing.

Coded strategies are baked into the image at build time, not read from a live
volume. After you edit any `backend/strategies/*.py`, redeploy or Remote runs
keep using the stale copy from the last build.

## 4. Wire up the local backend

Add the four lines the provision script printed to `backend/.env`:

```
COMPUTE_HOST_URL=http://<elastic-ip>:8000
COMPUTE_HOST_TOKEN=<the API_TOKEN from step 2>
COMPUTE_EC2_INSTANCE_ID=i-...
COMPUTE_EC2_REGION=eu-central-1
```

Restart the local backend. In the sweep footer, switch the compute target to
"Remote": a status chip appears (Host stopped / Starting / Host ready). Start
the host from there if it is stopped, then run your sweep once the chip is green.
`COMPUTE_HOST_URL` + `COMPUTE_HOST_TOKEN` alone are enough to submit; the EC2
lifecycle chip and Start button need the two `COMPUTE_EC2_*` vars as well.

## Costs and lifecycle

- `c8a.16xlarge` is on-demand, billed per second only while running. The
  watchdog stops it after 15 idle minutes (never mid-job), so an idle host costs
  only its 20 GB gp3 volume (a few cents a month) plus the Elastic IP.
- A stopped instance keeps its disk and Elastic IP; starting it back up (Start
  button or `POST /api/compute/host/start`) takes ~40 s to reach ready.
- The worker pool auto-sizes to the box's CPU count (64). Cap it with
  `SWEEP_WORKERS=<n>` in `/etc/auto-trader/compute.env` if needed.

## When your home IP changes

The security group is pinned to one IP. After an ISP change:

```
scripts/ec2-allow-me.sh
```

Revokes the old rules on 22/8000 and authorizes your current public IP.

## Teardown

```
aws ec2 terminate-instances --region eu-central-1 --instance-ids <id>
aws ec2 release-address --region eu-central-1 --allocation-id <eip-alloc-id>
```

Terminating deletes the instance and its gp3 volume (candle cache). Release the
Elastic IP separately or it keeps accruing the idle-address charge.
