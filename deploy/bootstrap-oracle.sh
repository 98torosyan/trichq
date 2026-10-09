#!/usr/bin/env bash
# One-time (idempotent) setup of the Oracle Cloud Ubuntu VM. Run by the deploy workflow over SSH.
set -euo pipefail

if ! command -v docker >/dev/null 2>&1; then
  echo "Installing Docker..."
  sudo apt-get update -y
  sudo apt-get install -y ca-certificates curl
  sudo install -m 0755 -d /etc/apt/keyrings
  sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  sudo chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -y
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  sudo usermod -aG docker "$USER"
fi

sudo mkdir -p /opt/trichq/data /opt/trichq/src
sudo chown -R "$USER":"$USER" /opt/trichq

# Automatic security updates; the VM should look after itself.
if ! dpkg -s unattended-upgrades >/dev/null 2>&1; then
  sudo apt-get install -y unattended-upgrades
fi

# Keep the clock right: nightly jobs run on Yerevan time.
sudo timedatectl set-timezone Asia/Yerevan || true
echo "bootstrap ok"
