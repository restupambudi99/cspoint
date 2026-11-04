import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAiConfig, createRouterClient, buildAiMessages } from './ai.mjs';
import { createAutoReply } from './auto-reply.mjs';
import { openMessages } from './messages.mjs';
import { openStore } from './store.mjs';

const folder = await mkdtemp(join(tmpdir(), 'cspoint-ai-test-'));
const path = join(folder, 'qa.sqlite');
const secret = 'test-only-server-encryption-secret';
const apiKey = 'qa-router-secret-not-for-production';
let config = openAiConfig(path, secret), calls = 0, reject = false, missingModel = false, lastPayload;
const server = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  assert.equal(req.headers.authorization, `Bearer ${apiKey}`);
  if (missingModel) { res.writeHead(404); res.end(JSON.stringify({ error: `No active credentials: ${apiKey}` })); return; }
  if (reject) { res.writeHead(401); res.end(JSON.stringify({ error: `Secret ${apiKey}` })); return; }
  if (req.url === '/v1/models') { res.end(JSON.stringify({ data: [{ id: 'Fallback' }] })); return; }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  lastPayload = JSON.parse(raw);
  calls++;
  res.end(JSON.stringify({ choices: [{ message: { content: 'Halo, saya CSPoint. Ada yang bisa dibantu?' } }] }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let router = createRouterClient(config, { baseUrl: `http://127.0.0.1:${server.address().port}/v1` });
const store = openStore(':memory:'), messages = openMessages(':memory:');
store.saveSettings({ shippingPdfName: 'Tarif ongkir.pdf', shippingPdfText: 'Bubon / Aceh Barat → Rp40.000' });
assert.match(store.knowledge.relevant('Berapa ongkir ke Kecamatan Bubon?')[0].content, /Bubon \/ Aceh Barat → Rp40\.000/);
try {
  assert.equal(config.publicConfig().hasApiKey, false);
  assert.equal(config.publicConfig().model, 'Hermesollama');
  assert.throws(() => config.credentials(), /terlebih dahulu/);
  const saved = config.save({ model: 'Fallback', apiKey });
  assert.equal(saved.hasApiKey, true);
  assert.equal(JSON.stringify(saved).includes(apiKey), false);
  config.save({ model: 'Fallback', apiKey: '' });
  assert.equal(config.credentials().apiKey, apiKey, 'empty password preserves the stored key');
  config.close();
  assert.equal((await readFile(path)).includes(Buffer.from(apiKey)), false, 'database must not contain plaintext API key');
  config = openAiConfig(path, secret);
  router = createRouterClient(config, { baseUrl: `http://127.0.0.1:${server.address().port}/v1` });
  assert.equal(config.credentials().apiKey, apiKey, 'encrypted key survives restart');
  assert.throws(() => config.save({ apiKey: 'bad\nkey' }), /tidak valid/);
  assert.throws(() => config.save({ model: '' }), /tidak valid/);

  assert.deepEqual(await router.models(), ['Fallback']);
  const prompt = buildAiMessages({ assistantName: 'CSPoint', instructions: 'Jawab ramah.' }, [{ text: 'Halo', outgoing: false }]);
  assert.match(await router.complete(prompt), /CSPoint/);
  assert.equal(lastPayload.model, 'Fallback');
  assert.equal(lastPayload.messages[0].role, 'system');
  assert.equal(lastPayload.messages.at(-1).role, 'user');
  reject = true;
  await assert.rejects(router.complete(prompt), error => error.status === 502 && !error.message.includes(apiKey));
  reject = false;
  missingModel = true;
  await assert.rejects(router.complete(prompt), error => error.status === 422 && /Model\/combo/.test(error.message) && !error.message.includes(apiKey));
  missingModel = false;

  let sent = [], current = true;
  const simulatedNow = new Date('2026-11-04T10:00:00+07:00');
  const onError = error => { throw error; };
  const reads = [];
  const connection = { isCurrent: () => current, markRead: async message => { reads.push(message.id); }, send: async (jid, payload) => { sent.push({ jid, ...payload }); return { key: { id: `out-${sent.length}` } }; } };
  const inbound = { id: 'in-1', jid: '628123450000@s.whatsapp.net', text: 'Berapa ongkir ke Kecamatan Bubon?', outgoing: false, timestamp: simulatedNow.getTime() };
  assert.equal(messages.add(inbound), true);
  assert.equal(messages.add(inbound), false, 'duplicate WhatsApp delivery is recognized');
  const delays = [];
  const reply = createAutoReply({ store, config, router, messages, buildMessages: buildAiMessages, onError, sleep: async ms => { delays.push(ms); }, now: () => simulatedNow });
  await reply(inbound, connection);
  assert.equal(sent.length, 0, 'disabled agent must not send');
  store.saveAgent({ enabled: true });
  await reply(inbound, connection);
  assert.equal(sent.length, 0, 'global auto-reply switch must also be on');
  assert.equal(reads.length, 0, 'disabled AI must not mark messages as read');
  store.saveSettings({ autoReply: true, dailyLimit: 1 });
  await reply(inbound, connection);
  assert.equal(sent.length, 1);
  assert.deepEqual(reads, [inbound.id], 'enabled AI acknowledges the incoming message before replying');
  assert.equal(delays.length, 0, 'first reply has no artificial interval delay');
  assert.match(lastPayload.messages[0].content, /Bubon \/ Aceh Barat → Rp40\.000/, 'shipping PDF tariff is included in the AI context');
  assert.equal(messages.thread(inbound.jid).at(-1).outgoing, 1);
  const afterReply = calls;
  await reply(inbound, connection);
  await reply({ ...inbound, id: 'in-2' }, connection);
  assert.equal(calls, afterReply, 'deduplication and daily cap prevent extra inference');
  assert.equal(sent.length, 1);
  store.saveSettings({ dailyLimit: 0 });
  current = false;
  await reply({ ...inbound, id: 'in-3' }, connection);
  assert.equal(calls, afterReply, 'stale connection must not trigger inference');
  current = true;
  const cancellingReply = createAutoReply({ store, config, router, messages, buildMessages: buildAiMessages, onError, sleep: async () => { current = false; }, now: () => simulatedNow });
  await cancellingReply({ ...inbound, id: 'in-4a' }, connection);
  const sentBeforeCancelledReply = sent.length;
  current = true;
  await cancellingReply({ ...inbound, id: 'in-4b' }, connection);
  assert.equal(sent.length, sentBeforeCancelledReply, 'disconnect during interval wait cancels the send');
  current = true;
  store.saveSettings({ scheduleEnabled: true, scheduleStart: '08:00', scheduleEnd: '09:00' });
  const scheduledReply = createAutoReply({ store, config, router, messages, buildMessages: buildAiMessages, onError, sleep: async () => {}, now: () => new Date('2026-11-04T05:00:00Z') });
  const beforeSchedule = calls;
  await scheduledReply({ ...inbound, id: 'in-5' }, connection);
  assert.equal(calls, beforeSchedule, 'outside configured Jakarta hours must not trigger inference');

  store.saveSettings({ scheduleEnabled: false, dailyLimit: 0 });
  let retryCalls = 0, retrySent = 0, retryDelay = 0;
  const retryReply = createAutoReply({
    store, config, messages, buildMessages: buildAiMessages,
    router: { complete: async () => { if (++retryCalls === 1) throw Object.assign(new Error('temporary upstream error'), { status: 502 }); return 'Tarif ditemukan.'; } },
    sleep: async ms => { retryDelay = ms; },
    onError: error => { throw error; },
    now: () => simulatedNow,
  });
  await retryReply({ ...inbound, id: 'in-6' }, { isCurrent: () => true, send: async () => { retrySent++; return { key: { id: 'out-retry' } }; } });
  assert.equal(retryCalls, 2, 'temporary router failure receives one retry');
  assert.equal(retryDelay, 1000, 'retry waits briefly before contacting 9Router again');
  assert.equal(retrySent, 1, 'retry sends only one WhatsApp reply');
  console.log('PASS: encrypted key persistence/redaction, 9Router auth/models/completions, sanitized errors, auto-reply switches, history, deduplication, daily cap, reconnect cancellation and schedule');
} finally {
  config.close(); store.close(); messages.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(folder, { recursive: true, force: true });
}
