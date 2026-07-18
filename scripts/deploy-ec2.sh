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

# Wait for sshd (a freshly started box passes instance-running before ssh is up),
# then make sure the rsync destination exists on first deploy.
for i in $(seq 1 30); do
  $SSH true 2>/dev/null && break
  [ "$i" = 30 ] && { echo "ssh not reachable at $IP after 90s" >&2; exit 1; }
  sleep 3
done
$SSH mkdir -p /home/ec2-user/src/backend

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
