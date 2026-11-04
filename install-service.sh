#!/bin/sh
set -eu
id chat-wa >/dev/null 2>&1 || useradd --system --home-dir /var/lib/chat-wa-gateway --shell /usr/sbin/nologin chat-wa
if [ ! -e /etc/chat-wa-gateway.env ]; then
  umask 077
  printf 'GATEWAY_TOKEN=%s\n' "$(openssl rand -hex 32)" > /etc/chat-wa-gateway.env
fi
if ! grep -q '^DASHBOARD_PASSWORD=' /etc/chat-wa-gateway.env; then
  printf 'DASHBOARD_PASSWORD=%s\nDASHBOARD_DIR=/opt/chat-wa-gateway/dashboard\n' "$(openssl rand -hex 24)" >> /etc/chat-wa-gateway.env
fi
install -m 644 /opt/chat-wa-gateway/chat-wa-gateway.service /etc/systemd/system/chat-wa-gateway.service
systemctl daemon-reload
systemctl enable --now chat-wa-gateway
systemctl is-active chat-wa-gateway
