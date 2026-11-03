import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const env = await readFile('/etc/chat-wa-gateway.env', 'utf8');
const token = env.split('\n').find(line => line.startsWith('MCP_TOKEN='))?.slice(10);
assert.ok(token?.length >= 32);
const url = 'https://chatbot.restupambudi.my.id/mcp';
assert.equal((await fetch(url)).status, 401);
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
for (const [method, params] of [
  ['initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'deployment-check', version: '1' } }],
  ['tools/list', {}],
  ['tools/call', { name: 'whatsapp_status', arguments: {} }],
]) {
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  assert.equal(response.status, 200);
  const body = await response.json(); assert.ok(body.result); assert.ok(!body.error);
  console.log(`${method}: PASS`);
}
console.log('Public MCP authentication and protocol: PASS');
