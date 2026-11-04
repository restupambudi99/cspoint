import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const token = 'test-only-gateway-9router-http-token';
const apiKey = 'test-only-9router-api-key';
let denied = false, missingModel = false;
const router = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (missingModel) { res.writeHead(404); res.end(JSON.stringify({ error: `No active credentials: ${apiKey}` })); return; }
  if (denied || req.headers.authorization !== `Bearer ${apiKey}`) {
    res.writeHead(401); res.end(JSON.stringify({ error: `never expose ${apiKey}` })); return;
  }
  if (req.url === '/v1/models') { res.end(JSON.stringify({ data: [{ id: 'Fallback' }, { id: 'qa/model' }] })); return; }
  let body = '';
  for await (const chunk of req) body += chunk;
  const input = JSON.parse(body);
  assert.equal(input.model, 'Fallback');
  assert.equal(input.messages.at(-1).content, 'Halo');
  res.end(JSON.stringify({ choices: [{ message: { content: 'Halo dari 9Router uji.' } }] }));
});
await new Promise(resolve => router.listen(0, '127.0.0.1', resolve));
const folder = await mkdtemp(join(tmpdir(), 'cspoint-ai-http-'));
const child = spawn(process.execPath, ['server.mjs'], {
  cwd: new URL('.', import.meta.url),
  env: { ...process.env, GATEWAY_TOKEN: token, PORT: '18186', MESSAGE_DB: ':memory:', SESSION_DIR: folder, NINE_ROUTER_BASE_URL: `http://127.0.0.1:${router.address().port}/v1` },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let errors = '';
child.stderr.on('data', chunk => { errors += chunk; });
try {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(errors);
    try { await fetch('http://127.0.0.1:18186/status'); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  assert.equal((await fetch('http://127.0.0.1:18186/ai/config')).status, 401);
  const request = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:18186/api/whatsapp${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  let result = await request('/ai/config');
  assert.equal(result.body.hasApiKey, false);
  assert.equal(result.body.model, 'Hermesollama');
  assert.equal(result.body.baseUrl, 'http://38.47.191.228:20128/v1');
  assert.equal((await request('/ai/test', { prompt: 'Halo' })).status, 400);
  result = await request('/ai/config', { model: 'Fallback', apiKey });
  assert.equal(result.status, 200);
  assert.equal(result.body.hasApiKey, true);
  assert.equal(JSON.stringify(result.body).includes(apiKey), false);
  assert.equal((await request('/ai/config')).body.apiKey, undefined);
  await request('/ai/config', { model: 'Fallback', apiKey: '' });
  result = await request('/ai/models');
  assert.deepEqual(result.body.models, ['Fallback', 'qa/model']);
  result = await request('/ai/test', { prompt: 'Halo' });
  assert.equal(result.status, 200);
  assert.equal(result.body.reply, 'Halo dari 9Router uji.');
  missingModel = true;
  result = await request('/ai/test', { prompt: 'Halo' });
  assert.equal(result.status, 422);
  assert.match(result.body.error, /Model\/combo/);
  assert.equal(JSON.stringify(result.body).includes(apiKey), false);
  missingModel = false;
  assert.equal((await request('/ai/test', { prompt: '' })).status, 400);
  assert.equal((await request('/ai/config', { model: 'Fallback', apiKey: 'bad\nkey' })).status, 400);
  denied = true;
  result = await request('/ai/test', { prompt: 'Halo' });
  assert.equal(result.status, 502);
  assert.equal(JSON.stringify(result.body).includes(apiKey), false);
  assert.equal((await request('/status')).body.status, 'idle', 'testing AI must not change WhatsApp connection');
  console.log('PASS: protected AI HTTP routes, config/model/test round-trip, blank-key preservation, validation, sanitized upstream auth errors and unchanged WhatsApp state');
} finally {
  if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
  router.closeAllConnections();
  await new Promise(resolve => router.close(resolve));
  await rm(folder, { recursive: true, force: true });
}
