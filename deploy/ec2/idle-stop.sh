#!/usr/bin/env bash
# deploy/ec2/idle-stop.sh
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
