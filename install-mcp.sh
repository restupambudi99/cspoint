#!/bin/sh
set -eu
if ! grep -q '^MCP_TOKEN=' /etc/chat-wa-gateway.env; then
  umask 077
  printf 'MCP_TOKEN=%s\n' "$(openssl rand -hex 32)" >> /etc/chat-wa-gateway.env
fi
systemctl restart chat-wa-gateway
systemctl is-active chat-wa-gateway
