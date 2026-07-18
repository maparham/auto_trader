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
