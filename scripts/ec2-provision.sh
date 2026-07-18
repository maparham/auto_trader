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
# Reuse an existing instance if one was already provisioned.
ID=$(aws ec2 describe-instances --region $REGION \
  --filters Name=tag:Name,Values=$NAME Name=instance-state-name,Values=pending,running,stopping,stopped \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)
if [ "$ID" = "None" ]; then
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
  aws ec2 wait instance-running --region $REGION --instance-ids "$ID"
fi
echo "instance: $ID"

# Elastic IP so COMPUTE_HOST_URL survives stop/start.
# Reuse an existing Elastic IP if one is already tagged.
EIP=$(aws ec2 describe-addresses --region $REGION \
  --filters Name=tag:Name,Values=$NAME \
  --query 'Addresses[0].AllocationId' --output text)
if [ "$EIP" = "None" ]; then
  EIP=$(aws ec2 allocate-address --region $REGION \
    --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Name,Value=$NAME}]" \
    --query 'AllocationId' --output text)
fi
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
