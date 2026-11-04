import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { mcpHandler } from './mcp.mjs';
const token = 'test-mcp-0000000000000000000000000000';
const handler = mcpHandler({ token, messages: { list: () => [], thread: () => [] }, getStatus: () => 'idle' });
const server = createServer(handler);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/mcp`;
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
async function rpc(method, params = {}) {
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  assert.equal(response.status, 200); return response.json();
}
try {
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await fetch(url, { headers })).status, 405);
  const init = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result.serverInfo.name, 'chat-wa-bot');
  const tools = await rpc('tools/list');
  assert.deepEqual(tools.result.tools.map(t => t.name).sort(), ['list_conversations', 'read_messages', 'whatsapp_status']);
  const status = await rpc('tools/call', { name: 'whatsapp_status', arguments: {} });
  assert.equal(JSON.parse(status.result.content[0].text).status, 'idle');
  const invalid = await rpc('tools/call', { name: 'read_messages', arguments: { jid: '../../secret' } });
  assert.ok(invalid.result?.isError || invalid.error);
  console.log('PASS: MCP auth, initialize, tools/list, status, input validation; no write tools');
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
