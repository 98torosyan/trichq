#!/usr/bin/env bash
# One-time (idempotent) setup of the Oracle Cloud Ubuntu VM. Run by the deploy workflow over SSH.
set -euo pipefail

APT="sudo apt-get -o DPkg::Lock::Timeout=300"  # cloud-init may still hold the apt lock on first boot
$APT update -y
$APT install -y rsync ca-certificates curl

if ! command -v docker >/dev/null 2>&1; then
  echo "Installing Docker..."
  sudo install -m 0755 -d /etc/apt/keyrings
  sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  sudo chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  $APT update -y
  $APT install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  sudo usermod -aG docker "$USER"
fi

sudo mkdir -p /opt/trichq/data /opt/trichq/src
sudo chown -R "$USER":"$USER" /opt/trichq
# The container runs as uid 10001 (see collector/Dockerfile) and must be able to write its cache.
sudo chown -R 10001:10001 /opt/trichq/data

# Automatic security updates; the VM should look after itself.
if ! dpkg -s unattended-upgrades >/dev/null 2>&1; then
  $APT install -y unattended-upgrades
fi

# Keep the clock right: nightly jobs run on Yerevan time.
sudo timedatectl set-timezone Asia/Yerevan || true
echo "bootstrap ok"
