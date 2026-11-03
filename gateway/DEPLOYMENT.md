# Deployment Chat WA Bot

## Current boundary

The gateway is private at 127.0.0.1:18181 on the VPS. Never expose its bearer token in frontend JavaScript, localStorage, Git, or a public build.

## Required before publishing

- Protect the dashboard and API using user authentication (Cloudflare Access is an option for a private dashboard).
- Route only authenticated API requests through a server-side proxy that injects the gateway token.
- Expose the private proxy through Cloudflare Tunnel; do not open port 18181 publicly.
- Connect the dashboard to same-origin /api/whatsapp/status, /connect and /qr.
- Configure chatbot.restupambudi.my.id DNS and HTTPS after the protected origin is ready.
- Verify unauthorized requests fail, QR pairing works, and saved credentials reconnect after restart.

## Remaining functionality

The current gateway implements pairing and status only. Sending, receiving, message persistence, logout/re-pair recovery, and duplicate-send protection are not implemented. Do not label the application production-ready yet.
