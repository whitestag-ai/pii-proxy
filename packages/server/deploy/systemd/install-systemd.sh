#!/usr/bin/env bash
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "This script must be run as root (use sudo)." >&2
  exit 1
fi

SERVICE_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

# 1. System user
if ! id pii-proxy &>/dev/null; then
  useradd --system --no-create-home --shell /usr/sbin/nologin pii-proxy
fi

# 2. Dirs
install -d -o pii-proxy -g pii-proxy -m 0750 /var/lib/pii-proxy /var/log/pii-proxy
install -d -o root -g pii-proxy -m 0750 /etc/pii-proxy

# 3. Install code
mkdir -p /opt/pii-proxy/server
cp -r "$SERVICE_DIR/dist" "$SERVICE_DIR/node_modules" /opt/pii-proxy/server/
chown -R root:root /opt/pii-proxy

# 4. Secret env
if [[ -z "${PII_PROXY_SHARED_KEY:-}" ]]; then
  echo "Set PII_PROXY_SHARED_KEY before running." >&2
  exit 1
fi
umask 077
echo "PII_PROXY_SHARED_KEY=$PII_PROXY_SHARED_KEY" > /etc/pii-proxy/secret.env
chown root:pii-proxy /etc/pii-proxy/secret.env
chmod 0640 /etc/pii-proxy/secret.env

# 5. Install unit
cp "$SERVICE_DIR/deploy/systemd/pii-proxy.service" /etc/systemd/system/pii-proxy.service
systemctl daemon-reload
systemctl enable pii-proxy.service
systemctl restart pii-proxy.service
echo "Installed. Check: systemctl status pii-proxy && curl http://localhost:4711/health"
