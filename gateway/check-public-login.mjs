import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const env = await readFile('/etc/chat-wa-gateway.env', 'utf8');
const password = env.split('\n').find(line => line.startsWith('DASHBOARD_PASSWORD='))?.slice('DASHBOARD_PASSWORD='.length);
const base = 'https://chatbot.restupambudi.my.id';
const login = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: 'admin', password }) });
assert.equal(login.status, 303);
const cookie = login.headers.get('set-cookie')?.split(';')[0];
assert.ok(cookie);
for (const path of ['/', '/app.js', '/styles.css', '/whatsapp.js', '/inbox.js', '/api/whatsapp/status', '/api/whatsapp/conversations', '/api/whatsapp/messages?jid=test']) {
  const response = await fetch(`${base}${path}`, { headers: { Cookie: cookie }, redirect: 'manual' });
  console.log(path, response.status);
  assert.equal(response.status, 200);
  await response.arrayBuffer();
}
console.log('PASS: public login, session cookie, dashboard, assets and status');
